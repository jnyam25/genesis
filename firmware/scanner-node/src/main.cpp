// ESP32 #1 scanner node: label applicator + barcode scanner.
//
// Executes two PLC requests and never interprets anything:
//   LABEL  Station.LabelRequest = id (≠ LabelDone) and RunPermit → one applicator
//          stroke → Station.LabelDone = id.
//   SCAN   Scan.Request = id (≠ Scan.Done) → trigger one read → write Scan.Status,
//          Scan.Length and the raw text, then Scan.Done = id last. The PLC
//          validates the barcode itself.
// Fault bits (Station.ScannerNodeFaults): bit0 labeler, bit1 scanner not
// answering. A fault bit reports a failed attempt; it clears after the line has
// been stopped for 2 s so the operator can RESET, and a persisting problem sets
// it again on the next attempt.

#include <Arduino.h>
#include <WiFi.h>

#include <algorithm>

#include "genesis_node.h"

using node::Config;

static Config config;
static node::PlcLink plc;
static node::Console console;

static std::vector<node::Setting> settings() {
  auto s = node::networkSettings("192.168.10.31");
  s.insert(s.end(), {
      {"scan_rx", "16", "ESP32 pin <- scanner TX (UART2)"},
      {"scan_tx", "17", "ESP32 pin -> scanner RX (UART2)"},
      {"scan_baud", "9600", "scanner baud rate"},
      {"scan_trig", "serial", "serial (GM65 command trigger) | pin | continuous"},
      {"scan_pin", "-1", "trigger output for scan_trig=pin (pulled low 30 ms)"},
      {"scan_ms", "2000", "read timeout (ms) before reporting NO_READ"},
      {"label_step", "25", "DM556Y PU- (step), through the interface transistor"},
      {"label_dir", "26", "DM556Y DR- (direction), through the interface transistor"},
      {"label_ena", "27", "DM556Y MF- (motor free). HIGH frees the motor. -1 = tied enabled"},
      {"label_steps", "400", "step pulses out, then the same number back"},
      {"label_us", "500", "microseconds between steps (min 50)"},
      {"label_sense", "-1", "label-present sensor input, active low (-1 = none)"},
      {"label_alarm", "-1", "DM556Y alarm output, active low (-1 = none)"},
  });
  return s;
}

// GM65-class modules in command-trigger mode: start one read, stop reading, and
// the 7-byte acknowledgement the module sends before the barcode.
static const uint8_t GM65_TRIGGER[] = {0x7E, 0x00, 0x08, 0x01, 0x00, 0x02, 0x01, 0xAB, 0xCD};
static const uint8_t GM65_STOP[] = {0x7E, 0x00, 0x08, 0x01, 0x00, 0x02, 0x00, 0xAB, 0xCD};
static const uint8_t GM65_ACK[] = {0x02, 0x00, 0x00, 0x01, 0x00, 0x33, 0x31};
static const uint32_t SCANNER_ACK_TIMEOUT_MS = 500;
static const uint32_t POLL_MS = 100;
static const uint32_t FAULT_CLEAR_STOPPED_MS = 2000;

enum class Trigger { SERIAL_CMD, PIN, CONTINUOUS };

static HardwareSerial& scanner = Serial2;
static Trigger trigger = Trigger::SERIAL_CMD;
static int triggerPin = -1;
static uint32_t readTimeoutMs = 2000;

static int stepPin = 25, dirPin = 26, enaPin = 27, labelSensePin = -1, alarmPin = -1;
static uint32_t strokeSteps = 400, stepIntervalUs = 500;
static bool runPermit = false;

static uint16_t faults = 0;
static uint16_t faultsWritten = 0xFFFF;
static uint32_t faultsWrittenAt = 0;
static uint32_t stoppedSince = 0;

// ---------------------------------------------------------------------------
// Scan: one read per request; the result is written until the PLC has it.
// ---------------------------------------------------------------------------

struct ScanJob {
  enum State { IDLE, READING, REPORT } state = IDLE;
  uint16_t id = 0;
  uint32_t startedAt = 0;
  size_t ackMatched = 0;
  bool ackSeen = false;
  String text;
  uint16_t status = reg::SCAN_STATUS_OK;
};
static ScanJob scan;

