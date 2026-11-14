(* =====================================================================
   S05_Stations  —  Genesis Micro850, structured text
   After S04_Supervisor, before S07_Publish.

   Reference: twin/src/core.ts progressContainer / completeOp / finalizeAtGate /
   accept / reject / forceReject / firePusher, and the field outputs of
   twin/src/plc/virtual-plc.ts publishPlant. Spec §4.

   Where this differs from the twin on purpose (physical belt):
   - QC → GATE is a hop to the gate eye; the twin decides GATE while the can
     is still at QC, so its pusher strokes before the can arrives.
   - Cmd.FirePusher on a can at QC flags it; GATE pushes it (spec §7).
   - A rejected can keeps its stopper closed, and back-to-back rejects each
     get a stroke.
   - A bay's timeout is its fill time + 6 s (the twin's fixed 6 s jams any
     single-tank volume over ~145 ml).

   One container per station. Containers move in id order (oldest first),
   and only while Running: a stop freezes every timer. Times are in 0.1 s
   (Tick from S00_Inputs).

   ContState: 0 free, 1 SERVING, 2 MOVING, 3 BLOCKED, 10 ACCEPTED, 11 REJECTED, 12 JAMMED
   ContSt:    1 SCAN, 2 BAY-1, 3 BAY-2, 4 CAP, 5 PRESS, 6 QC, 7 GATE, 8 SORT
   Station codes (events): 1, 11, 12, 23, 24, 21, 22, 25
   Reject reasons: 1 BAD_BARCODE, 2 FILL_OUT_OF_TOLERANCE, 3 MANUAL_PUSHER,
                   6 BOTTLE_TYPE_MISMATCH, 7 STATION_FAULT
   ===================================================================== *)

IF __SYSVA_FIRST_SCAN THEN
  QrPulseDs := 0; RejPulseDs := 0; QrGapDs := 0; RejGapDs := 0; QrPending := FALSE; RejPending := FALSE;
  CountAccepted := 0; CountRejected := 0; CountTotal := 0; LaneACount := 0; LaneBCount := 0;
  FOR k := 1 TO 7 DO StopHeldPrev[k] := 0; StopReleaseDs[k] := 0; END_FOR;
  FOR i := 0 TO 63 DO AccDs[i] := 0; END_FOR;
  AccHead := 0; AccN := 0;
END_IF;

QrFire := FALSE; RejFire := FALSE;     (* set below when a can is rejected at SCAN / GATE *)

(* ---------- live containers, oldest first ---------- *)
NOrd := 0;
FOR s := 0 TO 7 DO
  IF ContState[s] >= 1 AND ContState[s] <= 3 THEN
    j := NOrd;                                          (* insertion by id *)
    WHILE j > 0 DO
      IF ContId[Ord[j - 1]] > ContId[s] THEN Ord[j] := Ord[j - 1]; j := j - 1; ELSE EXIT; END_IF;
    END_WHILE;
    Ord[j] := s;
    NOrd := NOrd + 1;
  END_IF;
END_FOR;

(* ---------- Cmd.FirePusher: reject the can at QC or GATE (core.firePusher) ---------- *)
IF FirePulse THEN
  Target := -1;
  FOR n := 0 TO 7 DO
    IF n < NOrd AND Target < 0 THEN
      s := Ord[n];
      IF ContState[s] = 1 AND (ContSt[s] = 6 OR ContSt[s] = 7) THEN Target := s; END_IF;
    END_IF;
  END_FOR;
  IF Target < 0 THEN
    IF EvQCount < 16 THEN EvQCode[EvQCount] := 15; EvQArg1[EvQCount] := 0; EvQArg2[EvQCount] := 0; EvQCount := EvQCount + 1; END_IF;
  ELSE
    s := Target;
    IF EvQCount < 16 THEN EvQCode[EvQCount] := 14; EvQArg1[EvQCount] := ContId[s]; EvQArg2[EvQCount] := 0; EvQCount := EvQCount + 1; END_IF;
    IF ContSt[s] = 7 THEN
      (* on the gate eye: push it now *)
      StOccId[7] := 0;
      ContState[s] := 11; ContDoneDs[s] := NowDs; RejFire := TRUE;
      CountRejected := CountRejected + 1; CountTotal := CountTotal + 1;
      IF EvQCount < 16 THEN EvQCode[EvQCount] := 5; EvQArg1[EvQCount] := ContId[s]; EvQArg2[EvQCount] := 3; EvQCount := EvQCount + 1; END_IF;
    ELSE
      ContReject[s] := 3;                               (* at QC: GATE pushes it (spec §7 ManualReject) *)
    END_IF;
  END_IF;
