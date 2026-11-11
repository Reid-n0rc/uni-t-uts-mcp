# Research: EMI function support (UTS3000B)

Status: research only (issue #174). No instrument was used and no code changed. Everything about instrument behavior below is either read from the manuals or marked **UNKNOWN / INFERRED**; nothing here is verified on hardware.

Sources:

- **PM** = UTS3000B Spectrum Analyzer Programming Manual (184 pages; the EMI chapter is pages 94-141; page numbers below are the PDF page numbers).
- **UM** = UNI-T Spectrum Analyzer *EMI User's Manual* V1.1 (48 pages, covers the UTS3000B/T series; page numbers are the printed ones).
- The repo's own findings in `docs/verified-hardware.md` and `docs/programming-guide.md`.

Both manuals are third-party content; this document summarises them and quotes at most one short phrase.

## 1. Summary and recommendation

- The module switch is one command, `:INSTrument[:SELect] {SA|EMI|AD}` (PM p.6). The EMI chapter then documents about 200 commands (PM pp.94-141), almost all with a query form.
- The chapter has **no documented way to read results**: no signal-table query, no meter-value query, no trace data, no FETCh/READ. The only numeric read-backs are marker X/Y (PM pp.95-96), settings queries, and the screen image (`:DISPlay:ZBmp?`, PM p.111). This limits what an MCP server can usefully do (section 5.4).
- Configuration is well covered (scan table, detectors, limit lines, correction factors, search criteria). Controlling a scan is covered but with no documented "finished" signal.
- Whether the owner's UTS3036B has the EMI option is **UNKNOWN** (section 8 shows how to find out).
- Recommendation: do the live probe first (#176), then the module model and guard (#177, #178), then configuration tools, and leave scan control (#186) for last. Twelve small sub-issues are proposed in section 9.

## 2. Module switch

### 2.1 What is documented

- `:INSTrument[:SELect] {SA|EMI|AD}` and the query `:INSTrument[:SELect]?` (reply `SA`, `EMI` or `AD`) switch the measurement function module (PM p.6). `:INSTrument:DEFault` restores the current module (PM p.6).
- The `INSTrument`, `SYSTem` and `KEY` groups (PM pp.6-13) are the "common to every module" commands; module-specific commands start on PM p.13 (SA), p.94 (EMI) and p.142 (analog demodulation).
- Each operating mode has its own preset (UM p.11). The EMI preset (UM pp.36-37) resets to the EMI module defaults: meter/center frequency 515 MHz, start/stop auto 30 MHz/1 GHz, reference level about 107 dBuV, attenuation 10 dB, preamp off, RBW auto 120 kHz, continuous sweep and meter, free-run trigger, trace 1 refresh/peak, average count 100, logarithmic average type. Correction factors and limit lines are kept in memory but switched off.
- EMI and the other modes beyond plain spectrum analysis are options that must be purchased and activated with a license key from a USB drive (System > System Information > add token; UM p.10). Option state is shown in System Information (UM p.38); **no SCPI query for installed options is documented** in the PM.

### 2.2 What entering EMI changes (partly INFERRED)

The PM does not say what happens to SA commands in another module. The repo's hardware findings for the *measurement* sub-modes (`:CONFigure:<meas>`, verified on the UTS3036B) are the best precedent and are assumed to apply, but this is **INFERRED, not verified for `:INSTrument:SELect`**:

- Setters belonging to another module give `-113`; queries belonging to another module get no reply (about 2.15 s stall, `-113` about 4 s later). Existing tools would therefore either fail with timeouts or, worse, hit a same-named command with a different meaning.
- Same name, different meaning in EMI (PM pp.111-124):
  - `[:SENSe]:FREQuency:CENTer` sets the **meter** frequency; the span center is `[:SENSe]:FREQuency:MIDSpan` (PM pp.121-122). `set_frequency` with a center would silently move the meter, not the span.
  - `[:SENSe]:BANDwidth[:RESolution]`, `[:SENSe]:POWer[:RF]:ATTenuation` and `:GAIN:STATe` apply to the **meter**; each scan-table band has its own RBW, attenuation, preamp, sweep time and point count (PM pp.132-136). `[:SENSe]:FREQuency:STARt/STOP` auto-couple to the scan table.
  - Sweep control is split: `:INITiate2:CONTinuous` is the sweep, `:INITiate1:CONTinuous` the meter (PM pp.114-115); the SA `:INITiate:CONTinuous` and `:SENSe:SWEep:TIME` are not in the EMI chapter. Sweep time is per band (`:FSCan:SCAN<n>:TIME`).
  - Reference level and scale have EMI-specific headers: `:DISPlay:FSCan:VIEW:WINDow:TRACe:Y[:SCALe]:RLEVel`, `:PDIVision`, `:RLEVel:OFFSet` (PM pp.112-113), not the SA `:DISPlay:WINDow:...` forms.
  - Trace detectors are `[:SENSe]:FSCan:DETector:TRACe<n>` (PM p.125); EMI has 3 traces ("EMI only have 3 traces", PM p.125; the SA module has 6).
  - Marker X/Y use `:CALCulate:MARKer<n>:X|Y` (PM pp.95-96) with 6 markers; EMI-specific marker commands are under `:CALCulate:FSCan:MARKer...`.
  - Same syntax, same meaning (probably): limit lines (`:CALCulate:LLINe...`, PM pp.105-110), `:UNIT:POWer` (PM p.141), the trigger commands (PM pp.140-141), input impedance (`:INPut:IMPedance` and the `CORRection:IMPedance` alias, PM p.123).
- Which SA commands stop working: **UNKNOWN**. Expect everything without an EMI counterpart (SA measurements `:CONFigure:<meas>`, `:FETCh`/`:READ`, `:SENSe:SWEep:*`, trace data, SA detectors, SA marker functions).
- Time to switch, whether the screen or the sweep restarts, whether a modal dialog appears for an unlicensed module, and whether the lock behavior changes: **UNKNOWN**.

### 2.3 State to save and restore

Principle (AGENTS.md): read before changing, restore in `finally`, report a failed restore.

1. **Always restore the module.** Save `:INSTrument:SELect?` first (SA in the owner's normal use) and switch back in `finally`. If the connection is lost while in EMI, the owner must press the Mode key on the panel (UM p.11) and Esc for local mode; say so in the error.
2. **SA state around the round trip.** Whether the SA module keeps its state while EMI is active is not documented (the UM says only that each mode has its own preset). Before the first live use, snapshot the SA state (center, span, RBW/VBW with auto flags, sweep time with auto flag, continuous mode, reference level, attenuation, preamp, unit, impedance, trigger, trace types/detectors, tracking generator output/level/offset) and compare after SA -> EMI -> SA. The tracking generator output is the likeliest casualty (entering an SA measurement already switches it off) and matters for safety in an EMI setup.
3. **EMI state that a tool changes.** Read the EMI value first (the `get_emi_settings` snapshot, #179) and restore it afterwards if the tool is a "temporary" operation. Tools whose job is to configure EMI leave the new state and say so.
4. **Never use** `:INSTrument:DEFault` (resets the module), `:CONFigure:MEASure:DEFault` (PM p.111), `:SYSTem:DEFault`, `*RST`, `:KEY:*` or `:SYSTem:LOCK`.

## 3. EMI command groups (PM pp.94-141)

Syntax is abbreviated; `<n>` is an index. Every row has a query form unless it says "action" (no reply, nothing to read back). Ranges are as documented.

### 3.1 Standard, sequence, mode

| Command | Notes | PM |
|---|---|---|
| `[:SENSe]:EMC:STANdard[:SELect] {NONE\|CISPr}` | CISPR fixes RBW to 200 Hz/9 kHz/120 kHz/1 MHz and filter type to EMI (6 dB); NONE allows 1-3-10 RBW steps 1 kHz-3 MHz (UM p.15) | 128 |
| `[:SENSe]:FSCan:SEQuence {SCAN\|SEARch\|SSAMeasure\|SASearch\|SAMeasure\|REMeasure}` | scan only, search only, scan+search+measure, scan+search, search+measure, measure only (UM p.22) | 128-129 |
| `[:SENSe]:FSCan:SEQuence:REMeasure {CURRent\|ALL\|MARKed}` | what the measure step covers | 129 |
| `:CONFigure:COUPle` (action) | all auto/manual switches to auto | 110 |
| `:CONFigure:MEASure:DEFault` (action) | reset the measurement: do not use | 111 |

### 3.2 Scan (sweep) table: 10 bands

`[:SENSe]:FSCan:SCAN<n>:` with n = 1-10 (PM pp.132-136): `STATe` (band enabled), `STARt` (0 Hz to fmax-100 Hz), `STOP` (100 Hz to fmax), `BANDwidth[:RESolution]` and `:AUTO`, `TIME` (1 ms-4 ks) and `:AUTO`, `INPut:ATTenuation` (even dB, 0-50) and `:AUTO`, `POINT` (11 to 40001 on the UTS3000B), `POWer:GAIN[:STATe]`. `[:SENSe]:FSCan:RANGe<n>:PREset {CISA|CISB|CISC|CISD|CISCD|CISE}` (action, no query, PM p.137) loads a CISPR band: A 9-150 kHz, B 150 kHz-30 MHz, C 30-300 MHz, D 300 MHz-1 GHz, CD 30 MHz-1 GHz, E 1 GHz-fmax. fmax is 3.6 GHz on the UTS3036B (PM pp.132-133).

The UM describes silent coupling when bands overlap or the start/stop cross (UM p.21): the instrument moves the neighbor's start/stop or the other end of the band. A tool must read the table back and report changes as warnings.

### 3.3 Detectors, dwell, meters

- Trace detectors (3 traces): `[:SENSe]:FSCan:DETector:TRACe<n> {POSitive|QPEak|CAVerage|AVERage|NEGative}` and `[:SENSe]:DETector:TRACe<n>:AUTO` (PM p.125). Trace type `:TRACe<n>:TYPE {WRITe|AVERage|MAXHold|MINHold}`, `:TRACe<n>:UPDate:STATe`, `:TRACe<n>:DISPlay[:STATe]`, `:TRACe:SELect` (PM pp.138-139).
- Meters (3, live readings in the meter area): `[:SENSe]:METer<n>:DETector` (PM pp.129-130), `[:SENSe]:METer:DETector:DWELl` (1 ms-100 s, one value for all meters), `[:SENSe]:METer:PHOLd:TYPE {ADJustable|INFinite}` and `:PHOLd:ADJustable` (500 ms-100 s) (PM p.130), `:DISPlay:METer<n>[:STATe]` (PM p.112), `:CALCulate:METer<n>:LIMit[:DATA]` and `:LIMit:STATe` (PM p.105), `[:SENSe]:FScan:SLISt:COUPle:METer` and `:CALCulate:FSCan:MARKer:COUPle:METer` (PM pp.105, 131). `:INITiate1:CONTinuous` selects meter single/continuous (PM p.115). Meter frequency, RBW, attenuation, preamp: `[:SENSe]:FREQuency:CENTer`, `:BANDwidth[:RESolution]` (+`:AUTO`), `:POWer[:RF]:ATTenuation` (0-51, +`:AUTO`), `:POWer[:RF]:GAIN:STATe` (PM pp.121-124).
- Final measurement detectors (1-3): `[:SENSe]:FSCan:FINal:DETector<n>`, `:DWELl` (1 ms-60 s), `:LDELta` (which limit line gives the difference column) (PM pp.137-138).
- Averaging: `[:SENSe]:AVERage:COUNt` (1-999) and `:TYPE {VOLTage|POWEr|LOG}` (PM pp.127-128).
- The UM says quasi-peak, EMI average and average are mutually exclusive and at most two can be selected together (UM p.15); the instrument may therefore adjust a detector silently.

### 3.4 Search (peak finding for the signal table)

`[:SENSe]:FSCan:SEARch:MODE {PONLy|PLIMits|SLIMits}` (peak / peak and limit / segment and limit), `:SEARch:PEAK:COUNt` (1-50), `:SEARch:SUBRange:COUNt` (1-50) (PM pp.131-132). Peak criteria: `:CALCulate:FSCan:MARKer:PEAK:THReshold` (-200 to +30 dBm) with `:STATe` (auto/manual) and `:THReshold:LINE[:STATe]`, `:MARKer:PEAK:EXCursion` (0-100 dB) with `:STATe` (PM pp.100-101).

### 3.5 Signal list (peak table)

All actions, none with a read-back (PM pp.96-104): `:CALCulate:FSCan:MARKer<n>[:SET]:SLISt` (marker frequency to list), `:CALCulate:FSCan:MAMarker[:SET]:SLISt` (marker measurement to list), `:SLISt:REPLace:METer <n>`, `:SLISt:APPend:METer`, `:SLISt:DELete:SIGNal <n>`, `:SLISt:MARK:ALL`, `:SLISt:MARK:CLEar:ALL`, `:SLISt:MARK:CLEar:SIGNal <n>`, `:SLISt:MARK:SIGNal <n>`, `:SLISt:SET:METer <n>`, `:SLISt:ZOOM [<n>]` and `:ZOOM:OUT [<n>]`. Queryable: `:SLISt:SORT:TYPE {FREQuency|DAMPlitude1-3|DLDelta1-3}` and `:SLISt:SORT:ORDer {ASCending|DESCending}` (PM pp.103-104). Signal numbers are documented as 1-1000 in one place (PM p.98) and 1-1001 elsewhere. **There is no command to read the signal table.** `:INITiate:FSCan:CLEar:IMMediate` (PM p.115) clears the list and starts.

### 3.6 Markers and peak search

`:CALCulate:FSCan:MARKer:SELect` (1-6), `...MARKer<n>:MODE {OFF|POSition|DELTa|FIXed}`, `...MARKer<n>:TRACe` (1-3), `...MARKer<n>:REFerence`, `:CALCulate:MARKer<n>:X` and `:Y` (readable), `...MARKer:AOFF` (action) (PM pp.94-96); marker/meter transfer actions `...MARKer<n>[:SET]:METer` and `...MARKer<n>:TO:METer` (PM p.97); peak search actions `...MARKer<n>:MAXimum[:MAX]`, `:MAXimum:NEXT`, `:MAXimum:LEFT`, `:MAXimum:RIGHt`, `:MINimum` (PM pp.98-99); `:DISPlay:FSCan:WINDow:MAMarker[:STATe]` (marker measurement window, PM p.112).

### 3.7 Limit lines (6 on the UTS3036B/3084B, 4 on the 1015B)

`:CALCulate:LLINe:SELect`, `:LLINe<n>:DISPlay`, `:TRACe`, `:MARGin`, `:MARGin:STATe`, `:DATA {<freq>,<ampl>,<connect>,...}` (first connect flag 0), `:OFFSet:X`, `:OFFSet:Y` (PM pp.106-109); actions `:LLINe<n>:COPY LLINE<m>`, `:BUILd TRACE<m>`, `:OFFSet:UPDate`, `:DELete`, `:LLINe:ALL:DELete` (PM pp.108-110). The syntax matches the SA limit lines already implemented in `src/tools/limitLines.ts` (point cap in the SA module is 10; **the EMI cap is UNKNOWN**). `LLINe<n>:TRACe` is documented as 1-6 although EMI has only 3 traces (PM p.106; ambiguity).

### 3.8 Correction (antenna/cable factors), 10 slots

`[:SENSe]:CORRection:SELect`, `:CORRection:CSET<n>[:STATe]`, `:CSET<n>:DATA {<freq>,<ampl>,...}` (Hz, dB), `:CSET:ALL[:STATe]` (action: turn all off), `:CSET<n>:DELete`, `:CSET:ALL:DELete` (PM pp.125-127). Point cap **UNKNOWN**.

### 3.9 Sweep control, display, trigger, files

- Run control: `:INITiate:IMMediate`, `:INITiate:RESTart`, `:INITiate:STOP`, `:INITiate:PAUSe`, `:INITiate:RESume` (PM pp.114-115; on SA, STOP/PAUSe/RESume gave `-113`, EMI **UNKNOWN**), `:INITiate:FSCan:CLEar:IMMediate`, `:INITiate2:CONTinuous` (sweep), `:INITiate1:CONTinuous` (meter). UM p.28: pausing is possible only between two bands; with the sequence set to scan-only, single mode stops by itself when the measurement is done.
- Display: `:DISPlay:VIEW:WINDow:TRACe:X:SPACing {LINear|LOGarithmic}`, reference level, scale per division (0.1-20 dB), reference level offset (PM pp.111-113); `:UNIT:POWer {DBM|DBMV|DBUV|V|W}` (PM p.141); `:DISPlay:ZBmp?` (PM p.111).
- Trigger: `:TRIGger[:SEQuence]:SOURce {IMMediate|EXTernal|VIDeo}`, `:EXTernal:SLOPe`, `:EXTernal:DELay`, `:VIDeo:LEVel` (PM pp.140-141).
- Files: `:MMEMory:LOAD|STORe:CORRection|LIMit|STATe|TRACe|SCAN|SLISt` (PM pp.116-119). Out of scope: STORe is forbidden for agents by the project rules and both directions touch the instrument's file system.

## 4. Existing tools versus EMI

Every existing tool targets the SA module. While EMI is active: `set_frequency` (center semantic differs), `set_amplitude`, `set_bandwidth`, `single_sweep`/`wait_for_sweep_complete`, `get_trace_data`, `measure`, markers, `screenshot` (`:DISPlay:ZBmp?` is also an EMI command, PM p.111) and the limit-line tools behave differently or fail. A module guard (#178) is therefore a prerequisite before any module-switching tool ships.

## 5. Proposed tools

All tools follow AGENTS.md: registered with `defineTool`, zod plus explicit validation before sending, setters through `applyCommands`, readback with `warnings`, getters with strict parsing, `errorResult` for every failure (not connected, timeout, write failure, instrument error, malformed reply), tests in the contract table, docs in the same PR. Read-only tools carry `readOnlyHint: true`. Ranges are validated before anything is sent.

### 5.1 Module

| Tool | Kind | Parameters | Notes |
|---|---|---|---|
| `get_instrument_module` | read-only | none | `:INSTrument:SELect?`; reply must be SA, EMI or AD, else error naming the command. |
| `select_instrument_module` | state-changing | `module: sa\|emi\|ad` | Sends the select, reads back, warns if it did not take (for example an unlicensed module). Does not restore: the caller chose the module. Refuses to run while another tool holds the session (existing exclusive lock). Reminds that the panel may stay in remote mode. |

### 5.2 Configuration (EMI module must be active; refuse with an actionable message otherwise)

| Tool | Kind | Parameters | Validation / restore |
|---|---|---|---|
| `get_emi_settings` | read-only | `groups?: [standard, sequence, scan_table, meters, detectors, traces, search, frequency, amplitude, trigger]` | One query per field, strict parsing, a silent query is an error naming the command; never returns partial data as complete. The snapshot used for restore. |
| `set_emi_scan_table` | state-changing | `bands: [{band 1-10, enabled?, start_hz?, stop_hz?, rbw_hz\|rbw_auto?, time_s\|time_auto?, points?, attenuation_db\|attenuation_auto?, preamp?}]`, `preset?: {band, cis: A\|B\|C\|D\|CD\|E}` | start < stop by at least 100 Hz, <= model fmax (from `*IDN?`), points 11-40001, attenuation even 0-50, time 1 ms-4 ks, RBW from the standard-dependent set. Send order: standard first (it changes legal RBWs), start/stop, then the rest; read back the whole table and warn for coupling changes. Leaves the new table. |
| `set_emi_measurement` | state-changing | `standard?, sequence?, remeasure?, trace_detectors?, meter_detectors?, meter_dwell_s?, final_detectors?: [{detector, dwell_s, limit_line}], average_count?, average_type?, search_mode?, peak_count?, segment_count?` | detector set exclusivity checked, dwell ranges (meter 1 ms-100 s, final 1 ms-60 s), counts 1-50 / 1-999; warnings for anything the instrument changed. Leaves new state. |
| `get_emi_limit_line` / `set_emi_limit_line` | read-only / state-changing | as `set_limit_line`, plus `copy_from`, `build_from_trace` | Point cap and clamping must be probed; refuse above the verified cap. |
| `get_emi_correction` / `set_emi_correction` | read-only / state-changing | `slot 1-10`, `points: [{frequency_hz, gain_db}]`, `enabled`, `delete`, `all_off` | Ascending frequency, finite values, point cap probed. A `delete` is confirmed by re-reading. |

### 5.3 Markers and the signal list

| Tool | Kind | Parameters | Notes |
|---|---|---|---|
| `emi_marker` | state-changing (reads X/Y back) | `marker 1-6, mode?, trace 1-3?, reference?, frequency_hz?, amplitude_dbm?, action?: peak\|next\|left\|right\|min\|off_all`, plus peak threshold/excursion settings | The only numeric result read-back in EMI; returns marker X and Y. Marker state is saved and restored only when asked (`restore: true`). |
| `emi_signal_list` | state-changing | `action: add_marker\|add_marker_measurement\|add_meter\|replace_with_meter\|delete\|mark\|mark_all\|clear_marks\|zoom_in\|zoom_out\|sort`, `signal?`, `sort_type?`, `sort_order?` | No action can be read back (section 6). The result says so, and a screenshot (VXI-11 only) is the verification path. |

### 5.4 Run control (last)

| Tool | Kind | Parameters | Notes |
|---|---|---|---|
| `emi_run` | state-changing | `clear_list?, single?: true, timeout_s` | Starts the sequence and waits. There is no documented "finished" query, so the wait is a time estimate (sum of enabled band scan times, plus search and dwell) with a hard cap; no readback of the signal list is possible. Sets `:INITiate2:CONTinuous OFF` first and says if it was ON. |
| `emi_stop` | state-changing | none | `:INITiate:STOP`; **UNKNOWN** whether it answers. |

Not proposed: file load/store (MMEMory), `:INSTrument:DEFault`, `:CONFigure:MEASure:DEFault`, `:SYSTem:DEFault`, front-panel keys or lock. Reading the signal table and meter values is not possible through documented commands, so the server cannot deliver "an EMI result" except marker X/Y, a screenshot, and possibly `:TRACe:DATA?` if it turns out to answer in EMI (undocumented there; probe in #176).

## 6. Risks

1. **Remote-mode lock.** On the UTS3036B the first non-common command locks the panel until the physical Esc key (AGENTS.md, verified-hardware.md "Front-panel lock"). The EMI chapter is all non-common. Ending a run in EMI would also leave the owner's screen in EMI. Mitigation: always restore the module in `finally`, always tell the owner about Esc, never send `:KEY:` or `:SYSTem:LOCK`.
2. **Unsupported queries stall the instrument** (about 2.15 s, lines lost meanwhile, `-113` about 4 s later). All EMI queries are unverified; a probe must use fresh connections and >= 2.5 s after a silent query. Precedents: `:CALCulate:LLINe<n>:DATA?` without points is silent on SA; `:INPut:IMPedance?` is silent but its `CORRection` alias answers (PM p.123 documents both, so probe the alias first).
3. **Setters that cannot be queried back**: the preset band (`RANGe<n>:PREset`), peak-search actions, every signal-list action, marker transfers, `COPY`, `BUILd`, `OFFSet:UPDate`, `DELete`, `CSET:ALL`, `INITiate*`. A tool can only check indirect effects (band start/stop, marker X/Y, limit data) or say it could not verify.
4. **Commands ignored during a scan.** On SA the analyzer drops every line during a single sweep. A full EMI sequence with search and final measurements could take minutes; whether the analyzer ignores commands for that whole time, and whether the owner can interrupt, is unknown. VXI-11 (queued commands, blocking `*OPC?`) may behave better; raw TCP needs a silent wait.
5. **Silent adjustment.** The instrument clamps silently on SA; the UM describes EMI-specific coupling of band edges and detector exclusivity. Readback and warnings are mandatory.
6. **Other-module commands.** Same-named commands with different meaning (section 2.2) are the real danger: a stale SA tool call would change the meter frequency or leave the sweep running. Hence the guard (#178).
7. **Tracking generator.** It shares the RF path; the safe state for an EMI setup is output off. The bench setup connects it to the RF input, so any live EMI test must confirm the TG output is off before and after.
8. **Option may be missing**: select could fail silently, show a dialog or leave the panel in a modal state (UNKNOWN). The first live run needs the owner present.

### 6.1 Ambiguities and typos in the programming manual

- Several on/off descriptions repeat `1|ON` for both states: peak threshold line (PM p.100), `:INITiate1/2:CONTinuous` (single vs continuous, PM pp.114-115), the threshold and excursion `:STATe` descriptions use `1|OFF` (PM pp.100-101), external trigger slope lists POSitive twice (PM p.140). Use the meaning (ON = 1) and verify on hardware.
- The preset band list names `CISE` in the syntax and `CISCE` in the description (PM p.137); the example text says "E" for a D band (CISD, 300 MHz-1 GHz). Probe both spellings.
- `:CALCulate:FSCan:MARKer:PEAK:THReshold` range is "30 dBm to -200 dBm" (PM p.100); the search peak-count example queries the wrong header (PM p.132); the scan-point example returns "2.000" (PM p.136); the example for `RANGe<n>:PREset` is mislabeled.
- Signal numbers 1-1000 (PM p.98) versus 1-1001 (PM pp.102-104). Limit-line trace 1-6 versus 3 EMI traces (PM p.106). Meter attenuation 0-51 dB versus band attenuation even 0-50 dB (PM pp.122, 135). The UM says manual RBW can be 1 Hz to 3 MHz (UM p.27) while the PM and UM p.15 say 1 kHz-3 MHz in steps of 1-3-10 for NONE.
- `:INITiate: RESTart`, `:INITiate: STOP` are printed with a space (PM p.114). Several "Return Format" descriptions are wrong or empty (for example `:SENSe:POWer:GAIN:STATe?`, PM p.123).
- Defaults in the UM are given for the UTS3000B; the PM gives per-model limits for UTS1015B/3036B/3084B (the 3036B is the owner's model: 6 limit lines, fmax 3.6 GHz).

## 7. What the simulator can and cannot cover

Hardware-free (tests/fakeUts.ts plus mocked connection, with every unverified behavior tagged ASSUMED as the repo requires):

- argument validation, command ordering, error paths of every tool (contract table), not-connected/timeout/write-failure/instrument-error/partial-failure modes;
- module bookkeeping: switch, query, guard refusal, restore in `finally` (including restore failure and a connection lost while in EMI);
- readback-and-warn logic (the fake can model silent clamping and band coupling once these are known);
- concurrency (the tool session lock) and the E2E stdio table.

Hardware only:

- whether the EMI option is installed and what select does without it;
- duration and side effects of the module switch, the SA state round trip, tracking-generator state, panel lock;
- reply formats (scientific notation, enum case such as `CISPr`), clamp-versus-error behavior, point caps (limit lines, correction), RBW/attenuation rounding, band coupling;
- which queries are silent in which module; whether `:INITiate:STOP/PAUSe/RESume` answer;
- scan duration, whether commands are ignored during a scan, any completion indication, `:TRACe:DATA?` in EMI, marker X/Y values after a scan;
- screenshot content of the EMI screen.

## 8. Is the option installed? UNKNOWN: batched live check (documented commands only)

No documented SCPI command reports installed options (the PM lists only `*IDN?`-style identification; options are shown in System Information on the panel, UM p.38). A single supervised run can decide it by trying the module switch. Preconditions: owner present, tracking generator off, SA state snapshotted with the existing getters, fresh connection per probe, >= 2.5 s after any silent query, no `:KEY:`, `:SYSTem:LOCK`, `*RST`, `:SYSTem:DEFault`, `:INSTrument:DEFault`, `:MMEMory:STORe`.

1. `*IDN?` (record the model and firmware; omit the serial from any saved output).
2. `:INSTrument:SELect?`: expect `SA`. Take the SA snapshot.
3. `:INSTrument:SELect EMI`, wait about 3 s, `:SYSTem:ERRor?`.
4. `:INSTrument:SELect?` and one EMI-only query each on its own connection: `:SENSe:EMC:STANdard?` (PM p.128, answers NONE or CISPr), `:SENSe:FSCan:SEQuence?` (PM p.128). Optionally a screenshot over VXI-11 to see the EMI screen.
5. Decision table:

| Observation | Meaning |
|---|---|
| select answers `EMI` and the EMI queries answer | EMI available |
| select still answers `SA`, error queue has an entry (or none) and EMI queries are silent | not licensed or switch rejected (cause UNKNOWN) |
| select query silent | module query unsupported in this state; check the panel |
| select answers `EMI` but EMI queries silent | module entered but queries not implemented as documented |

6. `:INSTrument:SELect SA`, confirm `SA`, repeat the SA snapshot and compare every field, check `:SYSTem:ERRor?`, tell the owner to press Esc and to look at the panel (padlock, modal dialog).

This is issue #176; its results go to `docs/verified-hardware.md` and teach the fake.

## 9. Proposed split (all labeled `proposal`, not started)

Each fits one context window (one tool group or module with tests and docs).

| Issue | Title | Depends on | Hardware |
|---|---|---|---|
| #176 | EMI-1: live probe: can EMI be entered, what does the switch do | none | yes |
| #177 | EMI-2: module model in the fake analyzer, `get/select_instrument_module` | #176 preferred | no |
| #178 | EMI-3: module guard for the existing SA tools | #177 | no |
| #179 | EMI-4: `get_emi_settings` | #177 | no |
| #180 | EMI-5: `set_emi_scan_table` | #179 | no |
| #181 | EMI-6: `set_emi_measurement` | #179 | no |
| #182 | EMI-7: EMI limit lines | #177 | partly |
| #183 | EMI-8: EMI correction factors | #177 | partly |
| #184 | EMI-9: EMI markers and peak search | #179 | no |
| #185 | EMI-10: EMI signal list actions | #184 | no |
| #186 | EMI-11: `emi_run` / `emi_stop` | #176, #184 | yes |
| #187 | EMI-12: EMI hardware verification pass | all | yes |

Open question for the owner: given that results (signal table, meter values) cannot be read through documented commands, is a configuration-and-marker-only EMI feature set valuable enough to proceed beyond #176-#178?
