// ESP32 #2 station node: robotic arm (lifts a lid from the magazine and places
// it on the container at CAP) + sort height sensor at QC.
//
//   ARM   PLC writes Station.ArmCmd, then a new Station.ArmCmdSeq (≠ ArmDoneSeq).
//         The node runs that one command (arm.h), writes Station.ArmResult, then
//         Station.ArmDoneSeq = ArmCmdSeq. Station.ArmStatus is kept current.
//   SORT  Station.SortRequest = id (≠ SortDone) → measure the bottle height →
//         Station.SortHeightMm, then Station.SortDone = id. The PLC classifies.
// Fault bits (Station.StationNodeFaults), live while the cause lasts:
//   bit0 arm: a servo stopped answering, poses not taught yet, or teach mode on
//   bit1 sort sensor not answering

#include <Arduino.h>
#include <VL53L1X.h>
#include <WiFi.h>
#include <Wire.h>

#include <algorithm>

#include "arm.h"
#include "captsone_node.h"

static node::Config config;
static node::PlcLink plc;
static node::Console console;
static LxBus bus;
static Arm arm;
static VL53L1X tof;

static const char* UNTAUGHT = "500,500,500,500,500";
static const uint32_t POLL_MS = 50;

static std::vector<node::Setting> settings() {
  auto s = node::networkSettings("192.168.10.33");
  s.insert(s.end(), {
      {"bus_rx", "16", "servo bus UART RX pin"},
      {"bus_tx", "17", "servo bus UART TX pin"},
      {"bus_txen", "-1", "bus buffer TX-enable pin (-1 = none)"},
      {"bus_rxen", "-1", "bus buffer RX-enable pin (-1 = none)"},
      {"bus_echo", "1", "1 = TX and RX share one wire (sent bytes echo back)"},
      {"move_ms", "1000", "move time between poses (ms)"},
      {"approach_ms", "700", "move time for the last approach down (ms)"},
      {"slow_ms", "2500", "HOME move time from an unknown position (ms)"},
      {"press_ms", "600", "press-down move time (ms)"},
      {"grip_ms", "500", "gripper open/close time (ms)"},
      {"tolerance", "40", "allowed position error after a move (0-1000)"},
      {"lid_margin", "30", "gripper stops this far short of grip_close on a lid"},
      {"grip_open", "200", "gripper open position (teach: save grip_open)"},
      {"grip_close", "650", "gripper closed on NOTHING (teach: save grip_close)"},
      {"p_home", UNTAUGHT, "HOME pose, servos 2..6 (clear of belt and magazine)"},
      {"p_mag_above", UNTAUGHT, "above the lid magazine"},
      {"p_mag_pick", UNTAUGHT, "gripper around the top lid in the magazine"},
      {"p_cap_above", UNTAUGHT, "above the container at CAP"},
      {"p_cap_place", UNTAUGHT, "lid resting on the container mouth"},
      {"p_cap_press", UNTAUGHT, "a few mm lower: presses the lid on"},
      {"tof_sda", "21", "VL53L1X SDA pin"},
      {"tof_scl", "22", "VL53L1X SCL pin"},
      {"tof_mount", "300", "sensor-to-belt distance (mm)"},
      {"tof_min", "30", "heights below this are 'no bottle' (mm)"},
  });
  return s;
}

static String poseKey(Pose p) { return String("p_") + poseName(p); }

static bool parsePose(const String& text, uint16_t out[JOINTS]) {
  int from = 0;
  for (uint8_t j = 0; j < JOINTS; j++) {
    const int comma = text.indexOf(',', from);
    const String part = comma < 0 ? text.substring(from) : text.substring(from, comma);
    if (!part.length()) return false;
    out[j] = constrain(part.toInt(), 0, 1000);
    from = comma + 1;
    if (comma < 0 && j < JOINTS - 1) return false;
  }
  return true;
}

static bool posesTaught = false;

