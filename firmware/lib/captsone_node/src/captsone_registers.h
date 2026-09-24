// Captsone PLC register map for the ESP32 field nodes.
// Generated from twin/src/plc/tag-map.ts (protocol v4) by `npm run tag-map`. Do not edit by hand.
// Addresses are 0-based Modbus PDU addresses of holding registers.
#pragma once
#include <stdint.h>

namespace reg {

constexpr uint16_t PROTOCOL_VERSION = 4;

// System
constexpr uint16_t SYS_PROTOCOL_VERSION = 0;
constexpr uint16_t SYS_PLC_HEARTBEAT = 1;
constexpr uint16_t SYS_LINE_STATE = 2;

// Scan mailbox. Scan.Text holds 2 characters per register, first character in the high byte
constexpr uint16_t SCAN_REQUEST = 300;
constexpr uint16_t SCAN_DONE = 301;
constexpr uint16_t SCAN_STATUS = 302;
constexpr uint16_t SCAN_LENGTH = 303;
constexpr uint16_t SCAN_TEXT_BASE = 304;
constexpr uint16_t SCAN_PARSE_RESULT = 336;
constexpr uint16_t SCAN_RESULT_ID = 337;
constexpr uint16_t SCAN_TOTAL_ML = 338;
constexpr uint16_t SCAN_TEXT_REGISTERS = 32;
constexpr uint16_t SCAN_TEXT_MAX_CHARS = 64;

// Scan.Status values (written by the scanner node)
constexpr uint16_t SCAN_STATUS_OK = 0;
constexpr uint16_t SCAN_STATUS_NO_READ = 1;
constexpr uint16_t SCAN_STATUS_TOO_LONG = 2;

// Field node heartbeats
constexpr uint16_t TANK_NODE_HEARTBEAT = 410;
constexpr uint16_t SCANNER_NODE_HEARTBEAT = 411;
constexpr uint16_t STATION_NODE_HEARTBEAT = 412;

// Microcontroller stations
constexpr uint16_t STATION_RUN_PERMIT = 420;
constexpr uint16_t STATION_LABEL_REQUEST = 421;
constexpr uint16_t STATION_LABEL_DONE = 422;
constexpr uint16_t STATION_ARM_CMD = 423;
constexpr uint16_t STATION_ARM_CMD_SEQ = 424;
constexpr uint16_t STATION_ARM_DONE_SEQ = 425;
constexpr uint16_t STATION_ARM_RESULT = 426;
constexpr uint16_t STATION_ARM_STATUS = 427;
constexpr uint16_t STATION_SORT_REQUEST = 428;
constexpr uint16_t STATION_SORT_DONE = 429;
constexpr uint16_t STATION_SORT_HEIGHT_MM = 430;
constexpr uint16_t STATION_SCANNER_NODE_FAULTS = 431;
constexpr uint16_t STATION_STATION_NODE_FAULTS = 432;
constexpr uint16_t STATION_BLOCK_START = 420;
constexpr uint16_t STATION_BLOCK_LENGTH = 13;

// Station.ArmCmd values
constexpr uint16_t ARM_CMD_NONE = 0;
constexpr uint16_t ARM_CMD_HOME = 1;
constexpr uint16_t ARM_CMD_PICK_LID = 2;
constexpr uint16_t ARM_CMD_PLACE_LID = 3;

// Station.ArmResult values
constexpr uint16_t ARM_RESULT_NONE = 0;
constexpr uint16_t ARM_RESULT_OK = 1;
constexpr uint16_t ARM_RESULT_NO_LID = 2;
constexpr uint16_t ARM_RESULT_LID_LOST = 3;
constexpr uint16_t ARM_RESULT_SERVO_ERROR = 4;
constexpr uint16_t ARM_RESULT_ABORTED = 5;
constexpr uint16_t ARM_RESULT_REFUSED = 6;

// Station.ArmStatus bit numbers
constexpr uint16_t ARM_STATUS_BIT_HOMED = 0;
constexpr uint16_t ARM_STATUS_BIT_BUSY = 1;
constexpr uint16_t ARM_STATUS_BIT_LID_HELD = 2;

// Station.ScannerNodeFaults / Station.StationNodeFaults bit numbers
constexpr uint16_t SCANNER_FAULT_BIT_LABELER = 0;
constexpr uint16_t SCANNER_FAULT_BIT_SCANNER = 1;
constexpr uint16_t STATION_FAULT_BIT_ARM_SERVO = 0;
constexpr uint16_t STATION_FAULT_BIT_SORT_SENSOR = 1;

}  // namespace reg
