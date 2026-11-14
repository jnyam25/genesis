(* =====================================================================
   S00_Inputs  —  Genesis Micro850, structured text
   Runs FIRST, above Prog1 in the Project Organizer. Prog1 acknowledges
   (clears) every command coil and defaults MB_Sys[4] to 3, so the coil
   and mask writes the later programs need are read here, before that.

   Reference: twin/src/plc/virtual-plc.ts (handleCommandCoils, applyTankMask),
   twin/src/core.ts (enableSlot, removeTank, firePusher), spec §5, §7.

   - 100 ms time base: Tick (one scan) and NowDs (deciseconds since power-up)
   - presence sensors: 20 ms debounce into Pres[1..8]
   - Cmd.FirePusher (coil 3) → FirePulse, authorized here
   - Sys.TankEnableMask (MB_Sys[4]) writes → TankEnabled[1..2]
   - tank refilled coils 12 and 13, tank low flags
   - while SimInputs is on: drive the points Prog1 reads from MB_Sim and
     coils 8–11, and simulate the safety relay (Prog1 holds its output off)
   ===================================================================== *)

IF __SYSVA_FIRST_SCAN THEN
  NowDs := 0; DownDs := 0; ClockDays := 0;
  EvQCount := 0;
  SimInputs := FALSE; SimCircuitOk := FALSE;
  TankEnabled[1] := TRUE; TankEnabled[2] := TRUE;
  TankEnableMaskCopy := 3;
  MB_Sys[4] := 3;
  TankLevelMl_x10[1] := ANY_TO_UDINT(TankCapacityMl) * 10;
  TankLevelMl_x10[2] := ANY_TO_UDINT(TankCapacityMl) * 10;
  TankLowPrev[1] := FALSE; TankLowPrev[2] := FALSE;
  FOR k := 1 TO 8 DO StArmed[k] := TRUE; END_FOR;
END_IF;

(* ---------- 100 ms time base ----------
   One TON runs for a day and is read through ET, so no scan time is lost
   (a self-restarting 100 ms TON drops up to a scan on every restart). *)