static void loadArmSettings() {
  ArmSettings s;
  posesTaught = true;
  for (uint8_t p = 0; p < uint8_t(Pose::COUNT); p++) {
    const String text = config.get(poseKey(Pose(p)).c_str());
    if (text == UNTAUGHT || !parsePose(text, s.poses[p])) {
      posesTaught = false;
      parsePose(UNTAUGHT, s.poses[p]);
    }
  }
  s.gripOpen = config.getInt("grip_open");
  s.gripClose = config.getInt("grip_close");
  s.moveMs = config.getInt("move_ms");
  s.approachMs = config.getInt("approach_ms");
  s.slowMs = config.getInt("slow_ms");
  s.pressMs = config.getInt("press_ms");
  s.gripMs = config.getInt("grip_ms");
  s.tolerance = config.getInt("tolerance");
  s.lidMargin = config.getInt("lid_margin");
  arm.settings() = s;
}

// ---------------------------------------------------------------------------
// Sort height sensor (VL53L1X looking down at the bottle at QC)
// ---------------------------------------------------------------------------

static bool tofOk = false;
static uint32_t tofLastData = 0, tofLastInit = 0;
static int tofMount = 300, tofMin = 30;

static void tofInit() {
  tofLastInit = millis();
  tof.setTimeout(100);
  tofOk = tof.init();
  if (!tofOk) return;
  tof.setDistanceMode(VL53L1X::Short);
  tof.setMeasurementTimingBudget(33000);
  tof.startContinuous(50);
  tofLastData = millis();
}

struct SortJob {
  uint16_t id = 0;
  uint32_t startedAt = 0;
  uint16_t samples[5];
  uint8_t count = 0;
  bool reporting = false;
  uint16_t heightMm = 0;
};
static SortJob sortJob;

static void stepTof() {
  if (!tofOk) {
    if (millis() - tofLastInit > 5000) tofInit();
    return;
  }
  if (!tof.dataReady()) {
    if (millis() - tofLastData > 1000) tofOk = false;
    return;
  }
  const uint16_t mm = tof.read(false);
  tofLastData = millis();
  if (sortJob.id && !sortJob.reporting && tof.ranging_data.range_status == VL53L1X::RangeValid && sortJob.count < 5) {
    sortJob.samples[sortJob.count++] = mm;
  }
}

static void stepSort() {
  if (!sortJob.id || sortJob.reporting) return;
  const bool enough = sortJob.count >= 5;
  if (!enough && millis() - sortJob.startedAt < 1000) return;
  uint16_t height = 0;
  if (sortJob.count >= 3) {
    std::sort(sortJob.samples, sortJob.samples + sortJob.count);
    const int h = tofMount - int(sortJob.samples[sortJob.count / 2]);
    if (h >= tofMin) height = h;
  }
  sortJob.heightMm = height;
  sortJob.reporting = true;
}

// ---------------------------------------------------------------------------
// PLC handshake
// ---------------------------------------------------------------------------

static bool teachMode = false;
static uint16_t runningSeq = 0;
static struct {
  bool pending = false;
  uint16_t seq = 0;
  uint16_t result = 0;
} report;
static uint16_t statusWritten = 0xFFFF, faultsWritten = 0xFFFF;
static uint32_t statusWrittenAt = 0, faultsWrittenAt = 0, lastProbe = 0;
static bool busOk = true;
static uint16_t lastPermit = 0;

static void finishCommand(uint16_t seq, uint16_t result) {
  report.pending = true;
  report.seq = seq;
  report.result = result;
  runningSeq = 0;
  Serial.printf("arm seq %u -> result %u\n", seq, result);
}