END_IF;

(* ---------- station machines ---------- *)
AnyBlocked := FALSE;
IF Running THEN
  FOR n := 0 TO 7 DO
    IF n < NOrd THEN
      s := Ord[n];
      St := ContSt[s];
      Done := FALSE;      (* the op at St finished: go to NextSt *)
      Act := 0;           (* 1 arrive at St (serve or block), 2 arrive at GATE (decide) *)
      Fin := 0;           (* 2 reject, 3 jam *)
      FinReason := 0;

      IF ContState[s] = 1 THEN
        (* ===== SERVING ===== *)
        IF Tick THEN ContTimerDs[s] := ContTimerDs[s] + 1; END_IF;
        T := ContTimerDs[s];
        CASE St OF
          1:  (* SCAN: S04 validated the label *)
            IF ScanReady AND ScanReadyId = ContId[s] THEN
              IF ScanParseResult <> 0 THEN
                Fin := 2; FinReason := 1; ContScanRejected[s] := TRUE;
              ELSE
                ContVol1[s] := ScanVolMl[1]; ContVol2[s] := ScanVolMl[2];
                ContTarget_x10[s] := ScanTotalMl * 10; ContLane[s] := ScanLane;
                Done := TRUE;
              END_IF;
            ELSIF T >= 150 THEN Fin := 3; END_IF;
          2, 3:  (* BAY-k: valve open BayVol/Rate, then 0.2 s *)
            IF St = 2 THEN BayVol := ContVol1[s]; k := 1; ELSE BayVol := ContVol2[s]; k := 2; END_IF;
            OpenDs := ANY_TO_UDINT(BayVol) * 100 / ANY_TO_UDINT(TankRateMlPerS_x10);
            IF ANY_TO_UDINT(T) >= OpenDs + 2 THEN
              IF TankEnabled[k] THEN
                Amt := ANY_TO_UDINT(BayVol) * 10;
                IF Amt > TankLevelMl_x10[k] THEN Amt := TankLevelMl_x10[k]; END_IF;
                TankLevelMl_x10[k] := TankLevelMl_x10[k] - Amt;
                ContFill_x10[s] := ContFill_x10[s] + ANY_TO_UINT(Amt);
              ELSIF EvQCount < 16 THEN
                EvQCode[EvQCount] := 7; EvQArg1[EvQCount] := ContId[s]; EvQArg2[EvQCount] := ANY_TO_UINT(k); EvQCount := EvQCount + 1;  (* DISPENSE_SKIPPED *)
              END_IF;
              Done := TRUE;
            ELSIF ANY_TO_UDINT(T) >= OpenDs + 62 THEN Fin := 3; END_IF;
          4:  (* CAP: the arm sequencer in S04 reports the outcome *)
            IF CapOutcome <> 0 AND CapOutcomeId = ContId[s] THEN
              IF CapOutcome = 2 THEN ContReject[s] := 7; END_IF;     (* STATION_FAULT *)
              CapOutcome := 0; CapOutcomeId := 0;
              Done := TRUE;
            ELSIF T >= 150 THEN Fin := 3; END_IF;
          5:  (* PRESS. A flagged can (failed cap) passes straight through. *)
            IF ContReject[s] <> 0 OR T >= 8 THEN Done := TRUE; ELSIF T >= 60 THEN Fin := 3; END_IF;
          6:  (* QC: S04 classified the height *)
            IF ContReject[s] <> 0 THEN
              Done := TRUE;                                         (* flagged: no height reading *)
            ELSIF SortReady AND SortReadyId = ContId[s] THEN
              IF SortMeasuredLane <> ANY_TO_INT(ContLane[s]) THEN ContReject[s] := 6; END_IF;
              Done := TRUE;
            ELSIF T >= 150 THEN Fin := 3; END_IF;
          7:  (* GATE, passed: no timeout *)
            IF T >= 3 THEN Done := TRUE; END_IF;
          8:  (* SORT *)
            IF T >= 3 THEN Done := TRUE; ELSIF T >= 60 THEN Fin := 3; END_IF;
        END_CASE;

      ELSIF ContState[s] = 2 THEN
        (* ===== MOVING to St ===== *)
        IF Tick THEN ContTimerDs[s] := ContTimerDs[s] + 1; END_IF;
        IF Pres[St] AND StArmed[St] THEN
          StArmed[St] := FALSE;
          IF St = 7 THEN Act := 2; ELSE Act := 1; END_IF;
        ELSIF ContTimerDs[s] >= ContTransitDs[s] + 120 THEN
          Fin := 3;                                    (* the sensor never saw it *)
        END_IF;

      ELSIF ContState[s] = 3 THEN
        (* ===== BLOCKED before St ===== *)
        IF Tick THEN ContTimerDs[s] := ContTimerDs[s] + 1; END_IF;
        IF ContTimerDs[s] >= 60 THEN Fin := 3;
        ELSIF StOccId[St] = 0 THEN
          IF St = 7 THEN Act := 2; ELSE Act := 1; END_IF;
        END_IF;
      END_IF;

      (* ----- op finished: release, then the next station (core.completeOp) ----- *)
      IF Done THEN
        (* A flagged can still visits PRESS and QC as pass-throughs (core.flagReject
           skips them), so every stopper and eye on the way sees it. *)
        CASE St OF
          1: IF ContVol1[s] > 0 THEN NextSt := 2; ELSIF ContVol2[s] > 0 THEN NextSt := 3; ELSE NextSt := 4; END_IF;
          2: IF ContVol2[s] > 0 THEN NextSt := 3; ELSE NextSt := 4; END_IF;
          3: NextSt := 4;
          4: NextSt := 5;
          5: NextSt := 6;
          6: NextSt := 7;
          7: NextSt := 8;
          8: NextSt := 0;                                             (* last station: accept *)
        END_CASE;
        StOccId[St] := 0;
        IF NextSt = 0 THEN
          ContState[s] := 10; ContDoneDs[s] := NowDs;
          CountAccepted := CountAccepted + 1; CountTotal := CountTotal + 1;
          IF ContLane[s] = 1 THEN LaneBCount := LaneBCount + 1; ELSE LaneACount := LaneACount + 1; END_IF;
          AccDs[AccHead] := NowDs; AccHead := (AccHead + 1) MOD 64; IF AccN < 64 THEN AccN := AccN + 1; END_IF;
          IF EvQCount < 16 THEN EvQCode[EvQCount] := 4; EvQArg1[EvQCount] := ContId[s]; EvQArg2[EvQCount] := ContFill_x10[s]; EvQCount := EvQCount + 1; END_IF;
        ELSE
          (* QC → GATE travels to the gate eye like any other hop, so the pusher
             fires with the can in front of it. The twin decides the moment QC
             finishes (core.completeOp); on this belt GATE is 0.5 m further on. *)
          ContSt[s] := NextSt; ContState[s] := 2; ContTimerDs[s] := 0;
          ContTransitDs[s] := ANY_TO_UINT(NextSt - St) * 25;          (* 0.5 m per hop at 0.2 m/s *)
        END_IF;
      END_IF;

      (* ----- arrival at GATE: decide (core.finalizeAtGate) ----- *)
      IF Act = 2 THEN
        IF StOccId[7] <> 0 THEN
          ContState[s] := 3; ContTimerDs[s] := 0;
        ELSE
          StOccId[7] := ContId[s];
          FillTol := ContTarget_x10[s] * 3 / 100;                         (* (variance + 1 %) of target, ml x10 *)
          IF FillTol < 10 THEN FillTol := 10; END_IF;
          IF ContFill_x10[s] > ContTarget_x10[s] THEN Dev := ContFill_x10[s] - ContTarget_x10[s];
          ELSE Dev := ContTarget_x10[s] - ContFill_x10[s]; END_IF;
          IF ContReject[s] <> 0 THEN Fin := 2; FinReason := ContReject[s];
          ELSIF Dev > FillTol THEN Fin := 2; FinReason := 2;
          ELSE ContState[s] := 1; ContTimerDs[s] := 0;
          END_IF;
        END_IF;
      ELSIF Act = 1 THEN
        IF StOccId[St] <> 0 THEN
          IF ContState[s] <> 3 THEN ContState[s] := 3; ContTimerDs[s] := 0; END_IF;
        ELSE
          StOccId[St] := ContId[s]; ContState[s] := 1; ContTimerDs[s] := 0;
        END_IF;
      END_IF;

      (* ----- finished: reject or jam ----- *)
      IF Fin <> 0 THEN
        IF StOccId[St] = ContId[s] THEN StOccId[St] := 0; END_IF;
        ContDoneDs[s] := NowDs;
        CountRejected := CountRejected + 1; CountTotal := CountTotal + 1;
        IF Fin = 2 THEN
          ContState[s] := 11;
          IF St = 1 THEN QrFire := TRUE; ELSE RejFire := TRUE; END_IF;
          IF EvQCount < 16 THEN EvQCode[EvQCount] := 5; EvQArg1[EvQCount] := ContId[s]; EvQArg2[EvQCount] := FinReason; EvQCount := EvQCount + 1; END_IF;
        ELSE
          ContState[s] := 12;
          CASE St OF 1: Code := 1; 2: Code := 11; 3: Code := 12; 4: Code := 23; 5: Code := 24; 6: Code := 21; 7: Code := 22; 8: Code := 25; END_CASE;
          IF EvQCount < 16 THEN EvQCode[EvQCount] := 6; EvQArg1[EvQCount] := ContId[s]; EvQArg2[EvQCount] := ANY_TO_UINT(Code); EvQCount := EvQCount + 1; END_IF;
        END_IF;
      END_IF;

      IF ContState[s] = 3 THEN AnyBlocked := TRUE; END_IF;
    END_IF;
  END_FOR;
