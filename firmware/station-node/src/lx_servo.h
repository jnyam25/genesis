// Hiwonder / LewanSoul LX bus servos (the xArm's servos) on a half-duplex UART.
//
// Packet: 0x55 0x55 ID LEN CMD params… CHECKSUM, LEN = params + 3,
// CHECKSUM = ~(ID + LEN + CMD + params) & 0xFF. Positions are 0–1000 (0–240°).
#pragma once

#include <Arduino.h>

class LxBus {
 public:
  /**
   * @param txEn / rxEn  direction pins of the board's bus buffer (-1 = none)
   * @param echo         TX and RX share one wire, so every sent byte comes back
   */
  void begin(HardwareSerial& serial, int rxPin, int txPin, int txEn, int rxEn, bool echo);

  /** Move to `position` in `ms`. */
  void move(uint8_t id, uint16_t position, uint16_t ms);
  /** Stop immediately where it is. */
  void stop(uint8_t id);
  /** Torque on (hold) or off (limp, can be moved by hand). */
  void torque(uint8_t id, bool on);
  bool readPosition(uint8_t id, int16_t& position);

 private:
  void send(uint8_t id, uint8_t cmd, const uint8_t* params, uint8_t count);
  bool receive(uint8_t id, uint8_t cmd, uint8_t* params, uint8_t count);
  void transmitMode(bool tx);

  HardwareSerial* serial_ = nullptr;
  int txEn_ = -1, rxEn_ = -1;
  bool echo_ = false;
};