static void startScan(uint16_t id) {
  while (scanner.available()) scanner.read();
  scan = ScanJob();
  scan.state = ScanJob::READING;
  scan.id = id;
  scan.startedAt = millis();
  switch (trigger) {
    case Trigger::SERIAL_CMD:
      scanner.write(GM65_TRIGGER, sizeof(GM65_TRIGGER));
      break;
    case Trigger::PIN:
      if (triggerPin >= 0) {
        digitalWrite(triggerPin, LOW);
        delay(30);
        digitalWrite(triggerPin, HIGH);
      }
      break;
    case Trigger::CONTINUOUS:
      break;
  }
}

static void finishRead(uint16_t status) {
  if (trigger == Trigger::SERIAL_CMD && status != reg::SCAN_STATUS_OK) scanner.write(GM65_STOP, sizeof(GM65_STOP));
  scan.status = status;
  scan.state = ScanJob::REPORT;
}

static void stepScanRead() {
  if (scan.state != ScanJob::READING) return;
  while (scanner.available()) {
    const uint8_t b = scanner.read();
    if (trigger == Trigger::SERIAL_CMD && !scan.ackSeen) {
      if (b == GM65_ACK[scan.ackMatched]) {
        if (++scan.ackMatched == sizeof(GM65_ACK)) scan.ackSeen = true;
        continue;
      }
      scan.ackSeen = true;  // some modules skip the ack; treat the byte as data
    }
    if (b == '\r' || b == '\n') {
      if (scan.text.length()) {
        finishRead(scan.text.length() > reg::SCAN_TEXT_MAX_CHARS ? reg::SCAN_STATUS_TOO_LONG : reg::SCAN_STATUS_OK);
        return;
      }
    } else if (b >= 0x20 && b < 0x7F) {
      if (scan.text.length() <= reg::SCAN_TEXT_MAX_CHARS) scan.text += char(b);
    }
  }
  const uint32_t age = millis() - scan.startedAt;
  if (trigger == Trigger::SERIAL_CMD && !scan.ackSeen && age > SCANNER_ACK_TIMEOUT_MS) {
    faults |= 1 << reg::SCANNER_FAULT_BIT_SCANNER;
    finishRead(reg::SCAN_STATUS_NO_READ);
  } else if (age > readTimeoutMs) {
    finishRead(reg::SCAN_STATUS_NO_READ);
  }
}

/** Status, Length and Text in one write, then Done = id last. */
static bool reportScan() {
  uint16_t block[2 + reg::SCAN_TEXT_REGISTERS] = {0};
  const size_t len = scan.status == reg::SCAN_STATUS_NO_READ ? 0 : std::min<size_t>(scan.text.length(), reg::SCAN_TEXT_MAX_CHARS);
  block[0] = scan.status;
  block[1] = len;
  for (size_t i = 0; i < len; i++) {
    const uint8_t c = scan.text[i];
    block[2 + i / 2] |= (i % 2 == 0) ? (c << 8) : c;
  }
  if (!plc.write(reg::SCAN_STATUS, block, 2 + reg::SCAN_TEXT_REGISTERS)) return false;
  return plc.write(reg::SCAN_DONE, scan.id);
}

// ---------------------------------------------------------------------------
// Label applicator: DM556Y Open Loop Stepper, step/dir. One stroke is `strokeSteps` pulses out
// and the same number back. Called every loop(); the PLC poll only starts it.
// GPIO HIGH sinks the opto through the interface transistor (opto on).
// MF HIGH = coils off. A falling edge on PU- (GPIO rising) is one step.
// ---------------------------------------------------------------------------

static const uint32_t STEP_PULSE_US = 5;

struct LabelJob {
  enum State { IDLE, MOVING, REPORT } state = IDLE;
  uint16_t id = 0;
  bool returning = false;
  uint32_t stepsLeft = 0;
  uint32_t nextAt = 0;
  bool pulsed = false;
};
static LabelJob label;