END_IF;

(* ---------- slots, held ids, active count ---------- *)
ScanHeldId := 0; CapHeldId := 0; QcHeldId := 0; ActiveContainers := 0;
FOR k := 1 TO 8 DO StHeldId[k] := 0; StAwaited[k] := FALSE; END_FOR;
StAwaited[1] := TRUE;                                   (* every can stops at SCAN *)
LaneBCmdNext := FALSE; LaneBSeen := FALSE;
FOR s := 0 TO 7 DO
  IF ContState[s] >= 1 AND ContState[s] <= 3 THEN
    ActiveContainers := ActiveContainers + 1;
    IF ContState[s] = 1 THEN StHeldId[ContSt[s]] := ContId[s];
    ELSE StAwaited[ContSt[s]] := TRUE; END_IF;
  ELSIF ContState[s] >= 10 AND NowDs - ContDoneDs[s] > 15 THEN
    ContState[s] := 0; ContId[s] := 0;                  (* finished 1.5 s ago: drop from the table *)
  END_IF;
END_FOR;
ScanHeldId := StHeldId[1];
CapHeldId := StHeldId[4];
FOR s := 0 TO 7 DO
  IF ContState[s] = 1 AND ContSt[s] = 6 AND ContReject[s] = 0 THEN QcHeldId := ContId[s]; END_IF;
