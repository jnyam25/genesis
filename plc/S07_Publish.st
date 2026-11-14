(* =====================================================================
   S07_Publish  —  Genesis Micro850, structured text
   Last program.

   Reference: twin/src/plc/virtual-plc.ts publish(), twin/src/metrics.ts,
   twin/src/hmi.ts (hmiStatus, visibleContainers, liveOee), spec §8.

   Prog1 already writes MB_Sys[0], [1], [2], [16] and MB_Station[0].
   This program:
     - derives the safety/run events Prog1 does not record (edges of Prog1 state)
     - drains EvQ into the event ring every scan (MB_Event)
     - every 100 ms: counts, OEE, throughput, uptime, tank block, container table,
       Sys.TankCount, Sys.TankEnableMask, LineState bit4 (HMI link)
   ===================================================================== *)

IF __SYSVA_FIRST_SCAN THEN
  EvSeq := 0;
  FOR i := 0 TO 32 DO MB_Event[i] := 0; END_FOR;
  PrevDigital := FALSE; PrevEntry := FALSE; PrevExit := FALSE; PrevLocal := LocalMode;
  PrevRunCmd := FALSE; PrevSafetyOK := SafetyOK; PrevJogBelt := FALSE;
  HmiHbLast := MB_Sys[13];
END_IF;

(* ---------- safety and run events (safety.ts), from Prog1 state ---------- *)
IF NOT __SYSVA_FIRST_SCAN THEN
  IF DigitalEStop AND NOT PrevDigital THEN
    IF EvQCount < 16 THEN EvQCode[EvQCount] := 23; EvQArg1[EvQCount] := 0; EvQArg2[EvQCount] := 0; EvQCount := EvQCount + 1; END_IF;
  ELSIF PrevDigital AND NOT DigitalEStop THEN
    IF EvQCount < 16 THEN EvQCode[EvQCount] := 24; EvQArg1[EvQCount] := 0; EvQArg2[EvQCount] := 0; EvQCount := EvQCount + 1; END_IF;
  END_IF;
  FOR k := 0 TO 1 DO
    IF k = 0 THEN BNow := EntryPressed; BWas := PrevEntry; ELSE BNow := ExitPressed; BWas := PrevExit; END_IF;
    IF BNow <> BWas AND EvQCount < 16 THEN
      IF BNow THEN EvQCode[EvQCount] := 25; ELSE EvQCode[EvQCount] := 26; END_IF;   (* PHYSICAL_ESTOP_PRESSED / RELEASED *)
      EvQArg1[EvQCount] := ANY_TO_UINT(k); EvQArg2[EvQCount] := 0; EvQCount := EvQCount + 1;
    END_IF;
  END_FOR;
  IF LocalMode <> PrevLocal AND EvQCount < 16 THEN
    EvQCode[EvQCount] := 30; EvQArg1[EvQCount] := ANY_TO_UINT(LocalMode); EvQArg2[EvQCount] := 0; EvQCount := EvQCount + 1;   (* CONTROL_MODE_CHANGED *)
  END_IF;
  IF SafetyOK AND NOT PrevSafetyOK AND EvQCount < 16 THEN
    EvQCode[EvQCount] := 27; EvQArg1[EvQCount] := 1; EvQArg2[EvQCount] := 0; EvQCount := EvQCount + 1;   (* SAFETY_RESET, local *)
  END_IF;
  IF RunCmd AND NOT PrevRunCmd AND EvQCount < 16 THEN
    EvQCode[EvQCount] := 28; EvQArg2[EvQCount] := 0;                                                     (* LINE_STARTED *)
    IF LocalMode THEN EvQArg1[EvQCount] := 1; ELSE EvQArg1[EvQCount] := 2; END_IF;
    EvQCount := EvQCount + 1;
  ELSIF PrevRunCmd AND NOT RunCmd AND NOT FaultSet AND EvQCount < 16 THEN
    (* LINE_STOPPED: 0 E-Stop, 1 local, 2 remote. S04 already recorded a fault stop (3). *)
    EvQCode[EvQCount] := 29; EvQArg2[EvQCount] := 0;
    IF EStopActive THEN EvQArg1[EvQCount] := 0;
    ELSIF LocalMode OR NOT _IO_EM_DI_05 THEN EvQArg1[EvQCount] := 1;
    ELSE EvQArg1[EvQCount] := 2; END_IF;
    EvQCount := EvQCount + 1;
  END_IF;
  IF JogBelt AND NOT PrevJogBelt AND EvQCount < 16 THEN
    EvQCode[EvQCount] := 12; EvQArg1[EvQCount] := 0; EvQArg2[EvQCount] := 0; EvQCount := EvQCount + 1;     (* JOG *)
  END_IF;
