#include "arm.h"

#include <algorithm>

namespace {
constexpr uint32_t SETTLE_MS = 100;         // after the commanded move time
constexpr uint32_t ARRIVE_GRACE_MS = 800;   // extra time for a servo to reach its target
constexpr const char* POSE_NAMES[] = {"home", "mag_above", "mag_pick", "cap_above", "cap_place", "cap_press"};
}  // namespace

const char* poseName(Pose pose) { return POSE_NAMES[uint8_t(pose)]; }

bool poseFromName(const String& name, Pose& pose) {
  for (uint8_t i = 0; i < uint8_t(Pose::COUNT); i++) {
    if (name == POSE_NAMES[i]) {
      pose = Pose(i);
      return true;
    }
  }
  return false;
}

void Arm::begin(LxBus* bus, const ArmSettings& settings) {
  bus_ = bus;
  s_ = settings;
}

uint16_t Arm::statusBits() const {
  return (homed_ ? 1 << reg::ARM_STATUS_BIT_HOMED : 0) | (busy_ ? 1 << reg::ARM_STATUS_BIT_BUSY : 0) |
         (lidHeld_ ? 1 << reg::ARM_STATUS_BIT_LID_HELD : 0);
}

bool Arm::start(uint16_t cmd) {
  if (busy_) return false;
  const uint16_t home = homed_ ? s_.moveMs : s_.slowMs;
  failure_ = reg::ARM_RESULT_NONE;
  switch (cmd) {
    case reg::ARM_CMD_HOME: {
      const Step steps[] = {{Action::POSE, Pose::HOME, home, true, 0}};
      load(steps, 1);
      break;
    }
    case reg::ARM_CMD_PICK_LID: {
      if (!homed_) return false;
      const Step steps[] = {
          {Action::POSE, Pose::MAG_ABOVE, s_.moveMs, true, 0},
          {Action::GRIP_OPEN, Pose::HOME, s_.gripMs, true, 0},
          {Action::POSE, Pose::MAG_PICK, s_.approachMs, true, 0},
          {Action::GRIP_CLOSE, Pose::HOME, s_.gripMs, false, 0},
          {Action::CHECK_LID, Pose::HOME, 0, false, reg::ARM_RESULT_NO_LID},
          {Action::POSE, Pose::MAG_ABOVE, s_.approachMs, true, 0},
          {Action::POSE, Pose::HOME, s_.moveMs, true, 0},
      };
      load(steps, 7);
      break;
    }
    case reg::ARM_CMD_PLACE_LID: {
      if (!homed_) return false;
      const Step steps[] = {
          {Action::CHECK_LID, Pose::HOME, 0, false, reg::ARM_RESULT_LID_LOST},
          {Action::POSE, Pose::CAP_ABOVE, s_.moveMs, true, 0},
          {Action::CHECK_LID, Pose::HOME, 0, false, reg::ARM_RESULT_LID_LOST},
          {Action::POSE, Pose::CAP_PLACE, s_.approachMs, true, 0},
          // Pressing stalls on the seated lid, so this move is not verified.
          {Action::POSE, Pose::CAP_PRESS, s_.pressMs, false, 0},
          {Action::GRIP_OPEN, Pose::HOME, s_.gripMs, true, 0},
          {Action::POSE, Pose::CAP_ABOVE, s_.approachMs, true, 0},
          {Action::POSE, Pose::HOME, s_.moveMs, true, 0},
      };
      load(steps, 8);
      break;
    }
    default:
      return false;
  }
  busy_ = true;
  result_ = reg::ARM_RESULT_NONE;
  begin(steps_[0]);
  return true;
}

void Arm::load(const Step* steps, uint8_t count) {
  count_ = std::min<uint8_t>(count, MAX_STEPS);
  for (uint8_t i = 0; i < count_; i++) steps_[i] = steps[i];
  index_ = 0;
}

void Arm::begin(const Step& step) {
  stepAt_ = millis();
  switch (step.action) {
    case Action::POSE:
      for (uint8_t j = 0; j < JOINTS; j++) bus_->move(j + 2, s_.poses[uint8_t(step.pose)][j], step.ms);
      break;
    case Action::GRIP_OPEN:
      bus_->move(GRIPPER_ID, s_.gripOpen, step.ms);
      break;
    case Action::GRIP_CLOSE:
      bus_->move(GRIPPER_ID, s_.gripClose, step.ms);
      break;
    case Action::CHECK_LID:
      break;
  }
}