END_FOR;
IF AnyBlocked OR NOT Running THEN
  IF Tick THEN DownDs := DownDs + 1; END_IF;
END_IF;

(* sort diverter: set for the oldest can heading to (or at) SORT; with none,
   pre-set for the oldest at GATE. The twin follows the oldest at QC/GATE/SORT,
   which on a real belt can switch lanes under a can that is passing. *)
FOR Pass := 8 TO 7 BY -1 DO
  FOR n := 0 TO 7 DO
    IF n < NOrd AND NOT LaneBSeen THEN
      s := Ord[n];
      IF ContState[s] >= 1 AND ContState[s] <= 3 AND ContSt[s] = ANY_TO_UINT(Pass) THEN
        LaneBSeen := TRUE; LaneBCmdNext := ContLane[s] = 1;
      END_IF;
    END_IF;
  END_FOR;
END_FOR;
IF NOT LaneBSeen THEN LaneBCmdNext := SortLaneBCmd; END_IF;   (* nothing coming: hold position *)

(* ---------- station bits for the Prog1 output map ---------- *)
Valve1Cmd := FALSE; Valve2Cmd := FALSE; LidPressCmd := FALSE;
FOR s := 0 TO 7 DO
  IF ContState[s] = 1 THEN
    IF ContSt[s] = 2 THEN
      Valve1Cmd := ANY_TO_UDINT(ContTimerDs[s]) < ANY_TO_UDINT(ContVol1[s]) * 100 / ANY_TO_UDINT(TankRateMlPerS_x10);
    ELSIF ContSt[s] = 3 THEN
      Valve2Cmd := ANY_TO_UDINT(ContTimerDs[s]) < ANY_TO_UDINT(ContVol2[s]) * 100 / ANY_TO_UDINT(TankRateMlPerS_x10);
    ELSIF ContSt[s] = 5 AND ContReject[s] = 0 THEN
      LidPressCmd := TRUE;
    END_IF;
  END_IF;