TON_Clock(IN := TRUE, PT := T#24h);
IF TON_Clock.Q THEN
  ClockDays := ClockDays + 1;
  TON_Clock(IN := FALSE, PT := T#24h);
  TON_Clock(IN := TRUE, PT := T#24h);
END_IF;
ClockDs := ClockDays * 864000 + ANY_TO_UDINT(TON_Clock.ET) / 100;
Tick := ClockDs <> NowDs;
NowDs := ClockDs;

(* ---------- test mode ----------
   Prog1 copies SafetyOK, the key switch and the E-Stop monitors from the
   wired inputs, and it holds every field output off while SimInputs is on,
   so the safety relay on the bench stays open. Drive those inputs from the
   simulation registers instead. Coils 8–11 are the panel buttons.
   The safety relay closes on Sim.LocalReset and opens on an E-Stop. *)
IF SimInputs THEN
  _IO_EM_DI_01 := (MB_Sim[0] MOD 2) = 0;                              (* NC: mask bit0 pressed → 0 *)
  _IO_EM_DI_02 := ((MB_Sim[0] / 2) MOD 2) = 0;                        (* mask bit1 *)
  _IO_EM_DI_04 := MB_Sim[1] <> 0;                                     (* key switch: 1 = LOCAL *)
  _IO_EM_DI_05 := NOT MB_Cmd[9];                                      (* NC stop *)
  X1_DI_06 := MB_Cmd[8];                                              (* local START *)
  _IO_EM_DI_06 := MB_Cmd[10];                                         (* local RESET *)
  X1_DI_07 := MB_Cmd[11];                                             (* local JOG *)
  IF (MB_Sim[0] MOD 4) <> 0 OR DigitalEStop THEN
    SimCircuitOk := FALSE;
  ELSIF MB_Cmd[10] THEN
    SimCircuitOk := TRUE;
  END_IF;
  _IO_EM_DI_00 := SimCircuitOk;
END_IF;

(* ---------- presence sensors, 20 ms on-delay ----------
   1 SCAN, 2 BAY-1, 3 BAY-2, 4 CAP, 5 PRESS, 6 QC, 7 GATE, 8 SORT *)
TON_Pres1(IN := _IO_EM_DI_07, PT := T#20ms);  Pres[1] := TON_Pres1.Q;
TON_Pres2(IN := _IO_EM_DI_08, PT := T#20ms);  Pres[2] := TON_Pres2.Q;
TON_Pres3(IN := _IO_EM_DI_09, PT := T#20ms);  Pres[3] := TON_Pres3.Q;
TON_Pres4(IN := _IO_EM_DI_10, PT := T#20ms);  Pres[4] := TON_Pres4.Q;
TON_Pres5(IN := _IO_EM_DI_11, PT := T#20ms);  Pres[5] := TON_Pres5.Q;
TON_Pres6(IN := _IO_EM_DI_12, PT := T#20ms);  Pres[6] := TON_Pres6.Q;
TON_Pres7(IN := _IO_EM_DI_13, PT := T#20ms);  Pres[7] := TON_Pres7.Q;
TON_Pres8(IN := X1_DI_00,     PT := T#20ms);  Pres[8] := TON_Pres8.Q;   (* _IO_X1_DI_00 once the 2085-IQ16 is fitted *)
(* A sensor that reads 0 re-arms its station for the next arrival (core.ts sensorArmed). *)
FOR k := 1 TO 8 DO
  IF NOT Pres[k] THEN StArmed[k] := TRUE; END_IF;
END_FOR;

(* ---------- Cmd.FirePusher (coil 3), REMOTE only (safety.ts authorize) ----------
   LocalMode, EStopActive and ResetRequired are last scan's values from Prog1. *)
FirePulse := FALSE;
IF MB_Cmd[3] THEN
  IF LocalMode THEN
    IF EvQCount < 16 THEN EvQCode[EvQCount] := 31; EvQArg1[EvQCount] := 5; EvQArg2[EvQCount] := 1; EvQCount := EvQCount + 1; END_IF;
  ELSIF EStopActive THEN
    IF EvQCount < 16 THEN EvQCode[EvQCount] := 31; EvQArg1[EvQCount] := 5; EvQArg2[EvQCount] := 3; EvQCount := EvQCount + 1; END_IF;
  ELSIF ResetRequired THEN
    IF EvQCount < 16 THEN EvQCode[EvQCount] := 31; EvQArg1[EvQCount] := 5; EvQArg2[EvQCount] := 4; EvQCount := EvQCount + 1; END_IF;
  ELSE
    FirePulse := TRUE;                                   (* S05 rejects the can at QC or GATE *)
  END_IF;
END_IF;

(* ---------- Sys.TankEnableMask (MB_Sys[4]) ---------- *)
IF __SYSVA_FIRST_SCAN THEN
  MB_Sys[4] := TankEnableMaskCopy;
ELSIF MB_Sys[4] <> TankEnableMaskCopy THEN
  NewMask := MB_Sys[4] MOD 4;                           (* two slots *)
  IF LocalMode THEN
    IF EvQCount < 16 THEN EvQCode[EvQCount] := 31; EvQArg1[EvQCount] := 6; EvQArg2[EvQCount] := 1; EvQCount := EvQCount + 1; END_IF;
  ELSIF NewMask = 0 THEN
    IF EvQCount < 16 THEN EvQCode[EvQCount] := 18; EvQArg1[EvQCount] := 4; EvQArg2[EvQCount] := 0; EvQCount := EvQCount + 1; END_IF;  (* LAST_TANK *)
  ELSE
    (* enable first, then disable, like VirtualPlc.applyTankMask *)
    FOR k := 1 TO 2 DO
      IF k = 1 THEN Want := (NewMask MOD 2) = 1; ELSE Want := (NewMask / 2) = 1; END_IF;
      IF Want AND NOT TankEnabled[k] THEN
        TankEnabled[k] := TRUE;
        TankLevelMl_x10[k] := ANY_TO_UDINT(TankCapacityMl) * 10;   (* core.enableSlot starts it full *)
        NEnabled := 0; IF TankEnabled[1] THEN NEnabled := NEnabled + 1; END_IF; IF TankEnabled[2] THEN NEnabled := NEnabled + 1; END_IF;
        IF EvQCount < 16 THEN EvQCode[EvQCount] := 16; EvQArg1[EvQCount] := ANY_TO_UINT(k); EvQArg2[EvQCount] := ANY_TO_UINT(NEnabled); EvQCount := EvQCount + 1; END_IF;
      END_IF;
    END_FOR;
    FOR k := 1 TO 2 DO
      IF k = 1 THEN Want := (NewMask MOD 2) = 1; ELSE Want := (NewMask / 2) = 1; END_IF;
      IF NOT Want AND TankEnabled[k] THEN
        TankEnabled[k] := FALSE;
        NEnabled := 0; IF TankEnabled[1] THEN NEnabled := NEnabled + 1; END_IF; IF TankEnabled[2] THEN NEnabled := NEnabled + 1; END_IF;
        IF EvQCount < 16 THEN EvQCode[EvQCount] := 17; EvQArg1[EvQCount] := ANY_TO_UINT(k); EvQArg2[EvQCount] := ANY_TO_UINT(NEnabled); EvQCount := EvQCount + 1; END_IF;
      END_IF;
    END_FOR;
  END_IF;
  TankEnableMaskCopy := 0;
  IF TankEnabled[1] THEN TankEnableMaskCopy := TankEnableMaskCopy + 1; END_IF;
  IF TankEnabled[2] THEN TankEnableMaskCopy := TankEnableMaskCopy + 2; END_IF;
  MB_Sys[4] := TankEnableMaskCopy;                     (* refused or applied: publish what is real *)
END_IF;

(* ---------- tanks without level sensors (§5) ----------
   Coils 12 and 13 are the touch-panel "tank refilled" buttons. Prog1 does
   not clear them, so this program does, in the scan it sees them. *)
IF MB_Cmd[12] THEN TankRefilled[1] := TRUE; MB_Cmd[12] := FALSE; END_IF;
IF MB_Cmd[13] THEN TankRefilled[2] := TRUE; MB_Cmd[13] := FALSE; END_IF;
FOR k := 1 TO 2 DO
  IF TankRefilled[k] THEN
    TankRefilled[k] := FALSE;
    TankLevelMl_x10[k] := ANY_TO_UDINT(TankCapacityMl) * 10;
    IF EvQCount < 16 THEN EvQCode[EvQCount] := 9; EvQArg1[EvQCount] := ANY_TO_UINT(k); EvQArg2[EvQCount] := TankCapacityMl; EvQCount := EvQCount + 1; END_IF;
  END_IF;
  (* TankLow[k] is the float, copied by Prog1 *)
  TankLowAny[k] := TankEnabled[k] AND (TankLow[k] OR TankLevelMl_x10[k] < ANY_TO_UDINT(TankRefillThresholdMl) * 10);
  IF TankLowAny[k] AND NOT TankLowPrev[k] THEN
    IF EvQCount < 16 THEN EvQCode[EvQCount] := 8; EvQArg1[EvQCount] := ANY_TO_UINT(k); EvQArg2[EvQCount] := ANY_TO_UINT(TankLevelMl_x10[k] / 10); EvQCount := EvQCount + 1; END_IF;
  END_IF;
  TankLowPrev[k] := TankLowAny[k];
END_FOR;
