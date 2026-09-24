// Robotic arm program (Hiwonder xArm, 6 LX bus servos + gripper).
//
// Runs one PLC command at a time as a list of steps between taught poses:
//   HOME       → HOME pose (gripper unchanged)
//   PICK_LID   → above magazine, open, down to the top lid, close, check the lid
//                is in the gripper (NO_LID if it closed on nothing), up, HOME
//   PLACE_LID  → check lid, above the container at CAP, check lid (LID_LOST if
//                it fell), down onto the container, press down to seat it,
//                release, up, HOME
// Lid detection uses the gripper servo's own position: closing on a lid stalls
// it short of the taught empty-closed position.
// Every move is verified against the servo positions (SERVO_ERROR if a servo
// does not answer or does not arrive). Losing the run permit mid-move stops all
// servos where they are (ABORTED); the arm is then un-homed until the PLC sends
// HOME again. The arm never decides what to do next; the PLC does.
#pragma once

#include <Arduino.h>

#include "captsone_registers.h"
#include "lx_servo.h"

enum class Pose : uint8_t { HOME, MAG_ABOVE, MAG_PICK, CAP_ABOVE, CAP_PLACE, CAP_PRESS, COUNT };

constexpr uint8_t GRIPPER_ID = 1;
/** Joint servos: ids 2 (wrist rotate) … 6 (base). joints[j] is servo id j + 2. */
constexpr uint8_t JOINTS = 5;

const char* poseName(Pose pose);
bool poseFromName(const String& name, Pose& pose);

struct ArmSettings {
  uint16_t poses[uint8_t(Pose::COUNT)][JOINTS];
  uint16_t gripOpen = 200;
  uint16_t gripClose = 650;
  uint16_t moveMs = 1000;     // between poses
  uint16_t approachMs = 700;  // the last few cm down to the magazine / container
  uint16_t slowMs = 2500;     // HOME from an unknown position
  uint16_t pressMs = 600;     // press the lid down
  uint16_t gripMs = 500;
  uint16_t tolerance = 40;    // allowed position error after a move (0–1000 scale)
  uint16_t lidMargin = 30;    // the gripper stops at least this far short of gripClose on a lid
};

class Arm {
 public:
  void begin(LxBus* bus, const ArmSettings& settings);

  /** Start a PLC command. False = not accepted (the caller reports REFUSED). */
  bool start(uint16_t cmd);
  /** Advance the running command. Returns true once it has finished; see result(). */
  bool step(bool permit);
  /** Stop every servo where it is and forget the home position. */
  void halt();

  uint16_t result() const { return result_; }
  bool busy() const { return busy_; }
  bool homed() const { return homed_; }
  bool lidHeld() const { return lidHeld_; }
  uint16_t statusBits() const;
  void unhome() { homed_ = false; }

  // Maintenance (teach mode only)
  bool readAll(int16_t positions[JOINTS + 1]);  // [0] = gripper
  void torque(bool on);
  void moveTo(Pose pose, uint16_t ms);
  void grip(bool close);
  ArmSettings& settings() { return s_; }
  /** One servo per call, round robin; true while every servo keeps answering. */
  bool probe();

 private:
  enum class Action : uint8_t { POSE, GRIP_OPEN, GRIP_CLOSE, CHECK_LID };
  struct Step {
    Action action;
    Pose pose;
    uint16_t ms;
    bool verify;
    uint16_t failResult;  // CHECK_LID: result when no lid is held
  };
  static constexpr uint8_t MAX_STEPS = 10;

  void load(const Step* steps, uint8_t count);
  void begin(const Step& step);
  bool verified(const Step& step, bool& failed);
  bool holdingLid(bool& ok);
  void finish(uint16_t result);

  LxBus* bus_ = nullptr;
  ArmSettings s_;
  Step steps_[MAX_STEPS];
  uint8_t count_ = 0, index_ = 0;
  uint32_t stepAt_ = 0;
  bool busy_ = false, homed_ = false, lidHeld_ = false;
  uint16_t result_ = reg::ARM_RESULT_NONE;
  uint16_t failure_ = reg::ARM_RESULT_NONE;  // set when a recovery sequence is running
  uint8_t probeId_ = 1;
  uint8_t probeMisses_[JOINTS + 2] = {0};
};
