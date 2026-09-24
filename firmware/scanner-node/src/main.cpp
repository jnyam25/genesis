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
#include <ESP32Servo.h>
#include <WiFi.h>

#include <algorithm>

#include "captsone_node.h"

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
      {"label_pin", "25", "applicator servo signal pin"},
      {"label_rest", "10", "servo angle at rest (deg)"},
      {"label_apply", "120", "servo angle at the end of the stroke (deg)"},
      {"label_ms", "600", "time for each half of the stroke (ms)"},
      {"label_sense", "-1", "label-present sensor input, active low (-1 = none)"},
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

static Servo applicator;
static int labelRest = 10, labelApply = 120, labelSensePin = -1;
static uint32_t labelHalfMs = 600;

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
// Label applicator: rest → apply → rest, only while permitted.
// ---------------------------------------------------------------------------

struct LabelJob {
  enum State { IDLE, APPLYING, RETURNING, REPORT } state = IDLE;
  uint16_t id = 0;
  uint32_t phaseAt = 0;
};
static LabelJob label;

static void stepLabel(bool permit) {
  if (label.state == LabelJob::IDLE || label.state == LabelJob::REPORT) return;
  if (!permit) {
    applicator.write(labelRest);  // stop the stroke; the PLC re-requests once permitted again
    label = LabelJob();
    return;
  }
  if (millis() - label.phaseAt < labelHalfMs) return;
  if (label.state == LabelJob::APPLYING) {
    applicator.write(labelRest);
    label.state = LabelJob::RETURNING;
    label.phaseAt = millis();
  } else {
    const bool labelled = labelSensePin < 0 || digitalRead(labelSensePin) == LOW;
    if (labelled) {
      label.state = LabelJob::REPORT;
    } else {
      faults |= 1 << reg::SCANNER_FAULT_BIT_LABELER;
      label = LabelJob();
    }
  }
}

// ---------------------------------------------------------------------------
// PLC polling
// ---------------------------------------------------------------------------

static void poll() {
  plc.supervise();

  uint16_t mailbox[2];                          // Scan.Request, Scan.Done
  uint16_t station[3];                          // RunPermit, LabelRequest, LabelDone
  if (!plc.read(reg::SCAN_REQUEST, mailbox, 2)) return;
  if (!plc.read(reg::STATION_RUN_PERMIT, station, 3)) return;
  const bool permit = station[0] == 1 && plc.plcAlive();

  // Scan: reading a barcode moves nothing, so it does not need RunPermit.
  const uint16_t scanReq = mailbox[0], scanDone = mailbox[1];
  if (scan.state != ScanJob::IDLE && scanReq != scan.id) scan = ScanJob();  // PLC withdrew the request
  if (scan.state == ScanJob::IDLE && scanReq != 0 && scanReq != scanDone) startScan(scanReq);
  if (scan.state == ScanJob::REPORT && reportScan()) {
    Serial.printf("scan %u: status %u \"%s\"\n", scan.id, scan.status, scan.text.c_str());
    scan = ScanJob();
  }

  // Label
  const uint16_t labelReq = station[1], labelDone = station[2];
  if (label.state != LabelJob::IDLE && labelReq != label.id) {
    applicator.write(labelRest);
    label = LabelJob();
  }
  if (label.state == LabelJob::IDLE && permit && labelReq != 0 && labelReq != labelDone) {
    label.id = labelReq;
    label.state = LabelJob::APPLYING;
    label.phaseAt = millis();
    applicator.write(labelApply);
  }
  stepLabel(permit);
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
    applicator.write(labelApply);
    delay(labelHalfMs);
    applicator.write(labelRest);
    out.println("done");
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

  labelRest = config.getInt("label_rest");
  labelApply = config.getInt("label_apply");
  labelHalfMs = config.getInt("label_ms");
  labelSensePin = config.getInt("label_sense");
  if (labelSensePin >= 0) pinMode(labelSensePin, INPUT_PULLUP);
  applicator.attach(config.getInt("label_pin"));
  applicator.write(labelRest);

  plc.begin(config, "captsone-scanner");
  console.begin(&config, "  status               link, jobs and fault bits\n  scan                 trigger one read (bench test)\n  stroke               one applicator stroke (line stopped only)\n", command);
  node::watchdogBegin(5);
  Serial.printf("Captsone scanner node, register map v%u. `help` for commands.\n", reg::PROTOCOL_VERSION);
}

void loop() {
  static uint32_t lastPoll = 0;
  node::watchdogFeed();
  console.loop();
  plc.loop();
  stepScanRead();
  if (millis() - lastPoll >= POLL_MS) {
    lastPoll = millis();
    if (plc.connected()) {
      poll();
      plc.heartbeat(reg::SCANNER_NODE_HEARTBEAT);
    } else {
      stepLabel(false);
    }
  }
}
