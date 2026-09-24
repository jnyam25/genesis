#include "captsone_node.h"

#include <ModbusIP_ESP8266.h>
#include <Preferences.h>
#include <WiFi.h>
#include <esp_idf_version.h>
#include <esp_task_wdt.h>

namespace node {

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

std::vector<Setting> networkSettings(const char* defaultIp) {
  return {
      {"wifi_ssid", "captsone-ctl", "Wi-Fi network of the control access point"},
      {"wifi_pass", "", "Wi-Fi password (WPA2)"},
      {"ip", defaultIp, "static IP of this node (empty = DHCP)"},
      {"gateway", "192.168.10.1", "gateway (the control network has no uplink)"},
      {"subnet", "255.255.255.0", "subnet mask"},
      {"plc_ip", "192.168.10.10", "Micro850 IP (a PC running the virtual PLC for bench tests)"},
      {"plc_port", "502", "Modbus TCP port (5020 for the virtual PLC)"},
      {"unit_id", "1", "Modbus unit id"},
  };
}

void Config::begin(const char* nvsNamespace, const std::vector<Setting>& settings) {
  ns_ = nvsNamespace;
  settings_ = settings;
}

const Setting* Config::find(const String& key) const {
  for (const auto& s : settings_) {
    if (key == s.key) return &s;
  }
  return nullptr;
}

bool Config::has(const String& key) const { return find(key) != nullptr; }

String Config::get(const char* key) const {
  const Setting* s = find(key);
  if (!s) return String();
  Preferences prefs;
  prefs.begin(ns_.c_str(), true);
  String value = prefs.isKey(key) ? prefs.getString(key, s->def) : String(s->def);
  prefs.end();
  return value;
}

long Config::getInt(const char* key) const { return get(key).toInt(); }

float Config::getFloat(const char* key) const { return get(key).toFloat(); }

bool Config::set(const String& key, const String& value) {
  if (!find(key)) return false;
  Preferences prefs;
  prefs.begin(ns_.c_str(), false);
  prefs.putString(key.c_str(), value);
  prefs.end();
  return true;
}

void Config::print(Stream& out) const {
  for (const auto& s : settings_) {
    String value = get(s.key);
    if (String(s.key).endsWith("pass") && value.length()) value = "********";
    out.printf("  %-12s = %-18s  %s\n", s.key, value.c_str(), s.help);
  }
}

// ---------------------------------------------------------------------------
// PlcLink
// ---------------------------------------------------------------------------

static ModbusIP mb;
static Modbus::ResultCode lastResult = Modbus::EX_SUCCESS;

static bool onTransaction(Modbus::ResultCode event, uint16_t, void*) {
  lastResult = event;
  return true;
}

void PlcLink::begin(const Config& config, const char* hostname) {
  ssid_ = config.get("wifi_ssid");
  pass_ = config.get("wifi_pass");
  plc_.fromString(config.get("plc_ip"));
  port_ = config.getInt("plc_port");
  unit_ = config.getInt("unit_id");

  WiFi.setHostname(hostname);  // must precede WiFi.mode() on arduino-esp32 2.x
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);  // modem sleep adds 100+ ms latency spikes
  IPAddress ip, gateway, subnet;
  if (ip.fromString(config.get("ip")) && gateway.fromString(config.get("gateway")) && subnet.fromString(config.get("subnet"))) {
    WiFi.config(ip, gateway, subnet);
  }
  WiFi.begin(ssid_.c_str(), pass_.c_str());
  lastWifiAttempt_ = millis();
  mb.client();
}

void PlcLink::loop() {
  const uint32_t now = millis();
  if (WiFi.status() != WL_CONNECTED) {
    if (now - lastWifiAttempt_ > 5000) {
      WiFi.disconnect();
      WiFi.begin(ssid_.c_str(), pass_.c_str());
      lastWifiAttempt_ = now;
    }
    return;
  }
  if (!mb.isConnected(plc_) && now - lastConnectAttempt_ > 1000) {
    lastConnectAttempt_ = now;
    mb.connect(plc_, port_);
  }
  mb.task();
}

bool PlcLink::connected() { return WiFi.status() == WL_CONNECTED && mb.isConnected(plc_); }