static void poll() {
  plc.supervise();
  uint16_t st[reg::STATION_BLOCK_LENGTH];
  if (!plc.read(reg::STATION_BLOCK_START, st, reg::STATION_BLOCK_LENGTH)) return;
  auto at = [&](uint16_t address) { return st[address - reg::STATION_BLOCK_START]; };
  lastPermit = at(reg::STATION_RUN_PERMIT);
  const bool permit = lastPermit == 1 && plc.plcAlive() && !teachMode;

  const uint16_t cmdSeq = at(reg::STATION_ARM_CMD_SEQ);
  uint16_t doneSeq = at(reg::STATION_ARM_DONE_SEQ);

  // Result of the last command: ArmResult first, then ArmDoneSeq.
  if (report.pending && plc.write(reg::STATION_ARM_RESULT, report.result) && plc.write(reg::STATION_ARM_DONE_SEQ, report.seq)) {
    report.pending = false;
    doneSeq = report.seq;
  }

  if (arm.busy() && cmdSeq != runningSeq) {
    arm.step(false);  // the PLC withdrew the command (PLC restart): stop, report nothing
    runningSeq = 0;
  }
  if (!arm.busy() && !report.pending && cmdSeq != 0 && cmdSeq != doneSeq) {
    const uint16_t cmd = at(reg::STATION_ARM_CMD);
    if (!permit || !posesTaught || !busOk || !arm.start(cmd)) finishCommand(cmdSeq, reg::ARM_RESULT_REFUSED);
    else runningSeq = cmdSeq;
  }
  if (arm.busy() && arm.step(permit)) finishCommand(runningSeq, arm.result());

  // Sort
  const uint16_t sortReq = at(reg::STATION_SORT_REQUEST), sortDone = at(reg::STATION_SORT_DONE);
  if (sortJob.id && sortReq != sortJob.id) sortJob = SortJob();
  if (!sortJob.id && sortReq != 0 && sortReq != sortDone) {
    sortJob.id = sortReq;
    sortJob.startedAt = millis();
  }
  stepSort();
  if (sortJob.reporting && plc.write(reg::STATION_SORT_HEIGHT_MM, sortJob.heightMm) && plc.write(reg::STATION_SORT_DONE, sortJob.id)) {
    Serial.printf("sort %u: %u mm\n", sortJob.id, sortJob.heightMm);
    sortJob = SortJob();
  }

  // Health, status and fault bits
  if (!arm.busy() && millis() - lastProbe > 500) {
    lastProbe = millis();
    busOk = arm.probe();
  }
  const uint16_t status = arm.statusBits();
  if (status != statusWritten || millis() - statusWrittenAt > 1000) {
    if (plc.write(reg::STATION_ARM_STATUS, status)) {
      statusWritten = status;
      statusWrittenAt = millis();
    }
  }
  const uint16_t faults = ((!busOk || !posesTaught || teachMode) ? 1 << reg::STATION_FAULT_BIT_ARM_SERVO : 0) |
                          (!tofOk ? 1 << reg::STATION_FAULT_BIT_SORT_SENSOR : 0);
  if (faults != faultsWritten || millis() - faultsWrittenAt > 1000) {
    if (plc.write(reg::STATION_STATION_NODE_FAULTS, faults)) {
      faultsWritten = faults;
      faultsWrittenAt = millis();
    }
  }
}

// ---------------------------------------------------------------------------
// Console: status and teaching
// ---------------------------------------------------------------------------

static const char* HELP =
    "  status               link, arm, sensor and fault state\n"
    "  teach on|off         teach mode (line must be stopped; the PLC sees an arm fault meanwhile)\n"
    "  limp | hold          servos torque off (move by hand) / on\n"
    "  pos                  print servo positions (1 = gripper, 2..6 = joints)\n"
    "  save <pose>          store the current joints as a pose: home mag_above mag_pick cap_above cap_place cap_press\n"
    "  save grip_open|grip_close   store the current gripper position\n"
    "  goto <pose>          move to a taught pose (slowly)\n"
    "  grip open|close\n"
    "  poses                list the taught poses\n"
    "  height               one sort sensor reading\n";

