// Global variables the S00/S03/S04/S05/S07 programs need, beyond what Prog1 and the MB_* arrays already declare.
// [name, type, initial, program(s), note]
export const NEW_VARS = [
  // constants
  ["MaxConcurrent", "UINT", 4, "const", "Containers on the belt at once"],
  ["ScannerNodeFitted", "BOOL", true, "const", "FALSE on a bench without ESP32 #1"],
  ["StationNodeFitted", "BOOL", true, "const", "FALSE on a bench without ESP32 #2"],
  ["SmallBottleMaxMl", "UINT", 250, "const", "Total at or below → lane 1"],
  ["HeightLaneAMm", "UINT", 120, "const", ""],
  ["HeightLaneBMm", "UINT", 180, "const", ""],
  ["HeightToleranceMm", "UINT", 15, "const", ""],
  ["TankCapacityMl", "UINT", 5000, "const", "Both tanks"],
  ["TankRefillThresholdMl", "UINT", 800, "const", ""],
  ["TankRateMlPerS_x10", "UINT", 250, "const", "25.0 ml/s. Must not be 0"],
  ["TankValveOpeningPct", "UINT", 80, "const", ""],
  ["AoFullScale", "INT", 0, "S05", "Raw count at 100% from the slot-2 OF2 page. 0 holds the valve channels at 0"],
  // shared state
  ["Tick", "BOOL", false, "S00", "One scan every 100 ms"],
  ["NowDs", "UDINT", 0, "S00", "0.1 s since power-up"],
  ["DownDs", "UDINT", 0, "S05", "0.1 s stopped or blocked (OEE)"],
  ["TON_Clock", "TON", null, "S00", "Runs 24 h, read through ET"], ["ClockDays", "UDINT", 0, "S00", ""], ["ClockDs", "UDINT", 0, "S00", ""],
  ["TON_Pres1", "TON", null, "S00", "One per presence input"],
  ["TON_Pres2", "TON", null, "S00", ""], ["TON_Pres3", "TON", null, "S00", ""], ["TON_Pres4", "TON", null, "S00", ""],
  ["TON_Pres5", "TON", null, "S00", ""], ["TON_Pres6", "TON", null, "S00", ""], ["TON_Pres7", "TON", null, "S00", ""],
  ["TON_Pres8", "TON", null, "S00", ""],
  ["Pres", "ARRAY[1..8] OF BOOL", false, "S00", "Debounced presence, by station"],
  ["StArmed", "ARRAY[1..8] OF BOOL", true, "S00/S05", "Eye has read 0 since its last arrival"],
  ["FirePulse", "BOOL", false, "S00", "Cmd.FirePusher, authorized"],
  ["SimCircuitOk", "BOOL", false, "S00", "Simulated safety relay while SimInputs is on"],
  ["NewMask", "UINT", 0, "S00", ""],
  ["Want", "BOOL", false, "S00", ""],
  ["NEnabled", "UINT", 0, "S00", ""],
  ["TankEnabled", "ARRAY[1..2] OF BOOL", true, "S00", ""],
  ["TankEnableMaskCopy", "UINT", 3, "S00", ""],
  ["TankLevelMl_x10", "ARRAY[1..2] OF UDINT", 50000, "S00/S05", ""],
  ["TankRefilled", "ARRAY[1..2] OF BOOL", false, "panel", "Operator: tank k refilled (one scan)"],
  ["TankLowAny", "ARRAY[1..2] OF BOOL", false, "S00", "Float or estimate below threshold"],
  ["TankLowPrev", "ARRAY[1..2] OF BOOL", false, "S00", ""],
  ["EvQCode", "ARRAY[0..15] OF UINT", 0, "all", "Events raised this scan"],
  ["EvQArg1", "ARRAY[0..15] OF UINT", 0, "all", ""],
  ["EvQArg2", "ARRAY[0..15] OF UINT", 0, "all", ""],
  ["EvQCount", "UINT", 0, "all", ""],
  // containers
  ["ContId", "ARRAY[0..7] OF UINT", 0, "S03/S05", ""],
  ["ContState", "ARRAY[0..7] OF UINT", 0, "S03/S05", "0 free, 1 serving, 2 moving, 3 blocked, 10 accepted, 11 rejected, 12 jammed"],
  ["ContSt", "ARRAY[0..7] OF UINT", 0, "S03/S05", "Station 1..8"],
  ["ContTimerDs", "ARRAY[0..7] OF UINT", 0, "S05", ""],
  ["ContTransitDs", "ARRAY[0..7] OF UINT", 0, "S05", ""],
  ["ContFill_x10", "ARRAY[0..7] OF UINT", 0, "S05", ""],
  ["ContTarget_x10", "ARRAY[0..7] OF UINT", 0, "S05", ""],
  ["ContLane", "ARRAY[0..7] OF UINT", 0, "S05", ""],
  ["ContVol1", "ARRAY[0..7] OF UINT", 0, "S05", ""],
  ["ContVol2", "ARRAY[0..7] OF UINT", 0, "S05", ""],
  ["ContReject", "ARRAY[0..7] OF UINT", 0, "S05", ""],
  ["ContScanRejected", "ARRAY[0..7] OF BOOL", false, "S05", ""],
  ["ContDoneDs", "ARRAY[0..7] OF UDINT", 0, "S05", ""],
  ["StOccId", "ARRAY[1..8] OF UINT", 0, "S03/S05", "Container id at each station"],
  ["StHeldId", "ARRAY[1..8] OF UINT", 0, "S05", ""],
  ["StAwaited", "ARRAY[1..8] OF BOOL", false, "S05", ""],
  ["NextContId", "UINT", 1, "S03", ""],
  ["ActiveContainers", "UINT", 0, "S03/S05", ""],
  ["ScanPrev", "BOOL", false, "S03", ""],
  ["ScanStuckDs", "UINT", 0, "S03", ""],
  ["Stuck", "BOOL", false, "S03", ""],
  ["TrackedAtScan", "BOOL", false, "S03", ""],
  ["TanksOk", "BOOL", false, "S03", ""],
  ["Free", "INT", 0, "S03", ""],
  ["s", "INT", 0, "S03/S05/S07", ""],
  ["n", "INT", 0, "S05/S07", ""],
  ["qi", "INT", 0, "S07", ""],
  ["b", "INT", 0, "S07", ""],
  ["Ord", "ARRAY[0..7] OF INT", 0, "S05", ""],
  ["NOrd", "INT", 0, "S05", ""],
  ["Target", "INT", 0, "S05", ""],
  ["St", "UINT", 0, "S05", ""],
  ["NextSt", "UINT", 0, "S05", ""],
  ["Done", "BOOL", false, "S05", ""],
  ["Act", "UINT", 0, "S05", ""],
  ["Fin", "UINT", 0, "S05", ""],
  ["FinReason", "UINT", 0, "S05", ""],
  ["T", "UINT", 0, "S05", ""],
  ["BayVol", "UINT", 0, "S05", ""],
  ["OpenDs", "UDINT", 0, "S05", ""],
  ["Amt", "UDINT", 0, "S05", ""],
  ["Dev", "UINT", 0, "S05", ""], ["FillTol", "UINT", 0, "S05", ""],
  ["AnyBlocked", "BOOL", false, "S05", ""],
  ["QrPulseDs", "UINT", 0, "S05", ""], ["QrGapDs", "UINT", 0, "S05", ""], ["RejGapDs", "UINT", 0, "S05", ""], ["QrPending", "BOOL", false, "S05", ""], ["RejPending", "BOOL", false, "S05", ""], ["QrFire", "BOOL", false, "S05", ""], ["RejFire", "BOOL", false, "S05", ""], ["MovesOn", "BOOL", false, "S05", ""],
  ["RejPulseDs", "UINT", 0, "S05", ""],
  ["LaneBCmdNext", "BOOL", false, "S05", ""],
  ["LaneBSeen", "BOOL", false, "S05", ""],
  ["StopHeldPrev", "ARRAY[1..7] OF UINT", 0, "S05", ""],
  ["StopReleaseDs", "ARRAY[1..7] OF UINT", 0, "S05", ""],
  ["StopRel", "ARRAY[1..7] OF BOOL", false, "S05", ""],
  ["CountAccepted", "UINT", 0, "S05", ""], ["CountRejected", "UINT", 0, "S05", ""], ["CountTotal", "UINT", 0, "S05", ""],
  ["LaneACount", "UINT", 0, "S05", ""], ["LaneBCount", "UINT", 0, "S05", ""],
  ["AccDs", "ARRAY[0..63] OF UDINT", 0, "S05/S07", "Accept times, throughput window"],
  ["AccHead", "UINT", 0, "S05", ""], ["AccN", "UINT", 0, "S05", ""],
  // S04
  ["FaultLatched", "ARRAY[1..8] OF BOOL", false, "S04", ""],
  ["FaultReq", "ARRAY[1..8] OF BOOL", false, "S04", ""],
  ["FaultCode", "UINT", 0, "S04", ""], ["FaultCount", "UINT", 0, "S04", ""],
  ["FaultAny", "BOOL", false, "S04", ""], ["LineStopSent", "BOOL", false, "S04", ""],
  ["Code", "INT", 0, "S04/S05", ""], ["StCode", "INT", 0, "S04", ""],
  ["NodeHbLast1", "UINT", 0, "S04", ""], ["NodeHbLast2", "UINT", 0, "S04", ""],
  ["NodeHbSeen1", "BOOL", false, "S04", ""], ["NodeHbSeen2", "BOOL", false, "S04", ""],
  ["NodeHbRestart", "BOOL", false, "S04", ""], ["HbSame1", "BOOL", false, "S04", ""], ["HbSame2", "BOOL", false, "S04", ""],
  ["TON_ScanNodeHb", "TON", null, "S04", ""], ["TON_StationNodeHb", "TON", null, "S04", ""],
  ["ArmSeq", "UINT", 0, "S04", ""], ["ArmPendingCmd", "UINT", 0, "S04", ""], ["ArmPendingTarget", "UINT", 0, "S04", ""],
  ["ArmPickFailures", "UINT", 0, "S04", ""], ["ArmFault", "UINT", 0, "S04", ""], ["ArmIssue", "UINT", 0, "S04", ""],
  ["ArmIssueTarget", "UINT", 0, "S04", ""],
  ["ArmPending", "BOOL", false, "S04", ""], ["ArmNeedHome", "BOOL", true, "S04", ""], ["ArmPlacing", "BOOL", false, "S04", ""],
  ["ArmHomed", "BOOL", false, "S04", ""], ["ArmLidHeld", "BOOL", false, "S04", ""],
  ["CapOutcomeId", "UINT", 0, "S04/S05", ""], ["CapOutcome", "UINT", 0, "S04/S05", "1 capped, 2 failed"],
  ["ScanHeldId", "UINT", 0, "S03/S05", ""], ["CapHeldId", "UINT", 0, "S05", ""], ["QcHeldId", "UINT", 0, "S05", ""],
  ["ScanReady", "BOOL", false, "S04", ""], ["SortReady", "BOOL", false, "S04", ""],
  ["ScanReadyId", "UINT", 0, "S04", ""], ["ScanParseResult", "UINT", 0, "S04", ""], ["ScanTotalMl", "UINT", 0, "S04", ""],
  ["ScanLane", "UINT", 0, "S04", ""], ["SortReadyId", "UINT", 0, "S04", ""],
  ["ScanVolMl", "ARRAY[1..2] OF UINT", 0, "S04", ""], ["SortMeasuredLane", "INT", 0, "S04", "-1 unknown"],
  ["i", "INT", 0, "S04/S05/S07", ""], ["j", "INT", 0, "S04/S05", ""], ["k", "INT", 0, "all", ""],
  ["Len", "INT", 0, "S04", ""], ["First", "INT", 0, "S04", ""], ["Last", "INT", 0, "S04", ""], ["NF", "INT", 0, "S04", ""],
  ["Digits", "INT", 0, "S04", ""], ["NVol", "INT", 0, "S04", ""], ["TankCount", "INT", 0, "S04", ""], ["Result", "INT", 0, "S04", ""],
  ["H", "INT", 0, "S04", ""], ["OffA", "INT", 0, "S04", ""], ["OffB", "INT", 0, "S04", ""], ["Tol", "UINT", 0, "S04/S05", ""],
  ["Ch", "ARRAY[0..65] OF USINT", 0, "S04", ""], ["FS", "ARRAY[1..5] OF INT", 0, "S04", ""], ["FE", "ARRAY[1..5] OF INT", 0, "S04", ""],
  ["Vol", "ARRAY[0..7] OF UINT", 0, "S04", ""],
  ["Acc", "UDINT", 0, "S04", ""], ["Total", "UDINT", 0, "S04", ""], ["Sum", "UDINT", 0, "S04", ""],
  ["Neg", "BOOL", false, "S04", ""], ["AnyNeg", "BOOL", false, "S04", ""], ["Gap", "BOOL", false, "S04", ""],
  // S07
  ["EvSeq", "UINT", 0, "S07", ""],
  ["PrevDigital", "BOOL", false, "S07", ""], ["PrevEntry", "BOOL", false, "S07", ""], ["PrevExit", "BOOL", false, "S07", ""],
  ["PrevLocal", "BOOL", false, "S07", ""], ["PrevRunCmd", "BOOL", false, "S07", ""], ["PrevSafetyOK", "BOOL", false, "S07", ""],
  ["PrevJogBelt", "BOOL", false, "S07", ""], ["BNow", "BOOL", false, "S07", ""], ["BWas", "BOOL", false, "S07", ""],
  ["HmiHbLast", "UINT", 0, "S07", ""], ["HmiSame", "BOOL", false, "S07", ""], ["TON_HmiLink", "TON", null, "S07", ""],
  ["HmiLinkOk", "BOOL", false, "S07", ""], ["Bit4", "BOOL", false, "S07", ""],
  ["NTanks", "UINT", 0, "S07", ""], ["NRecent", "UINT", 0, "S07", ""],
  ["SpanS", "REAL", 0, "S07", ""], ["Rv", "REAL", 0, "S07", ""], ["ElapsedS", "REAL", 0, "S07", ""], ["DownS", "REAL", 0, "S07", ""],
  ["RateMlS", "REAL", 0, "S07", ""], ["IdealS", "REAL", 0, "S07", ""], ["Avail", "REAL", 0, "S07", ""], ["OperS", "REAL", 0, "S07", ""],
  ["Perf", "REAL", 0, "S07", ""], ["Qual", "REAL", 0, "S07", ""], ["Overall", "REAL", 0, "S07", ""],
  ["Flags", "UINT", 0, "S07", ""], ["Row", "INT", 0, "S07", ""], ["Pass", "INT", 0, "S07", ""], ["LastId", "UINT", 0, "S07", ""],
  ["Pick", "INT", 0, "S07", ""], ["Status", "UINT", 0, "S07", ""],
  ["AoOut", "INT", 0, "S05", "Valve angle raw count this scan"],
];