bool PlcLink::wait(uint16_t transaction) {
  if (transaction == 0) {
    errors_++;
    return false;
  }
  const uint32_t start = millis();
  while (mb.isTransaction(transaction)) {
    mb.task();
    delay(1);
    if (millis() - start > 1500) {
      errors_++;
      return false;
    }
  }
  if (lastResult != Modbus::EX_SUCCESS) errors_++;
  return lastResult == Modbus::EX_SUCCESS;
}

bool PlcLink::read(uint16_t address, uint16_t* dst, uint16_t count) {
  if (!connected()) return false;
  lastResult = Modbus::EX_GENERAL_FAILURE;
  return wait(mb.readHreg(plc_, address, dst, count, onTransaction, unit_));
}

bool PlcLink::write(uint16_t address, uint16_t value) {
  if (!connected()) return false;
  lastResult = Modbus::EX_GENERAL_FAILURE;
  return wait(mb.writeHreg(plc_, address, value, onTransaction, unit_));
}

bool PlcLink::write(uint16_t address, const uint16_t* values, uint16_t count) {
  if (!connected()) return false;
  lastResult = Modbus::EX_GENERAL_FAILURE;
  return wait(mb.writeHreg(plc_, address, const_cast<uint16_t*>(values), count, onTransaction, unit_));
}

void PlcLink::supervise() {
  uint16_t hb;
  if (!read(reg::SYS_PLC_HEARTBEAT, &hb, 1)) return;
  if (!plcHeartbeatSeen_ || hb != plcHeartbeat_) {
    plcHeartbeat_ = hb;
    plcHeartbeatSeen_ = true;
    plcHeartbeatChangedAt_ = millis();
  }
}

bool PlcLink::plcAlive() const {
  return plcHeartbeatSeen_ && millis() - plcHeartbeatChangedAt_ < PLC_HEARTBEAT_TIMEOUT_MS;
}

void PlcLink::heartbeat(uint16_t address) {
  const uint32_t now = millis();
  if (now - ownHeartbeatAt_ < 1000) return;
  ownHeartbeatAt_ = now;
  ownHeartbeat_ = ownHeartbeat_ == 65535 ? 0 : ownHeartbeat_ + 1;
  write(address, ownHeartbeat_);
}

// ---------------------------------------------------------------------------
// Console
// ---------------------------------------------------------------------------

void Console::begin(Config* config, const char* nodeHelp, CommandHandler handler) {
  config_ = config;
  nodeHelp_ = nodeHelp;
  handler_ = handler;
}

void Console::loop() {
  while (Serial.available()) {
    const char c = Serial.read();
    if (c == '\r' || c == '\n') {
      if (line_.length()) dispatch(line_);
      line_ = "";
    } else if (line_.length() < 160) {
      line_ += c;
    }
  }
}

void Console::dispatch(String line) {
  line.trim();
  const int space = line.indexOf(' ');
  const String cmd = space < 0 ? line : line.substring(0, space);
  String args = space < 0 ? String() : line.substring(space + 1);
  args.trim();

  if (cmd == "help") {
    Serial.println("Commands:\n  show                 settings\n  set <key> <value>    change a setting (saved; most apply after reboot)\n  reboot");
    Serial.print(nodeHelp_);
  } else if (cmd == "show") {
    config_->print(Serial);
  } else if (cmd == "set") {
    const int sp = args.indexOf(' ');
    const String key = sp < 0 ? args : args.substring(0, sp);
    const String value = sp < 0 ? String() : args.substring(sp + 1);
    Serial.println(config_->set(key, value) ? "ok (reboot to apply network settings)" : "unknown key — `show` lists them");
  } else if (cmd == "reboot") {
    ESP.restart();
  } else if (!handler_ || !handler_(cmd, args, Serial)) {
    Serial.println("unknown command — `help`");
  }
}

// ---------------------------------------------------------------------------
// Watchdog
// ---------------------------------------------------------------------------

void watchdogBegin(uint32_t seconds) {
#if ESP_IDF_VERSION_MAJOR >= 5
  const esp_task_wdt_config_t cfg = {.timeout_ms = seconds * 1000, .idle_core_mask = 0, .trigger_panic = true};
  esp_task_wdt_reconfigure(&cfg);
#else
  esp_task_wdt_init(seconds, true);
#endif
  esp_task_wdt_add(nullptr);
}

void watchdogFeed() { esp_task_wdt_reset(); }

}  // namespace node