static bool command(const String& cmd, const String& args, Stream& out) {
  if (cmd == "status") {
    out.printf("wifi %s  plc %s %s  heartbeat %s  modbus errors %u  permit %u\n", WiFi.isConnected() ? WiFi.localIP().toString().c_str() : "down",
               plc.plcIp().toString().c_str(), plc.connected() ? "connected" : "disconnected", plc.plcAlive() ? "alive" : "stale", unsigned(plc.errors()), lastPermit);
    out.printf("arm: homed %d busy %d lid %d  poses %s  servo bus %s  teach %s\n", arm.homed(), arm.busy(), arm.lidHeld(), posesTaught ? "taught" : "NOT TAUGHT",
               busOk ? "ok" : "FAULT", teachMode ? "ON" : "off");
    out.printf("sort sensor %s\n", tofOk ? "ok" : "FAULT");
    return true;
  }
  if (cmd == "teach") {
    if (args == "on") {
      if (lastPermit == 1) {
        out.println("refused: stop the line first");
      } else {
        teachMode = true;
        out.println("teach mode ON — the arm ignores PLC commands");
      }
    } else if (args == "off") {
      teachMode = false;
      arm.torque(true);
      arm.unhome();
      loadArmSettings();
      out.printf("teach mode off; poses %s. The PLC re-homes the arm on the next start.\n", posesTaught ? "taught" : "NOT TAUGHT");
    }
    return true;
  }
  const bool teachCmd = cmd == "limp" || cmd == "hold" || cmd == "save" || cmd == "goto" || cmd == "grip";
  if (teachCmd && !teachMode) {
    out.println("refused: `teach on` first");
    return true;
  }
  if (cmd == "limp" || cmd == "hold") {
    arm.torque(cmd == "hold");
    out.println(cmd == "limp" ? "servos limp — support the arm" : "servos holding");
    return true;
  }
  if (cmd == "pos") {
    int16_t p[JOINTS + 1];
    const bool ok = arm.readAll(p);
    out.printf("gripper %d | joints %d,%d,%d,%d,%d%s\n", p[0], p[1], p[2], p[3], p[4], p[5], ok ? "" : "  (some servos did not answer)");
    return true;
  }
  if (cmd == "save") {
    int16_t p[JOINTS + 1];
    if (!arm.readAll(p)) {
      out.println("a servo did not answer — not saved");
      return true;
    }
    Pose pose;
    if (args == "grip_open" || args == "grip_close") {
      config.set(args, String(p[0]));
    } else if (poseFromName(args, pose)) {
      config.set(poseKey(pose), String(p[1]) + "," + p[2] + "," + p[3] + "," + p[4] + "," + p[5]);
    } else {
      out.println("unknown pose");
      return true;
    }
    loadArmSettings();
    out.println("saved");
    return true;
  }
  if (cmd == "goto") {
    Pose pose;
    if (!poseFromName(args, pose)) {
      out.println("unknown pose");
      return true;
    }
    arm.torque(true);
    arm.moveTo(pose, config.getInt("slow_ms"));
    out.println("moving");
    return true;
  }
  if (cmd == "grip") {
    arm.grip(args == "close");
    return true;
  }
  if (cmd == "poses") {
    for (uint8_t p = 0; p < uint8_t(Pose::COUNT); p++) out.printf("  %-10s %s\n", poseName(Pose(p)), config.get(poseKey(Pose(p)).c_str()).c_str());
    out.printf("  grip open %s  closed (empty) %s\n", config.get("grip_open").c_str(), config.get("grip_close").c_str());
    return true;
  }
  if (cmd == "height") {
    if (!tofOk) {
      out.println("sensor not answering");
      return true;
    }
    const uint16_t mm = tof.read(true);
    out.printf("distance %u mm -> height %d mm (status %u)\n", mm, tofMount - int(mm), tof.ranging_data.range_status);
    return true;
  }
  return false;
}

void setup() {
  Serial.begin(115200);
  config.begin("station", settings());

  bus.begin(Serial2, config.getInt("bus_rx"), config.getInt("bus_tx"), config.getInt("bus_txen"), config.getInt("bus_rxen"), config.getInt("bus_echo") == 1);
  arm.begin(&bus, ArmSettings());
  loadArmSettings();

  tofMount = config.getInt("tof_mount");
  tofMin = config.getInt("tof_min");
  Wire.begin(config.getInt("tof_sda"), config.getInt("tof_scl"));
  Wire.setClock(400000);
  tofInit();

  plc.begin(config, "captsone-station");
  console.begin(&config, HELP, command);
  node::watchdogBegin(5);
  Serial.printf("Captsone station node, register map v%u. Poses %s. `help` for commands.\n", reg::PROTOCOL_VERSION, posesTaught ? "taught" : "NOT TAUGHT — teach them first");
}

void loop() {
  static uint32_t lastPoll = 0;
  node::watchdogFeed();
  console.loop();
  plc.loop();
  stepTof();
  if (millis() - lastPoll >= POLL_MS) {
    lastPoll = millis();
    if (plc.connected()) {
      poll();
      plc.heartbeat(reg::STATION_NODE_HEARTBEAT);
    } else if (arm.busy()) {
      arm.step(false);  // lost the PLC: stop now; the result is reported after reconnecting
      finishCommand(runningSeq, arm.result());
    }
  }
}