END_IF;
PrevDigital := DigitalEStop; PrevEntry := EntryPressed; PrevExit := ExitPressed; PrevLocal := LocalMode;
PrevSafetyOK := SafetyOK; PrevRunCmd := RunCmd; PrevJogBelt := JogBelt;

(* ---------- event ring: newest first, LastSeq skips 0 ---------- *)
FOR qi := 0 TO 15 DO
  IF qi < ANY_TO_INT(EvQCount) THEN
    FOR i := 32 TO 5 BY -1 DO MB_Event[i] := MB_Event[i - 4]; END_FOR;   (* Event1..7 → Event2..8 *)
    EvSeq := (EvSeq MOD 65535) + 1;
    MB_Event[0] := EvSeq;
    MB_Event[1] := EvSeq;
    MB_Event[2] := EvQCode[qi];
    MB_Event[3] := EvQArg1[qi];
    MB_Event[4] := EvQArg2[qi];
  END_IF;
END_FOR;
EvQCount := 0;

(* ---------- HMI link: Sys.HmiHeartbeat changed within 3 s → LineState bit4 ---------- *)
HmiSame := MB_Sys[13] = HmiHbLast;
HmiHbLast := MB_Sys[13];
TON_HmiLink(IN := HmiSame, PT := T#3s);
HmiLinkOk := NOT TON_HmiLink.Q;
Bit4 := (MB_Sys[2] / 16) MOD 2 = 1;                     (* Prog1 rebuilds the word without bit4 *)
IF HmiLinkOk AND NOT Bit4 THEN MB_Sys[2] := MB_Sys[2] + 16;
ELSIF Bit4 AND NOT HmiLinkOk THEN MB_Sys[2] := MB_Sys[2] - 16; END_IF;

(* ---------- every 100 ms ---------- *)
NTanks := 0;                                            (* every scan: Prog1 writes 2 into MB_Sys[3] each scan *)
IF TankEnabled[1] THEN NTanks := NTanks + 1; END_IF;
IF TankEnabled[2] THEN NTanks := NTanks + 1; END_IF;
MB_Sys[3] := NTanks;                                    (* Sys.TankCount: enabled tanks *)
MB_Sys[4] := TankEnableMaskCopy;

IF Tick THEN
  MB_Sys[5] := CountAccepted;
  MB_Sys[6] := CountRejected;
  MB_Sys[7] := CountTotal;
  MB_Sys[14] := ANY_TO_UINT((NowDs / 10) MOD 65536);    (* Sys.UptimeS *)
  MB_Sys[15] := ActiveContainers;
  MB_Sys[17] := LaneACount;
  MB_Sys[18] := LaneBCount;

  (* throughput: accepted in the last 60 s × 60 / max(10, min(60, uptime)), × 100 *)
  NRecent := 0;
  FOR i := 0 TO 63 DO
    IF i < ANY_TO_INT(AccN) THEN
      IF NowDs - AccDs[i] <= 600 THEN NRecent := NRecent + 1; END_IF;
    END_IF;
  END_FOR;
  SpanS := ANY_TO_REAL(NowDs) / 10.0;
  IF SpanS > 60.0 THEN SpanS := 60.0; END_IF;
  IF SpanS < 10.0 THEN SpanS := 10.0; END_IF;
  Rv := ANY_TO_REAL(NRecent) * 60.0 / SpanS * 100.0;
  IF Rv > 65535.0 THEN Rv := 65535.0; END_IF;
  MB_Sys[8] := ANY_TO_UINT(Rv + 0.5);

  (* OEE (metrics.ts computeOee, hmi.ts liveOee) *)
  ElapsedS := ANY_TO_REAL(NowDs) / 10.0;
  DownS := ANY_TO_REAL(DownDs) / 10.0;
  RateMlS := ANY_TO_REAL(TankRateMlPerS_x10) / 10.0;
  IdealS := 4.0 + ANY_TO_REAL(TankCapacityMl) * 0.05 / RateMlS
            + 2.5 * ANY_TO_REAL(5 + NTanks);            (* stations + avg dispense + transit *)
  IF ElapsedS < 1.0 THEN Rv := 1.0; ELSE Rv := ElapsedS; END_IF;
  Avail := 1.0 - DownS / Rv;
  OperS := ElapsedS - DownS; IF OperS < 1.0 THEN OperS := 1.0; END_IF;
  Perf := IdealS * ANY_TO_REAL(CountTotal) / OperS;
  IF Avail < 0.0 THEN Avail := 0.0; END_IF; IF Avail > 1.0 THEN Avail := 1.0; END_IF;
  IF Perf < 0.0 THEN Perf := 0.0; END_IF; IF Perf > 1.0 THEN Perf := 1.0; END_IF;
  IF CountTotal > 0 THEN Qual := ANY_TO_REAL(CountAccepted) / ANY_TO_REAL(CountTotal); ELSE Qual := 0.0; END_IF;
  Overall := Avail * Perf * Qual;
  IF NOT Running THEN Avail := 0.0; Overall := 0.0; END_IF;
  MB_Sys[9]  := ANY_TO_UINT(Avail * 1000.0 + 0.5);
  MB_Sys[10] := ANY_TO_UINT(Perf * 1000.0 + 0.5);
  MB_Sys[11] := ANY_TO_UINT(Qual * 1000.0 + 0.5);
  MB_Sys[12] := ANY_TO_UINT(Overall * 1000.0 + 0.5);

  (* tank block: 6 words per slot *)
  FOR k := 1 TO 2 DO
    b := (k - 1) * 6;
    Flags := 0;
    IF TankEnabled[k] THEN
      Flags := 1;                                                         (* ENABLED *)
      IF TankLevelMl_x10[k] < ANY_TO_UDINT(TankRefillThresholdMl) * 10 OR TankLow[k] THEN Flags := Flags + 4; END_IF;  (* LOW *)
      IF TankLevelMl_x10[k] > 65535 THEN MB_Tank[b] := 65535; ELSE MB_Tank[b] := ANY_TO_UINT(TankLevelMl_x10[k]); END_IF;
    ELSE
      MB_Tank[b] := 0;
    END_IF;
    MB_Tank[b + 1] := TankCapacityMl;
    MB_Tank[b + 2] := Flags;
    MB_Tank[b + 3] := TankRefillThresholdMl;
    MB_Tank[b + 4] := TankRateMlPerS_x10;
    MB_Tank[b + 5] := TankValveOpeningPct;
  END_FOR;

  (* container table: live first, then finished (each oldest first), 5 words per row *)
  Row := 0;
  FOR Pass := 0 TO 1 DO
    LastId := 0;
    FOR n := 0 TO 7 DO
      Pick := -1;                                       (* next smallest id above LastId *)
      FOR s := 0 TO 7 DO
        IF ContState[s] <> 0 AND ContId[s] > LastId THEN
          IF (Pass = 0 AND ContState[s] <= 3) OR (Pass = 1 AND ContState[s] >= 10) THEN
            IF Pick < 0 THEN Pick := s;
            ELSIF ContId[s] < ContId[Pick] THEN Pick := s; END_IF;
          END_IF;
        END_IF;
      END_FOR;
      IF Pick >= 0 AND Row < 8 THEN
        s := Pick; LastId := ContId[s];
        CASE ContState[s] OF
          10: IF ContLane[s] = 1 THEN Status := 27; ELSE Status := 22; END_IF;
          11: IF ContScanRejected[s] THEN Status := 2; ELSE Status := 23; END_IF;
          12: Status := 23;
        ELSE
          CASE ContSt[s] OF
            1: Status := 1;  2: Status := 11;  3: Status := 12;  4: Status := 24;
            5: Status := 25; 6, 7: Status := 21; 8: Status := 26;
          END_CASE;
        END_CASE;
        MB_Cont[Row * 5]     := ContId[s];
        MB_Cont[Row * 5 + 1] := Status;
        MB_Cont[Row * 5 + 2] := ContFill_x10[s];
        MB_Cont[Row * 5 + 3] := ContTarget_x10[s];
        MB_Cont[Row * 5 + 4] := 0;
        Row := Row + 1;
      END_IF;
    END_FOR;
  END_FOR;
  WHILE Row < 8 DO
    FOR i := 0 TO 4 DO MB_Cont[Row * 5 + i] := 0; END_FOR;
    Row := Row + 1;
  END_WHILE;
END_IF;