END_FOR;
Valve1Cmd := Valve1Cmd AND TankEnabled[1] AND Running;
Valve2Cmd := Valve2Cmd AND TankEnabled[2] AND Running;
LidPressCmd := LidPressCmd AND Running;
(* One-shot pushers: 1 s stroke. A reject that arrives while the cylinder is
   still out waits for it to retract (0.3 s) and strokes again, so every
   rejected can gets its own push. *)
IF QrFire THEN QrPending := TRUE; END_IF;
IF RejFire THEN RejPending := TRUE; END_IF;
(* Prog1 drives the cylinders only while Running, so a stroke is timed only then. *)
IF Running AND QrPulseDs = 0 AND QrGapDs = 0 AND QrPending THEN QrPulseDs := 10; QrPending := FALSE; END_IF;
IF Running AND RejPulseDs = 0 AND RejGapDs = 0 AND RejPending THEN RejPulseDs := 10; RejPending := FALSE; END_IF;
IF Tick AND Running THEN
  IF QrPulseDs > 0 THEN QrPulseDs := QrPulseDs - 1; IF QrPulseDs = 0 THEN QrGapDs := 3; END_IF;
  ELSIF QrGapDs > 0 THEN QrGapDs := QrGapDs - 1; END_IF;
  IF RejPulseDs > 0 THEN RejPulseDs := RejPulseDs - 1; IF RejPulseDs = 0 THEN RejGapDs := 3; END_IF;
  ELSIF RejGapDs > 0 THEN RejGapDs := RejGapDs - 1; END_IF;
END_IF;
QrRejectCmd := QrPulseDs > 0;
RejectCmd := RejPulseDs > 0;
SortLaneBCmd := LaneBCmdNext;

(* Stoppers 1..7 (SCAN..GATE): hold a can while its station works on it; after
   it finishes, retract until the eye clears (2 s at most). A station with a can
   on its way stays extended to catch it; others let cans pass. *)
FOR k := 1 TO 7 DO
  IF StopHeldPrev[k] <> 0 AND StHeldId[k] <> StopHeldPrev[k] THEN
    (* release only for a can that moves on; a rejected or jammed can stays held
       so the pusher strokes against it *)
    MovesOn := FALSE;
    FOR s := 0 TO 7 DO
      IF ContId[s] = StopHeldPrev[k] AND ContState[s] >= 1 AND ContState[s] <= 3 THEN MovesOn := TRUE; END_IF;
    END_FOR;
    IF MovesOn THEN StopReleaseDs[k] := 20; END_IF;
  END_IF;
  IF StopReleaseDs[k] > 0 AND NOT Pres[k] THEN StopReleaseDs[k] := 0; END_IF;
  IF Tick AND Running AND StopReleaseDs[k] > 0 THEN StopReleaseDs[k] := StopReleaseDs[k] - 1; END_IF;  (* outputs are off while stopped *)
  StopHeldPrev[k] := StHeldId[k];
  StopRel[k] := StopReleaseDs[k] > 0 OR (StHeldId[k] = 0 AND NOT StAwaited[k]);
END_FOR;
RelScan := StopRel[1]; RelBay1 := StopRel[2]; RelBay2 := StopRel[3]; RelCap := StopRel[4];
RelPress := StopRel[5]; RelQC := StopRel[6]; RelGate := StopRel[7];

(* Slot 2 is the valve 2080-OF2. Prog1 writes 0 to both channels earlier in
   the scan; this write is the one that stays. AoFullScale is the raw count
   at 100% from that module's configuration page. Leave it 0 until then.
   Slot 3 is a second 2080-OF2 with nothing assigned, so both channels stay 0.
   SimInputs forces the angles to 0. A stopped line already clears Valve*Cmd. *)
AoOut := 0;
IF AoFullScale > 0 AND NOT SimInputs THEN
  AoOut := ANY_TO_INT(ANY_TO_DINT(TankValveOpeningPct) * ANY_TO_DINT(AoFullScale) / 100);
END_IF;
IF Valve1Cmd THEN _IO_P2_AO_00 := AoOut; ELSE _IO_P2_AO_00 := 0; END_IF;
IF Valve2Cmd THEN _IO_P2_AO_01 := AoOut; ELSE _IO_P2_AO_01 := 0; END_IF;
_IO_P3_AO_00 := 0;
_IO_P3_AO_01 := 0;
