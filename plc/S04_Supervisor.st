(* =====================================================================
   S04_Supervisor  —  Genesis Micro850, structured text
   Paste into a new ST program named S04_Supervisor, placed after Prog1
   and S03_Admission, before S05_Stations (plc/instruction-manual.md §6).

   Reference: twin/src/plc/virtual-plc.ts (superviseNodes, reset, poll,
   classifyBottle), twin/src/plc/arm-sequencer.ts, twin/src/barcode.ts.
   Spec: docs/prototype/micro850-plc.md §6a, §4a, §4b, §4c.

   Order inside one scan, same as the virtual PLC:
     1. RESET clears the fault latch          (VirtualPlc.reset)
     2. Node heartbeats, then node fault bits (VirtualPlc.superviseNodes)
     3. Arm sequencer                          (ArmSequencer.step)
     4. Scan mailbox + barcode validation      (poll "SCAN", core.applyScan)
     5. Sort sensor + height classification    (poll "QC", classifyBottle)

   Interface with the other programs (plc/programs.md):
     in  from Prog1: Running, ResetPulse, RunCmd, TankEnabled[1..2]
     in  from S05:   ScanHeldId, CapHeldId, QcHeldId  (id SERVING at that
                     station, 0 = none;
                     S05 releases on this scan's result)
     out to S05:     ScanReady/ScanReadyId/ScanParseResult/ScanTotalMl/
                     ScanVolMl[1..2]/ScanLane, CapOutcomeId/CapOutcome,
                     SortReady/SortReadyId/SortMeasuredLane
     out to Prog1:   FaultSet (Prog1 seals FaultHold and drops RunCmd)
     out to S07:     EvQCode/EvQArg1/EvQArg2[0..15], EvQCount
   Registers (index = register - block start):
     MB_Field[11/12] node heartbeats         MB_Station[3..12] arm, sort, faults
     MB_Scan[0..38]  scan mailbox            MB_Sys[19] FaultCode
   ===================================================================== *)

(* ---------- first scan: power-up state (nothing here is retained) ---------- *)
IF __SYSVA_FIRST_SCAN THEN
  FOR k := 1 TO 8 DO FaultLatched[k] := FALSE;
  FaultReq[k] := FALSE;
  END_FOR;
  FaultCode := 0;
  FaultCount := 0;
  ArmSeq := 0;
  ArmPending := FALSE;
  ArmPendingCmd := 0;
  ArmPendingTarget := 0;
  ArmNeedHome := TRUE;
  ArmPickFailures := 0;
  CapOutcomeId := 0;
  CapOutcome := 0;
  NodeHbSeen1 := FALSE;
  NodeHbSeen2 := FALSE;
END_IF;

ScanReady := FALSE;
SortReady := FALSE;

(* ---------- 1. RESET clears the latch (§6a) ----------
   Prog1 only raises ResetPulse when no E-Stop is active, so the reset is
   accepted. A cause that is still present latches again below. *)
FaultAny := FALSE;
FOR k := 1 TO 8 DO FaultAny := FaultAny OR FaultLatched[k];
END_FOR;
IF ResetPulse AND FaultAny THEN
  IF EvQCount < 16 THEN
    EvQCode[EvQCount] := 33;
    EvQArg1[EvQCount] := FaultCount;
    EvQArg2[EvQCount] := 0;
    (* FAULT_CLEARED *)
    EvQCount := EvQCount + 1;
  END_IF;
  FOR k := 1 TO 8 DO FaultLatched[k] := FALSE;
  END_FOR;
  FaultCode := 0;
  FaultCount := 0;
  ArmNeedHome := TRUE;
  ArmPickFailures := 0;
  NodeHbRestart := TRUE;
  (* give each node a full 3 s *)
ELSE
  NodeHbRestart := FALSE;
END_IF;

FOR k := 1 TO 8 DO FaultReq[k] := FALSE;
END_FOR;

(* ---------- 2a. node heartbeats (3 s, only for fitted nodes) ---------- *)
HbSame1 := ScannerNodeFitted AND NodeHbSeen1 AND (MB_Field[11] = NodeHbLast1) AND NOT NodeHbRestart;
NodeHbLast1 := MB_Field[11];
NodeHbSeen1 := TRUE;
TON_ScanNodeHb(IN := HbSame1, PT := T#3s);
IF TON_ScanNodeHb.Q THEN FaultReq[7] := TRUE;
END_IF;
(* SCANNER_NODE_OFFLINE *)

HbSame2 := StationNodeFitted AND NodeHbSeen2 AND (MB_Field[12] = NodeHbLast2) AND NOT NodeHbRestart;
NodeHbLast2 := MB_Field[12];
NodeHbSeen2 := TRUE;
TON_StationNodeHb(IN := HbSame2, PT := T#3s);
IF TON_StationNodeHb.Q THEN FaultReq[8] := TRUE;
END_IF;
(* STATION_NODE_OFFLINE *)

(* ---------- 2b. node fault bits ---------- *)
IF (MOD(ANY_TO_DINT(MB_Station[11]), 2)) = 1       THEN FaultReq[1] := TRUE;
END_IF;
(* 431 bit0 LABELER *)
IF (MOD(ANY_TO_DINT((MB_Station[11] / 2)), 2)) = 1 THEN FaultReq[2] := TRUE;
END_IF;
(* 431 bit1 SCANNER *)
IF (MOD(ANY_TO_DINT(MB_Station[12]), 2)) = 1       THEN FaultReq[3] := TRUE;
END_IF;
(* 432 bit0 ARM_SERVO *)
IF (MOD(ANY_TO_DINT((MB_Station[12] / 2)), 2)) = 1 THEN FaultReq[6] := TRUE;
END_IF;
(* 432 bit1 SORT_SENSOR *)

(* Latch in the virtual PLC's detection order: 7, 8, 1, 2, 3, 6.
   The arm (step 3) latches 4, 5 and 3 after this. *)
FOR k := 1 TO 6 DO
  CASE k OF
    1: Code := 7;
    StCode := 1;
    2: Code := 8;
    StCode := 23;
    3: Code := 1;
    StCode := 2;
    4: Code := 2;
    StCode := 1;
    5: Code := 3;
    StCode := 23;
    6: Code := 6;
    StCode := 21;
  END_CASE;
  IF FaultReq[Code] AND NOT FaultLatched[Code] THEN
    FaultLatched[Code] := TRUE;
    FaultCount := FaultCount + 1;
    IF FaultCode = 0 THEN FaultCode := ANY_TO_UINT(Code);
    END_IF;
    IF EvQCount < 16 THEN
      EvQCode[EvQCount] := 22;
      EvQArg1[EvQCount] := ANY_TO_UINT(Code);
      EvQArg2[EvQCount] := ANY_TO_UINT(StCode);
      (* FAULT *)
      EvQCount := EvQCount + 1;
    END_IF;
    IF RunCmd AND NOT LineStopSent THEN
      LineStopSent := TRUE;
      IF EvQCount < 16 THEN
        EvQCode[EvQCount] := 29;
        EvQArg1[EvQCount] := 3;
        EvQArg2[EvQCount] := 0;
        (* LINE_STOPPED, fault *)
        EvQCount := EvQCount + 1;
      END_IF;
    END_IF;
  END_IF;
END_FOR;

(* ---------- 3. arm sequencer (§4b, arm-sequencer.ts) ----------
   MB_Station: [3] ArmCmd, [4] ArmCmdSeq, [5] ArmDoneSeq, [6] ArmResult, [7] ArmStatus *)
ArmHomed   := (MOD(ANY_TO_DINT(MB_Station[7]), 2)) = 1;
ArmLidHeld := (MOD(ANY_TO_DINT((MB_Station[7] / 4)), 2)) = 1;
ArmFault := 0;

IF ArmPending THEN
  IF MB_Station[5] = ArmSeq THEN
    ArmPending := FALSE;
    MB_Station[3] := 0;
    ArmPlacing := ArmPendingCmd = 3;
    CASE MB_Station[6] OF
      1:  (* OK *)
        IF ArmPendingCmd = 1 THEN ArmNeedHome := FALSE;
        END_IF;
        IF ArmPendingCmd = 2 THEN ArmPickFailures := 0;
        END_IF;
        IF ArmPlacing THEN CapOutcomeId := ArmPendingTarget;
        CapOutcome := 1;
        END_IF;
      2:  (* NO_LID *)
        IF ArmPlacing THEN CapOutcomeId := ArmPendingTarget;
        CapOutcome := 2;
        END_IF;
        ArmPickFailures := ArmPickFailures + 1;
        IF ArmPickFailures >= 3 THEN ArmFault := 4;
        END_IF;
        (* ARM_NO_LID *)
      3:  (* LID_LOST *)
        IF ArmPlacing THEN CapOutcomeId := ArmPendingTarget;
        CapOutcome := 2;
        END_IF;
        ArmFault := 5;
        (* ARM_LID_LOST *)
      5:  (* ABORTED: lid already released means the PLC can't tell if it is seated *)
        ArmNeedHome := TRUE;
        IF ArmPlacing AND NOT ArmLidHeld THEN CapOutcomeId := ArmPendingTarget;
        CapOutcome := 2;
        END_IF;
      6:  (* REFUSED *)
        ArmNeedHome := TRUE;
    ELSE  (* 4 SERVO_ERROR or unknown *)
      IF ArmPlacing THEN CapOutcomeId := ArmPendingTarget;
      CapOutcome := 2;
      END_IF;
      ArmFault := 3;
      (* ARM_SERVO *)
    END_CASE;
  END_IF;
  (* else keep waiting; the CAP station timeout in S05 covers a silent arm *)
ELSE
  FaultAny := FALSE;
  FOR k := 1 TO 8 DO FaultAny := FaultAny OR FaultLatched[k];
  END_FOR;
  IF Running AND NOT FaultAny THEN
    ArmIssue := 0;
    ArmIssueTarget := 0;
    IF ArmNeedHome OR NOT ArmHomed THEN
      ArmIssue := 1;
      (* HOME *)
    ELSIF NOT ArmLidHeld THEN
      ArmIssue := 2;
      (* PICK_LID *)
    ELSIF CapHeldId <> 0 AND NOT (CapOutcomeId = CapHeldId AND CapOutcome <> 0) THEN
      ArmIssue := 3;
      ArmIssueTarget := CapHeldId;
      (* PLACE_LID *)
    END_IF;
    IF ArmIssue <> 0 THEN
      ArmSeq := ANY_TO_UINT(MOD(ANY_TO_DINT(ArmSeq), 65535) + 1);
      MB_Station[3] := ArmIssue;
      (* ArmCmd before ArmCmdSeq *)
      MB_Station[4] := ArmSeq;
      ArmPending := TRUE;
      ArmPendingCmd := ArmIssue;
      ArmPendingTarget := ArmIssueTarget;
    END_IF;
  END_IF;
END_IF;

IF ArmFault <> 0 THEN                                  (* nested: CCW evaluates both sides of AND *)
 IF NOT FaultLatched[ANY_TO_DINT(ArmFault)] THEN
  FaultLatched[ANY_TO_DINT(ArmFault)] := TRUE;
  FaultCount := FaultCount + 1;
  IF FaultCode = 0 THEN FaultCode := ArmFault;
  END_IF;
  IF EvQCount < 16 THEN
    EvQCode[EvQCount] := 22;
    EvQArg1[EvQCount] := ArmFault;
    EvQArg2[EvQCount] := 23;
    (* FAULT at CAP *)
    EvQCount := EvQCount + 1;
  END_IF;
  IF RunCmd AND NOT LineStopSent THEN
    LineStopSent := TRUE;
    IF EvQCount < 16 THEN
      EvQCode[EvQCount] := 29;
      EvQArg1[EvQCount] := 3;
      EvQArg2[EvQCount] := 0;
      EvQCount := EvQCount + 1;
    END_IF;
  END_IF;
 END_IF;
END_IF;

FaultAny := FALSE;
FOR k := 1 TO 8 DO FaultAny := FaultAny OR FaultLatched[k];
END_FOR;
FaultSet := FaultAny;
(* level: Prog1 seals FaultHold from it *)
IF NOT RunCmd THEN LineStopSent := FALSE;
END_IF;
IF FaultAny THEN MB_Sys[19] := FaultCode;
ELSE MB_Sys[19] := 0;
END_IF;

(* ---------- 4. scan mailbox and barcode validation (§4a) ----------
   MB_Scan: [0] Request, [1] Done, [2] Status, [3] Length, [4..35] Text,
            [36] ParseResult, [37] ResultId, [38] TotalMl *)
IF MB_Scan[0] <> 0 AND MB_Scan[0] <> ScanHeldId THEN
  MB_Scan[0] := 0;
  (* stale request: container left SCAN *)
END_IF;

(* Only while Running: S05 takes the result in the same scan, and the twin
   polls stations only while the line runs. *)
IF Running AND ScanHeldId <> 0 AND MB_Scan[0] <> ScanHeldId THEN
  MB_Scan[0] := ScanHeldId;
  (* new read *)
ELSIF Running AND ScanHeldId <> 0 AND MB_Scan[1] = ScanHeldId THEN
  (* ---- validate: rules of barcode.ts, first failure wins ---- *)
  TankCount := 0;
  IF TankEnabled[1] THEN TankCount := TankCount + 1;
  END_IF;
  IF TankEnabled[2] THEN TankCount := TankCount + 1;
  END_IF;

  IF ANY_TO_DINT(MB_Scan[3]) > 64 THEN ScanLen := ANY_TO_INT(64);
  ELSE ScanLen := ANY_TO_INT(MB_Scan[3]);
  END_IF;
  Result := 0;
  Total := 0;
  NVol := 0;
  FOR i := 0 TO 7 DO Vol[i] := 0;
  END_FOR;
  IF MB_Scan[2] = 1 THEN
    Result := 7;
    (* NO_READ *)
  ELSE
    FOR i := 0 TO 65 DO Ch[i] := 0;
    END_FOR;
    FOR i := 0 TO ANY_TO_DINT(ScanLen) - 1 DO                                    (* high byte first *)
      IF MOD(ANY_TO_DINT(i), 2) = 0 THEN Ch[i] := ANY_TO_USINT(ANY_TO_DINT(MB_Scan[4 + i / 2]) / 256);
      ELSE                Ch[i] := ANY_TO_USINT(MOD(ANY_TO_DINT(MB_Scan[4 + i / 2]), 256));
      END_IF;
    END_FOR;
    First := ANY_TO_DINT(ScanLen);
    (* trim spaces / control chars *)
    FOR i := 0 TO ANY_TO_DINT(ScanLen) - 1 DO IF ANY_TO_DINT(Ch[i]) > 32 THEN First := i;
    EXIT;
    END_IF;
    END_FOR;
    Last := First - 1;
    FOR i := ANY_TO_DINT(ScanLen) - 1 TO First BY -1 DO IF ANY_TO_DINT(Ch[i]) > 32 THEN Last := i;
    EXIT;
    END_IF;
    END_FOR;

    NF := 1;
    FS[1] := ANY_TO_INT(First);
    (* split on '|' *)
    FOR i := First TO Last DO
      IF ANY_TO_DINT(Ch[i]) = 124 THEN
        FE[NF] := ANY_TO_INT(i - 1);
        NF := NF + 1;
        IF NF > 5 THEN EXIT;
        END_IF;
        FS[NF] := ANY_TO_INT(i + 1);
      END_IF;
    END_FOR;
    IF NF <= 5 THEN FE[NF] := ANY_TO_INT(Last);
    END_IF;

    IF NF < 3 OR NF > 4 THEN Result := 6;
    (* MALFORMED *)
    ELSIF ANY_TO_DINT(FE[1] - FS[1]) <> 2 OR ANY_TO_DINT(Ch[ANY_TO_DINT(FS[1])]) <> 80 OR ANY_TO_DINT(Ch[ANY_TO_DINT(FS[1] + 1)]) <> 84 OR ANY_TO_DINT(Ch[ANY_TO_DINT(FS[1] + 2)]) <> 49 THEN
      Result := 1;
      (* BAD_HEADER *)
    ELSE
      Digits := 0;
      (* field 2: 'T' digits *)
      IF ANY_TO_DINT(FE[2]) < ANY_TO_DINT(FS[2]) OR ANY_TO_DINT(Ch[ANY_TO_DINT(FS[2])]) <> 84 THEN Result := 2;
      END_IF;
      FOR i := ANY_TO_DINT(FS[2]) + 1 TO ANY_TO_DINT(FE[2]) DO
        IF Result = 0 THEN
          IF ANY_TO_DINT(Ch[i]) >= 48 AND ANY_TO_DINT(Ch[i]) <= 57 AND Digits < 5 THEN
            Total := Total * 10 + ANY_TO_UDINT(ANY_TO_DINT(Ch[i]) - 48);
            Digits := Digits + 1;
          ELSE Result := 2;
          END_IF;
        END_IF;
      END_FOR;
      IF Result = 0 AND (Digits = 0 OR Total = 0 OR Total > 65535) THEN Result := 2;
      END_IF;

      Sum := 0;
      AnyNeg := FALSE;
      Acc := 0;
      Digits := 0;
      Neg := FALSE;
      Gap := FALSE;
      FOR i := ANY_TO_DINT(FS[3]) TO ANY_TO_DINT(FE[3]) + 1 DO                            (* field 3: volumes *)
        IF Result = 0 THEN
          IF i > ANY_TO_DINT(FE[3]) OR ANY_TO_DINT(Ch[i]) = 44 THEN
            IF Digits > 0 THEN
              IF NVol < 8 THEN Vol[NVol] := ANY_TO_UINT(Acc);
              END_IF;
              NVol := NVol + 1;
              Sum := Sum + Acc;
              AnyNeg := AnyNeg OR (Neg AND Acc > 0);
            ELSIF Neg THEN Result := 6;
            END_IF;
            Acc := 0;
            Digits := 0;
            Neg := FALSE;
            Gap := FALSE;
          ELSIF ANY_TO_DINT(Ch[i]) = 45 AND Digits = 0 AND NOT Neg AND NOT Gap THEN
            Neg := TRUE;
          ELSIF ANY_TO_DINT(Ch[i]) >= 48 AND ANY_TO_DINT(Ch[i]) <= 57 AND Digits < 5 AND NOT Gap THEN
            Acc := Acc * 10 + ANY_TO_UDINT(ANY_TO_DINT(Ch[i]) - 48);
            Digits := Digits + 1;
            IF Acc > 65535 THEN Result := 6;
            END_IF;
          ELSIF ANY_TO_DINT(Ch[i]) <= 32 THEN
            Gap := Gap OR Neg OR Digits > 0;
          ELSE
            Result := 6;
          END_IF;
        END_IF;
      END_FOR;

      IF Result = 0 AND NVol <> TankCount THEN Result := 3;
      ELSIF Result = 0 AND AnyNeg THEN Result := 4;
      ELSIF Result = 0 AND (Sum > Total + 1 OR Total > Sum + 1) THEN Result := 5;
      ELSIF Result = 0 AND NF = 4 THEN                          (* field 4: 'I' digits >= 1 *)
        Acc := 0;
        Digits := 0;
        IF ANY_TO_DINT(FE[4]) < ANY_TO_DINT(FS[4]) OR ANY_TO_DINT(Ch[ANY_TO_DINT(FS[4])]) <> 73 THEN Result := 6;
        END_IF;
        FOR i := ANY_TO_DINT(FS[4]) + 1 TO ANY_TO_DINT(FE[4]) DO
          IF Result = 0 THEN
            IF ANY_TO_DINT(Ch[i]) >= 48 AND ANY_TO_DINT(Ch[i]) <= 57 AND Digits < 5 THEN
              Acc := Acc * 10 + ANY_TO_UDINT(ANY_TO_DINT(Ch[i]) - 48);
              Digits := Digits + 1;
            ELSE Result := 6;
            END_IF;
          END_IF;
        END_FOR;
        IF Result = 0 AND (Digits = 0 OR Acc < 1) THEN Result := 6;
        END_IF;
      END_IF;
    END_IF;
  END_IF;

  (* ---- hand the result to S05 and publish ---- *)
  ScanReady := TRUE;
  ScanReadyId := ScanHeldId;
  ScanParseResult := ANY_TO_UINT(Result);
  ScanVolMl[1] := 0;
  ScanVolMl[2] := 0;
  ScanLane := 0;
  IF Result = 0 THEN
    ScanTotalMl := ANY_TO_UINT(Total);
    j := 0;
    (* volumes go to enabled tanks, slot order *)
    IF TankEnabled[1] THEN ScanVolMl[1] := Vol[j];
    j := j + 1;
    END_IF;
    IF TankEnabled[2] THEN ScanVolMl[2] := Vol[j];
    END_IF;
    IF ScanTotalMl > SmallBottleMaxMl THEN ScanLane := 1;
    END_IF;
    (* §4c expected lane *)
  ELSE
    ScanTotalMl := 0;
  END_IF;
  MB_Scan[36] := ScanParseResult;
  MB_Scan[37] := ScanHeldId;
  MB_Scan[38] := ScanTotalMl;
  IF EvQCount < 16 THEN
    IF Result = 0 THEN
      EvQCode[EvQCount] := 32;
      EvQArg2[EvQCount] := ScanTotalMl;
      (* BARCODE_READ *)
    ELSE
      EvQCode[EvQCount] := 3;
      EvQArg2[EvQCount] := ScanParseResult;
      (* BARCODE_REJECTED *)
    END_IF;
    EvQArg1[EvQCount] := ScanHeldId;
    EvQCount := EvQCount + 1;
  END_IF;
  MB_Scan[0] := 0;
  (* S05 releases the container this scan *)
END_IF;

(* ---------- 5. sort sensor, bottle type (§4c) ----------
   MB_Station: [8] SortRequest, [9] SortDone, [10] SortHeightMm *)
IF MB_Station[8] <> 0 AND MB_Station[8] <> QcHeldId THEN
  MB_Station[8] := 0;
  (* stale *)
END_IF;

IF Running AND QcHeldId <> 0 AND MB_Station[8] <> QcHeldId THEN
  MB_Station[8] := QcHeldId;
ELSIF Running AND QcHeldId <> 0 AND MB_Station[9] = QcHeldId THEN
  H := ANY_TO_DINT(MB_Station[10]);
  OffA := H - ANY_TO_DINT(HeightLaneAMm);
  IF OffA < 0 THEN OffA := -OffA;
  END_IF;
  OffB := H - ANY_TO_DINT(HeightLaneBMm);
  IF OffB < 0 THEN OffB := -OffB;
  END_IF;
  Tol := HeightToleranceMm;
  SortMeasuredLane := -1;
  (* unknown *)
  IF H > 0 THEN
    IF OffA <= ANY_TO_DINT(Tol) THEN SortMeasuredLane := 0;
    END_IF;
    IF OffB <= ANY_TO_DINT(Tol) AND (SortMeasuredLane < 0 OR OffB < OffA) THEN SortMeasuredLane := 1;
    END_IF;
  END_IF;
  SortReady := TRUE;
  SortReadyId := QcHeldId;
  MB_Station[8] := 0;
END_IF;