static void motorFree(bool free) {
  if (enaPin >= 0) digitalWrite(enaPin, free ? HIGH : LOW);
}

static void beginHalf(bool returning) {
  label.returning = returning;
  label.stepsLeft = strokeSteps;
  label.pulsed = false;
  digitalWrite(dirPin, returning ? LOW : HIGH);
  motorFree(false);
  label.nextAt = micros() + 10;  // direction setup before the first falling edge
  label.state = LabelJob::MOVING;
}

static void stopLabel() {
  digitalWrite(stepPin, LOW);
  motorFree(true);
  label = LabelJob();
}

static void stepLabel(bool permit) {
  if (label.state != LabelJob::MOVING) return;
  if (!permit) {
    stopLabel();  // the PLC keeps the request and the stroke starts over once permitted
    return;
  }
  if (alarmPin >= 0 && digitalRead(alarmPin) == LOW) {
    faults |= 1 << reg::SCANNER_FAULT_BIT_LABELER;
    stopLabel();
    return;
  }
  const uint32_t now = micros();
  if (static_cast<int32_t>(now - label.nextAt) < 0) return;
  if (!label.pulsed) {
    digitalWrite(stepPin, HIGH);
    label.pulsed = true;
    label.nextAt = now + STEP_PULSE_US;
    return;
  }
  digitalWrite(stepPin, LOW);
  label.pulsed = false;
  if (--label.stepsLeft > 0) {
    label.nextAt = now + stepIntervalUs;
    return;
  }
  if (!label.returning) {
    beginHalf(true);
    return;
  }
  motorFree(true);
  const bool labelled = labelSensePin < 0 || digitalRead(labelSensePin) == LOW;
  if (labelled) label.state = LabelJob::REPORT;
  else {
    faults |= 1 << reg::SCANNER_FAULT_BIT_LABELER;
    label = LabelJob();
  }
}

// ---------------------------------------------------------------------------
// PLC polling
// ---------------------------------------------------------------------------

static void poll() {
  plc.supervise();

  uint16_t mailbox[2];                          // Scan.Request, Scan.Done
  uint16_t station[3];                          // RunPermit, LabelRequest, LabelDone
  if (!plc.read(reg::SCAN_REQUEST, mailbox, 2)) {
    runPermit = false;
    return;
  }
  if (!plc.read(reg::STATION_RUN_PERMIT, station, 3)) {
    runPermit = false;
    return;
  }
  const bool permit = station[0] == 1 && plc.plcAlive();
  runPermit = permit;

  // Scan: reading a barcode moves nothing, so it does not need RunPermit.
  const uint16_t scanReq = mailbox[0], scanDone = mailbox[1];
  if (scan.state != ScanJob::IDLE && scanReq != scan.id) scan = ScanJob();  // PLC withdrew the request
  if (scan.state == ScanJob::IDLE && scanReq != 0 && scanReq != scanDone) startScan(scanReq);
  if (scan.state == ScanJob::REPORT && reportScan()) {
    Serial.printf("scan %u: status %u \"%s\"\n", scan.id, scan.status, scan.text.c_str());
    scan = ScanJob();
  }

  // Label. Pulses run in loop(); this only starts a stroke and reports it.
  const uint16_t labelReq = station[1], labelDone = station[2];
  if (label.state != LabelJob::IDLE && labelReq != label.id) stopLabel();
  if (label.state == LabelJob::IDLE && permit && labelReq != 0 && labelReq != labelDone) {
    label.id = labelReq;
    beginHalf(false);
  }
  if (label.state == LabelJob::REPORT && plc.write(reg::STATION_LABEL_DONE, label.id)) label = LabelJob();

  // Fault bits
  if (station[0] == 1) stoppedSince = millis();
  else if (millis() - stoppedSince > FAULT_CLEAR_STOPPED_MS) faults = 0;
  if (faults != faultsWritten || millis() - faultsWrittenAt > 1000) {
    if (plc.write(reg::STATION_SCANNER_NODE_FAULTS, faults)) {
      faultsWritten = faults;
      faultsWrittenAt = millis();
    }
  }
}