bool Arm::holdingLid(bool& ok) {
  int16_t pos;
  ok = bus_->readPosition(GRIPPER_ID, pos);
  return ok && abs(pos - int16_t(s_.gripClose)) > s_.lidMargin;
}

/** True once the step's servos are at their targets; `failed` if they never get there. */
bool Arm::verified(const Step& step, bool& failed) {
  failed = false;
  const uint32_t age = millis() - stepAt_;
  if (age < step.ms + SETTLE_MS) return false;
  if (!step.verify) return true;
  bool arrived = true;
  int16_t pos;
  if (step.action == Action::POSE) {
    for (uint8_t j = 0; j < JOINTS && arrived; j++) {
      if (!bus_->readPosition(j + 2, pos)) {
        failed = true;
        return false;
      }
      arrived = abs(pos - int16_t(s_.poses[uint8_t(step.pose)][j])) <= s_.tolerance;
    }
  } else {
    const uint16_t target = step.action == Action::GRIP_OPEN ? s_.gripOpen : s_.gripClose;
    if (!bus_->readPosition(GRIPPER_ID, pos)) {
      failed = true;
      return false;
    }
    arrived = abs(pos - int16_t(target)) <= s_.tolerance;
  }
  if (!arrived && age > step.ms + SETTLE_MS + ARRIVE_GRACE_MS) failed = true;
  return arrived;
}

bool Arm::step(bool permit) {
  if (!busy_) return false;
  if (!permit) {
    halt();
    finish(reg::ARM_RESULT_ABORTED);
    return true;
  }
  const Step& current = steps_[index_];

  if (current.action == Action::CHECK_LID) {
    bool ok;
    const bool lid = holdingLid(ok);
    if (!ok) {
      halt();
      finish(reg::ARM_RESULT_SERVO_ERROR);
      return true;
    }
    lidHeld_ = lid;
    if (!lid) {
      // Recover to HOME with the gripper open, then report the failure.
      failure_ = current.failResult;
      const Step recovery[] = {
          {Action::GRIP_OPEN, Pose::HOME, s_.gripMs, true, 0},
          {Action::POSE, Pose::HOME, s_.moveMs, true, 0},
      };
      load(recovery, 2);
      begin(steps_[0]);
      return false;
    }
  } else {
    bool failed;
    if (!verified(current, failed)) {
      if (failed) {
        halt();
        finish(reg::ARM_RESULT_SERVO_ERROR);
        return true;
      }
      return false;
    }
    if (current.action == Action::GRIP_OPEN) lidHeld_ = false;
  }

  if (++index_ >= count_) {
    homed_ = steps_[count_ - 1].action == Action::POSE && steps_[count_ - 1].pose == Pose::HOME;
    finish(failure_ != reg::ARM_RESULT_NONE ? failure_ : reg::ARM_RESULT_OK);
    return true;
  }
  begin(steps_[index_]);
  return false;
}

void Arm::halt() {
  for (uint8_t id = 1; id <= JOINTS + 1; id++) bus_->stop(id);
  homed_ = false;
}

void Arm::finish(uint16_t result) {
  busy_ = false;
  result_ = result;
}

bool Arm::readAll(int16_t positions[JOINTS + 1]) {
  bool ok = true;
  for (uint8_t id = 1; id <= JOINTS + 1; id++) ok &= bus_->readPosition(id, positions[id - 1]);
  return ok;
}

void Arm::torque(bool on) {
  for (uint8_t id = 1; id <= JOINTS + 1; id++) bus_->torque(id, on);
  if (!on) homed_ = false;
}

void Arm::moveTo(Pose pose, uint16_t ms) {
  for (uint8_t j = 0; j < JOINTS; j++) bus_->move(j + 2, s_.poses[uint8_t(pose)][j], ms);
  homed_ = false;
}

void Arm::grip(bool close) { bus_->move(GRIPPER_ID, close ? s_.gripClose : s_.gripOpen, s_.gripMs); }

bool Arm::probe() {
  int16_t pos;
  probeMisses_[probeId_] = bus_->readPosition(probeId_, pos) ? 0 : std::min<uint8_t>(probeMisses_[probeId_] + 1, 250);
  probeId_ = probeId_ >= JOINTS + 1 ? 1 : probeId_ + 1;
  for (uint8_t id = 1; id <= JOINTS + 1; id++) {
    if (probeMisses_[id] >= 3) return false;
  }
  return true;
}
