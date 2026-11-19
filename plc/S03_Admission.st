(* =====================================================================
   S03_Admission  —  Genesis Micro850, structured text
   After Prog1, before S04_Supervisor.

   Reference: twin/src/plc/virtual-plc.ts scan() (a can arrives on the SCAN
   eye's rising edge, or on an eye blocked 1.5 s with nothing tracked there),
   twin/src/core.ts tick()/spawnContainer(). Spec §4, manual §6.

   A new container starts SERVING at SCAN. Refused while the line is not
   running, at MaxConcurrent, with SCAN occupied, with no free slot, with a
   lane full, or with an enabled tank low. A refused can stays on the eye;
   the 1.5 s rule admits it once the cause clears.

   Container slot state (ContState): 0 free, 1 SERVING, 2 MOVING,
   3 BLOCKED, 10 ACCEPTED, 11 REJECTED, 12 JAMMED.
   Stations (ContSt): 1 SCAN, 2 BAY-1, 3 BAY-2, 4 CAP, 5 PRESS, 6 QC, 7 GATE, 8 SORT.
   ===================================================================== *)

IF __SYSVA_FIRST_SCAN THEN
  FOR Slot := 0 TO 7 DO ContState[Slot] := 0;
  ContId[Slot] := 0;
  END_FOR;
  FOR k := 1 TO 8 DO StOccId[k] := 0;
  END_FOR;
  NextContId := 1;
  ActiveContainers := 0;
  ScanPrev := FALSE;
  ScanStuckDs := 0;
  ScanHeldId := 0;
  CapHeldId := 0;
  QcHeldId := 0;
END_IF;

(* Anything tracked at SCAN: held there, or (never on this line) entering. *)
TrackedAtScan := StOccId[1] <> 0;

IF Pres[1] AND NOT TrackedAtScan THEN
  IF Tick AND ScanStuckDs < 1000 THEN ScanStuckDs := ScanStuckDs + 1;
  END_IF;
ELSE
  ScanStuckDs := 0;
END_IF;
Stuck := ScanStuckDs >= 15;
IF Stuck THEN ScanStuckDs := 0;
END_IF;

IF Pres[1] AND (NOT ScanPrev OR Stuck) THEN
  (* free slot: an unused one, else the oldest finished one *)
  Free := -1;
  FOR Slot := 0 TO 7 DO
    IF Free < 0 AND ContState[Slot] = 0 THEN Free := Slot;
    END_IF;
  END_FOR;
  IF Free < 0 THEN
    FOR Slot := 0 TO 7 DO
      IF ContState[Slot] >= 10 THEN                      (* nested: CCW evaluates both sides of OR *)
        IF Free < 0 THEN Free := Slot;
        ELSIF ContDoneDs[Slot] < ContDoneDs[Free] THEN Free := Slot;
        END_IF;
      END_IF;
    END_FOR;
  END_IF;

  TanksOk := NOT TankLowAny[1] AND NOT TankLowAny[2];
  IF Running AND Free >= 0 AND ActiveContainers < MaxConcurrent AND StOccId[1] = 0
     AND NOT LaneAFull AND NOT LaneBFull AND TanksOk THEN
    Slot := Free;
    ContId[Slot] := NextContId;
    IF NextContId = 65535 THEN NextContId := 1;
    ELSE NextContId := NextContId + 1;
    END_IF;
    ContState[Slot] := 1;
    ContSt[Slot] := 1;
    ContTimerDs[Slot] := 0;
    ContTransitDs[Slot] := 0;
    ContFill_x10[Slot] := 0;
    ContTarget_x10[Slot] := 0;
    ContLane[Slot] := 0;
    ContVol1[Slot] := 0;
    ContVol2[Slot] := 0;
    ContReject[Slot] := 0;
    ContScanRejected[Slot] := FALSE;
    ContDoneDs[Slot] := 0;
    StOccId[1] := ContId[Slot];
    StArmed[1] := FALSE;
    (* this arrival is used *)
    ScanHeldId := ContId[Slot];
    ActiveContainers := ActiveContainers + 1;
    IF EvQCount < 16 THEN
      EvQCode[EvQCount] := 2;
      EvQArg1[EvQCount] := ContId[Slot];
      EvQArg2[EvQCount] := 0;
      (* CONTAINER_ENTERED *)
      EvQCount := EvQCount + 1;
    END_IF;
  END_IF;
END_IF;
ScanPrev := Pres[1];