static bool command(const String& cmd, const String& args, Stream& out) {
  if (cmd == "status") {
    out.printf("wifi %s  plc %s:%s %s  plc heartbeat %s  modbus errors %u\n", WiFi.isConnected() ? WiFi.localIP().toString().c_str() : "down",
               plc.plcIp().toString().c_str(), config.get("plc_port").c_str(), plc.connected() ? "connected" : "disconnected",
               plc.plcAlive() ? "alive" : "stale", unsigned(plc.errors()));
    out.printf("scan state %d id %u  label state %d id %u  faults 0x%02x\n", int(scan.state), scan.id, int(label.state), label.id, faults);
    return true;
  }
  if (cmd == "scan") {  // bench test: trigger one read and print it, no PLC involved
    startScan(0);
    while (scan.state == ScanJob::READING) {
      stepScanRead();
      delay(5);
      node::watchdogFeed();
    }
    out.printf("status %u \"%s\"\n", scan.status, scan.text.c_str());
    scan = ScanJob();
    return true;
  }
  if (cmd == "stroke") {  // bench test: one applicator stroke (only with the line stopped)
    uint16_t permit = 1;
    plc.read(reg::STATION_RUN_PERMIT, &permit, 1);
    if (permit) {
      out.println("refused: the line is running");
      return true;
    }
    label.id = 0;
    beginHalf(false);
    const uint32_t started = millis();
    while (label.state == LabelJob::MOVING && millis() - started < 30000) {
      stepLabel(true);
      node::watchdogFeed();
    }
    const bool done = label.state == LabelJob::REPORT;
    stopLabel();
    out.println(done ? "done" : "stopped");
    return true;
  }
  return false;
}

void setup() {
  Serial.begin(115200);
  config.begin("scanner", settings());

  const String mode = config.get("scan_trig");
  trigger = mode == "pin" ? Trigger::PIN : mode == "continuous" ? Trigger::CONTINUOUS : Trigger::SERIAL_CMD;
  triggerPin = config.getInt("scan_pin");
  readTimeoutMs = config.getInt("scan_ms");
  if (triggerPin >= 0) {
    pinMode(triggerPin, OUTPUT);
    digitalWrite(triggerPin, HIGH);
  }
  scanner.begin(config.getInt("scan_baud"), SERIAL_8N1, config.getInt("scan_rx"), config.getInt("scan_tx"));

  stepPin = config.getInt("label_step");
  dirPin = config.getInt("label_dir");
  enaPin = config.getInt("label_ena");
  strokeSteps = static_cast<uint32_t>(std::max(1L, config.getInt("label_steps")));
  stepIntervalUs = static_cast<uint32_t>(std::max(50L, config.getInt("label_us")));
  labelSensePin = config.getInt("label_sense");
  alarmPin = config.getInt("label_alarm");
  pinMode(stepPin, OUTPUT);
  pinMode(dirPin, OUTPUT);
  digitalWrite(stepPin, LOW);
  digitalWrite(dirPin, LOW);
  if (enaPin >= 0) {
    pinMode(enaPin, OUTPUT);
    motorFree(true);
  }
  if (labelSensePin >= 0) pinMode(labelSensePin, INPUT_PULLUP);
  if (alarmPin >= 0) pinMode(alarmPin, INPUT_PULLUP);

  plc.begin(config, "genesis-scanner");
  console.begin(&config, "  status               link, jobs and fault bits\n  scan                 trigger one read (bench test)\n  stroke               one applicator stroke (line stopped only)\n", command);
  node::watchdogBegin(5);
  Serial.printf("Genesis scanner node, register map v%u. `help` for commands.\n", reg::PROTOCOL_VERSION);
}

void loop() {
  static uint32_t lastPoll = 0;
  node::watchdogFeed();
  console.loop();
  plc.loop();
  stepScanRead();
  stepLabel(runPermit && plc.connected());
  if (millis() - lastPoll >= POLL_MS) {
    lastPoll = millis();
    if (plc.connected()) {
      poll();
      plc.heartbeat(reg::SCANNER_NODE_HEARTBEAT);
    } else {
      runPermit = false;
    }
  }
}
