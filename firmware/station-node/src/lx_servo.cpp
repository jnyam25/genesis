#include "lx_servo.h"

namespace {
constexpr uint8_t HEADER = 0x55;
constexpr uint8_t CMD_MOVE_TIME_WRITE = 1;
constexpr uint8_t CMD_MOVE_STOP = 12;
constexpr uint8_t CMD_POS_READ = 28;
constexpr uint8_t CMD_LOAD_OR_UNLOAD_WRITE = 31;
constexpr uint32_t REPLY_TIMEOUT_MS = 20;
}  // namespace

void LxBus::begin(HardwareSerial& serial, int rxPin, int txPin, int txEn, int rxEn, bool echo) {
  serial_ = &serial;
  txEn_ = txEn;
  rxEn_ = rxEn;
  echo_ = echo;
  if (txEn_ >= 0) pinMode(txEn_, OUTPUT);
  if (rxEn_ >= 0) pinMode(rxEn_, OUTPUT);
  serial_->begin(115200, SERIAL_8N1, rxPin, txPin);
  transmitMode(false);
}

void LxBus::transmitMode(bool tx) {
  if (txEn_ >= 0) digitalWrite(txEn_, tx ? HIGH : LOW);
  if (rxEn_ >= 0) digitalWrite(rxEn_, tx ? LOW : HIGH);
}

void LxBus::send(uint8_t id, uint8_t cmd, const uint8_t* params, uint8_t count) {
  uint8_t packet[16];
  const uint8_t len = count + 3;
  uint8_t sum = id + len + cmd;
  packet[0] = HEADER;
  packet[1] = HEADER;
  packet[2] = id;
  packet[3] = len;
  packet[4] = cmd;
  for (uint8_t i = 0; i < count; i++) {
    packet[5 + i] = params[i];
    sum += params[i];
  }
  packet[5 + count] = ~sum;
  const size_t size = 6 + count;

  while (serial_->available()) serial_->read();
  transmitMode(true);
  serial_->write(packet, size);
  serial_->flush();
  transmitMode(false);
  if (echo_) {
    const uint32_t start = millis();
    size_t discarded = 0;
    while (discarded < size && millis() - start < REPLY_TIMEOUT_MS) {
      if (serial_->available()) {
        serial_->read();
        discarded++;
      }
    }
  }
}

bool LxBus::receive(uint8_t id, uint8_t cmd, uint8_t* params, uint8_t count) {
  // Expect: 0x55 0x55 ID LEN CMD params… CHECKSUM
  uint8_t frame[16];
  const size_t size = 6 + count;
  size_t got = 0;
  const uint32_t start = millis();
  while (got < size && millis() - start < REPLY_TIMEOUT_MS) {
    if (!serial_->available()) continue;
    const uint8_t b = serial_->read();
    if (got < 2 && b != HEADER) {
      got = 0;
      continue;
    }
    frame[got++] = b;
  }
  if (got < size || frame[2] != id || frame[3] != count + 3 || frame[4] != cmd) return false;
  uint8_t sum = 0;
  for (size_t i = 2; i < size - 1; i++) sum += frame[i];
  if (uint8_t(~sum) != frame[size - 1]) return false;
  memcpy(params, frame + 5, count);
  return true;
}

void LxBus::move(uint8_t id, uint16_t position, uint16_t ms) {
  position = constrain(position, 0, 1000);
  const uint8_t p[4] = {uint8_t(position), uint8_t(position >> 8), uint8_t(ms), uint8_t(ms >> 8)};
  send(id, CMD_MOVE_TIME_WRITE, p, 4);
}

void LxBus::stop(uint8_t id) { send(id, CMD_MOVE_STOP, nullptr, 0); }

void LxBus::torque(uint8_t id, bool on) {
  const uint8_t p[1] = {uint8_t(on ? 1 : 0)};
  send(id, CMD_LOAD_OR_UNLOAD_WRITE, p, 1);
}

bool LxBus::readPosition(uint8_t id, int16_t& position) {
  send(id, CMD_POS_READ, nullptr, 0);
  uint8_t p[2];
  if (!receive(id, CMD_POS_READ, p, 2)) return false;
  position = int16_t(p[0] | (p[1] << 8));
  return true;
}
