// Shared runtime for the Captsone ESP32 field nodes.
//
// Every node is a Modbus TCP client of the Micro850 PLC. The PLC makes every
// line decision; a node executes one request at a time and reports back.
// Actuators may move only while the PLC grants Station.RunPermit AND its
// heartbeat (Sys.PlcHeartbeat, +1 every 100 ms) keeps changing. None of this
// is a safety function: actuator power comes through the safety relay.
#pragma once

#include <Arduino.h>
#include <IPAddress.h>

#include <functional>
#include <vector>

#include "captsone_registers.h"

namespace node {

// ---------------------------------------------------------------------------
// Settings stored in NVS, edited over the serial console (`set key value`).
// ---------------------------------------------------------------------------

struct Setting {
  const char* key;  // NVS key, at most 15 characters
  const char* def;
  const char* help;
};

/** Wi-Fi / PLC settings common to every node. */
std::vector<Setting> networkSettings(const char* defaultIp);

class Config {
 public:
  void begin(const char* nvsNamespace, const std::vector<Setting>& settings);
  String get(const char* key) const;
  long getInt(const char* key) const;
  float getFloat(const char* key) const;
  bool set(const String& key, const String& value);
  bool has(const String& key) const;
  void print(Stream& out) const;

 private:
  const Setting* find(const String& key) const;
  String ns_;
  std::vector<Setting> settings_;
};

// ---------------------------------------------------------------------------
// Link to the PLC: Wi-Fi, one persistent Modbus TCP connection, synchronous
// register access with bounded timeouts, and PLC supervision.
// ---------------------------------------------------------------------------

class PlcLink {
 public:
  void begin(const Config& config, const char* hostname);
  /** Keep Wi-Fi and the Modbus connection up. Call every loop. */
  void loop();

  bool connected();
  bool read(uint16_t address, uint16_t* dst, uint16_t count);
  bool write(uint16_t address, uint16_t value);
  bool write(uint16_t address, const uint16_t* values, uint16_t count);

  /** Read Sys.PlcHeartbeat and remember when it last changed. Call every poll. */
  void supervise();
  /** The PLC heartbeat changed within the last second. */
  bool plcAlive() const;
  /** Increment and write this node's heartbeat register once per second. */
  void heartbeat(uint16_t address);

  uint32_t errors() const { return errors_; }
  IPAddress plcIp() const { return plc_; }

 private:
  bool wait(uint16_t transaction);
  IPAddress plc_;
  uint16_t port_ = 502;
  uint8_t unit_ = 1;
  uint32_t lastConnectAttempt_ = 0;
  uint32_t lastWifiAttempt_ = 0;
  uint16_t plcHeartbeat_ = 0;
  bool plcHeartbeatSeen_ = false;
  uint32_t plcHeartbeatChangedAt_ = 0;
  uint16_t ownHeartbeat_ = 0;
  uint32_t ownHeartbeatAt_ = 0;
  uint32_t errors_ = 0;
  String ssid_, pass_;
};

/** Heartbeat age after which the PLC is treated as stopped (it increments every 100 ms). */
constexpr uint32_t PLC_HEARTBEAT_TIMEOUT_MS = 1000;

// ---------------------------------------------------------------------------
// Serial console: `help`, `show`, `set <key> <value>`, `reboot`, plus the
// node's own commands.
// ---------------------------------------------------------------------------

/** Return true if the command was handled. */
using CommandHandler = std::function<bool(const String& cmd, const String& args, Stream& out)>;

class Console {
 public:
  void begin(Config* config, const char* nodeHelp, CommandHandler handler);
  void loop();

 private:
  void dispatch(String line);
  Config* config_ = nullptr;
  const char* nodeHelp_ = "";
  CommandHandler handler_;
  String line_;
};

// ---------------------------------------------------------------------------
// Task watchdog: reboot if loop() stalls for `seconds`.
// ---------------------------------------------------------------------------

void watchdogBegin(uint32_t seconds);
void watchdogFeed();

}  // namespace node