// Already in the CCW project (Prog1 and the MB_* arrays).
export function prog1Vars(prog1Text) {
  const out = [];
  const uint = new Set(["HB", "HBNEXT", "LS", "LSNEXT", "PM", "PMNEXT", "ZEROU"]);
  const ton = new Set(["JOGTIMER", "TON_BUZZOFF", "TON_BUZZON", "TON_PUBLISH"]);
  const skip = new Set(["MB_CMD", "MB_STATION", "MB_SYS", "TANKLOW", "__SYSVA_FIRST_SCAN"]);
  const ids = new Set(prog1Text.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g).map((s) => s.toUpperCase()));
  for (const id of ids) {
    if (skip.has(id) || /^__(LG|GL|STEPPRAGMA|ENDSTEPPRAGMA)/.test(id)) continue;
    if (/^(IF|THEN|ELSE|END_IF|AND|OR|NOT|TRUE|FALSE|Q)$/.test(id)) continue;
    if (/^_IO_P2_AO/.test(id)) out.push([id, "INT", 0]);
    else if (uint.has(id)) out.push([id, "UINT", 0]);
    else if (ton.has(id)) out.push([id, "TON", null]);
    else out.push([id, "BOOL", false]);
  }
  out.push(["TANKLOW", "ARRAY[1..2] OF BOOL", false]);
  out.push(["__SYSVA_FIRST_SCAN", "BOOL", false]);
  for (const [n, len] of [["MB_SYS", 19], ["MB_TANK", 11], ["MB_CONT", 39], ["MB_EVENT", 32], ["MB_SCAN", 38], ["MB_FIELD", 19], ["MB_STATION", 12], ["MB_SIM", 1]])
    out.push([n, `ARRAY[0..${len}] OF UINT`, 0]);
  out.push(["MB_CMD", "ARRAY[0..15] OF BOOL", false]);
  // embedded presence inputs and the 2085 stand-ins Prog1 does not read
  for (let i = 7; i <= 13; i++) out.push([`_IO_EM_DI_${String(i).padStart(2, "0")}`, "BOOL", false]);
  // slot 3 is a 2080-IF2; the programs do not read it
  out.push(["_IO_P3_AI_00", "INT", 0]);
  out.push(["_IO_P3_AI_01", "INT", 0]);
  return out;
}
