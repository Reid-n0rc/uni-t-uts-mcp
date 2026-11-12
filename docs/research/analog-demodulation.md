# Research: analog demodulation (AD) support

Issue #173. Research only: nothing here was run on an instrument, and nothing in this file is verified hardware behavior (see `docs/verified-hardware.md` for that). Every command below comes from the manuals and must be treated as unconfirmed until probed.

Sources (summarised, not copied; both are third-party-hosted PDFs, see `docs/references.md`):

- **PM** = UTS3000B programming manual, 184 pages. Page numbers are the printed "n / 184" footers.
- **UM** = "Spectrum Analyzer Analog Demodulation User's Manual", V1.1, 11 Nov 2025, 64 pages (covers UTS7000A, 5000A, 3000A, 3000T+, 3000B/T and 1000B/T). Page numbers are the printed "n / 64" footers. Its front panel and menu detail is family-wide, so items marked "model data manual" may differ on the UTS3036B.
- **UG** = the UTS3000B/A user's manual (78 pages), only for the option note.

## 1. Module switch

- `:INSTrument[:SELect] {SA|EMI|AD}` and `:INSTrument[:SELect]?` switch and read the measurement function module (PM p.6). `:INSTrument:DEFault` restores the current module's defaults (PM p.6, "No return value"); it is not the same as `*RST` and is not on the denylist, but it throws away that module's settings, so it must not be a routine tool.
- The programming manual lists only three module names. The UM lists more modes on the front panel (IQ analysis, vector signal analysis, real-time, vector network, phase analysis; UM p.11), so the remote list is a subset of the front-panel list and `SELect?` could in principle return a name outside it. A getter must accept only the documented names and report anything else verbatim as an error.
- Each module has its own independent settings and preset ("Each operation mode has its own reset mode", UG p.20, UM p.11). The UM says the front-panel keys change meaning per mode. So entering AD does not carry the SA center frequency, span, RBW, traces or markers across, and returning to SA is expected (not documented) to find the SA state as it was left. This is the first thing to verify live.
- AD preset values (UM p.53-54): AM demodulation selected, center 64 MHz, sweep width 200 kHz, AF start 0 Hz. The same table lists the rest; the SA values of this bench (10 MHz to 3.6 GHz span) will therefore not be what the instrument shows right after entering AD for the first time.
- Which SA commands stop working in AD is not documented. The PM states the AD commands carry an `AM|FM` mode prefix, and the repo's own experience with measurements is the best model: entering a measurement mode made `:OUTPut:STATe` undefined (-113) and switched the tracking generator off, and mode-dependent queries stayed silent (`docs/verified-hardware.md`, "Results with a real signal"; `tests/fakeUts.ts` models this). Expect the same in AD: SA trace, detector, marker-function, limit-line and tracking-generator commands are likely rejected or silent. Treat as UNKNOWN until probed.
- State that must be saved before entering AD and restored on leaving, by analogy with `measure` / `exit_measurement` (#161): module (`:INSTrument:SELect?`), tracking generator output, level and offset (read `:OUTPut:STATe?` first; it is switched off by mode entry in the measurement case), continuous/single sweep, and, if SA parameters turn out not to survive the round trip, center, span, RBW/VBW, reference level, attenuation, preamp, sweep time. Restore by read-back, one resend, then an error naming the field (the existing pattern).
- Concern: a module switch is slow on the front panel (it reloads the module). The settle time is unknown; a first implementation should poll `:INSTrument:SELect?` with `expectSilence` rather than assume a delay.

## 2. Documented AD commands

All SENSe-style AD commands take an `AM|FM` prefix after the root (examples in the PM omit the `[:SENSe]` root, e.g. `:AM:FREQuency:SPAN`). PM page numbers below. The PM documents **AM and FM only**; the UM documents AM, FM and **PM** (phase modulation, UM p.43). The PM's `:AVERage:COUNt?` header mentions `AM|FM|PM|FMSTereo` once (p.158), which hints that PM and FM stereo exist in the firmware but have no documented commands. Do not invent a `PM` prefix.

### Mode and type (PM p.147-148, p.71)

| Command | Notes |
|---|---|
| `:CONFigure?` | current demodulation mode, AM or FM (p.147) |
| `:CONFigure:AM`, `:CONFigure:FM` | switch demodulation type **and restore that type's parameters to defaults** (p.147-148): state-changing, destructive to AD settings |
| `:CONFigure:AM:NDEFault`, `:CONFigure:FM:NDEFault` | the syntax line repeats `:CONFigure:AM` (typo); presumably switch without presetting, but the text does not say so (p.148). Must be probed before use |
| `[:SENSe]:DEMod {OFF|FM|AM}` / `?` | **spectrum-analyzer-mode** "listen" demodulation at the marker, not the AD module (p.71-72; UM-adjacent text in UG p.48 says turning it on puts a cursor at the center frequency and routes audio to the headphone jack). Out of scope here but easy to confuse with AD |

### Frequency and bandwidth (PM p.151-156)

| Command | Range (manual) |
|---|---|
| `[:SENSe]:FREQuency:CENTer <freq>` / `?` | 50 Hz to max minus 50 Hz; 3.6 GHz max on the UTS3036B (p.152). Same header as SA, so the result depends on the module |
| `[:SENSe]:FREQuency:CENTer:STEP[:INCRement]`, `:STEP:AUTO` | step size (p.153) |
| `[:SENSe]:AM\|FM:FREQuency:SPAN <freq>` | RF sweep width 100 Hz to 12.8 MHz (p.152) |
| `[:SENSe]:AM\|FM:BANDwidth[:RESolution] <freq>`, `:AUTO` | RF RBW 100 Hz to 1 MHz, 1-1.5-2-3-5-7.5-10 steps (p.155) |
| `[:SENSe]:AM\|FM:AFSPectrum:FREQuency:STARt` / `:STOP` | modulation spectrum start 0 Hz to 100 MHz minus 100 Hz, stop 100 Hz to 100 MHz (p.151-152; the start text looks garbled) |
| `[:SENSe]:AM\|FM:AFSPectrum:BANDwidth`, `:AUTO` | AF RBW 100 Hz to 1 MHz (p.156) |
| `[:SENSe]:AM\|FM:BANDwidth:CHANnel <freq>` | the demodulation bandwidth (DBW): 400 Hz to 25 MHz (p.156); the range text is ambiguous (two ranges, "stepped with order 5MHz") |
| `[:SENSe]:POWer[:RF]:ATTenuation`, `:ATTenuation:AUTO`, `:GAIN:STATe` | input attenuation 0-51 dB, preamp (p.153-154) |
| `[:SENSe]:CORRection:IMPedance[:INPut][:MAGNitude] {50\|75}`, `:INPut:IMPedance` | input impedance (p.154); on the real unit `:INPut:IMPedance?` is silent and the CORRection alias works (see verified-hardware) |

### Demodulation window timing and averaging (PM p.157-158)

`[:SENSe]:AM|FM:DWSWeep:TIME` (demod-window sweep time, 1 us to 500 ms), `:DEMod:TIME` and `:DEMod:TIME:AUTO` (demodulation time; auto is 36 times the window sweep time per UM p.29), `:AVERage[:STATe]`, `:AVERage:COUNt` (1-999).

### Audio and filters (PM p.158-160)

| Command | Values |
|---|---|
| `[:SENSe]:SPEaker[:STATe] {1\|ON\|0\|OFF}` / `?` | audio on or off (p.158-159); UM p.52 says the audio goes to headphones and loudspeaker |
| `:SYSTem:VOLume <0-100>` / `?` | system volume in percent (PM p.9); the UM says the AD volume is the same value (UM p.53) |
| `[:SENSe]:AM\|FM:LPFilter` | OFF, LPF300, LPF3K, LPF15K, LPF30K, LPF80K, LPF100K, LPF300K (p.159) |
| `[:SENSe]:AM\|FM:HPFilter` | OFF, HPF20, HPF50, HPF300, HPF400 (p.159-160) |
| `[:SENSe]:AM\|FM:BPFilter` | OFF, AWEighting, CWEighting, CCIR1k, CCIR2k, CUNWeighting (p.160) |

The UM says choosing any low-/high-pass filter turns the band-pass filter off and the reverse (UM p.53), so filter setters interact: set one family, read all three back and report the one the instrument switched off as a warning.

### Scope / time-domain display (PM p.149-150)

The AD screen has three windows: 1 RF spectrum, 2 demodulation waveform (the time-domain "scope"), 3 modulation (AF) spectrum (UM p.13, PM p.149). Commands: `:DISPlay:AM|FM:WINDow[1]|2|3:TRACe:Y[:SCALe]:RLEVel` and `:PDIVision`, and `:DISPlay:AM|FM:WINDow3:TRACe:Y[:SCALe]:SPACing {LOGarithmic|LINear}`. Units depend on the window and mode: window 1 dBm and dB; window 2 is modulation depth as a fraction (1 = 100 %) in AM and Hz in FM; window 3 likewise (RLEVel) or dB (PDIVision). There is **no documented command to fetch the demodulated waveform or AF spectrum trace** (no AD `:TRACe:DATA?`, no `:FETCh`/`:READ`); only `:DISPlay:ZBmp?` (p.149, screenshot) and marker readings. The SA trace fetch tool (`get_trace_data`) therefore cannot be assumed to work in AD.

### Markers (PM p.142-147)

Six markers per mode: `:CALCulate:AM|FM:MARKer:SELect`, `MARKer<n>:MODE {OFF|POSition|DELTa|FIXed}`, `:TRACe {RFSPectrum|DEMod|DAVerage|DMAXimum|DMINimum|AFSPectrum}`, `:X`, `:Y`, `:REFerence`, `:MAXimum` (+ `:NEXT`, `:LEFT`, `:RIGHt`), `:MINimum`, `:PTPeak`, `MARKer:AOFF`, `MARKer:TABLe[:STATe]`. X is Hz for RF/AF spectrum and seconds for waveform traces; **Y is dBm on the RF trace, modulation depth as a fraction in AM (1 = 100 %) and frequency deviation in Hz in FM on the waveform traces** (p.143-144). Markers are therefore the only documented way to read modulation depth and FM deviation remotely. Note `:Y` and `:X` have setter forms (marker position), which are not measurements.

### Measurements: gap

The UM shows a result window with modulation depth (positive, negative, (pk-pk)/2) in AM, frequency deviation in FM, phase deviation in rad in PM, plus carrier power, modulation frequency, SINAD, modulation distortion and THD (UM p.15-20, 24, 33, 43). **None of these has a documented SCPI query** in either manual: the PM's AD chapter has no `:FETCh`, `:READ`, `:MEASure` or `:CALCulate:...:RESult` command (the SA chapter's `:FETCh`/`:READ` results do not apply). **Update (2026-11-11): an undocumented query exists and was confirmed live** — see section 6a below. `:FETCh:AM#?`/`:FETCh:FM#?`/`:FETCh:PM#?` return exactly this result window (plus the RF spectrum trace and the raw demod waveform) over SCPI; depth/deviation and SINAD/THD no longer require a screenshot.

### Triggers and sweep control (PM p.150)

Only `:INITiate:CONTinuous {1|ON|0|OFF}` / `?` is documented for AD (p.150; the PM's description line for ON/OFF is a copy-paste typo, both say ON for different meanings). There is **no AD trigger command** in the PM's AD chapter (the `:TRIGger` chapter sits in the SA part, pages 140-141; whether it applies in AD is UNKNOWN). UM mentions that scans start "when the trigger condition is met" and single/continuous (UM p.29), but no trigger source menu is described in the AD chapters. No documented single-sweep/complete sync for AD either: the SA `single_sweep` pattern (`:INITiate:IMMediate`, silence, `*OPC?` poll) is unverified in AD.

### Other

`:MMEMory:LOAD:STATe` / `:STORe:STATe` appear in the AD chapter (p.151); `:MMEMory:STORe` is on the repo denylist and stays blocked. `:DISPlay:ZBmp?` works only with the known 144,800-byte truncation over raw TCP (issue #42); use VXI-11.

## 3. Proposed MCP tools

Naming: `ad_*`. All go through `defineTool`, `validate` first (nothing sent when invalid), `applyCommands` for setters, read-back and `warnings`, try/finally restores, per the AGENTS.md error-handling standard. Read-only = `readOnlyHint: true`.

| Tool | Kind | Parameters | Restore / notes |
|---|---|---|---|
| `get_instrument_module` | read-only | none | `:INSTrument:SELect?`, strict enum SA/EMI/AD, anything else is an error quoting the reply. Safe in any module |
| `enter_analog_demod` | state-changing | `type?: "AM"\|"FM"` | Saves the SA state (section 1), `:INSTrument:SELect AD`, waits until `SELect?` reads AD, optionally selects the type (without `:CONFigure:*` unless `preset: true`). Leaves the instrument in AD on purpose and says so |
| `exit_analog_demod` | state-changing | none | `:INSTrument:SELect SA`, restores the saved SA state by read-back (as `exit_measurement` does); errors name the field. Fails clearly if this server did not enter AD |
| `get_ad_settings` | read-only | none | module, `:CONFigure?`, center, span, RBW, DBW, demod times, averaging, filters, speaker, volume. Fails with "not in AD" when `SELect?` is not AD (nothing else sent) |
| `set_ad_frequency` | state-changing | `center?`, `span?`, `rbw?`/`rbwAuto?`, `demodBandwidth?`, `stepAuto?` | validates documented ranges; warns on clamps; AD only |
| `set_ad_demod_timing` | state-changing | `windowSweepTime?`, `demodTime?`, `demodTimeAuto?`, `averageCount?`, `average?` | ranges 1 us to 500 ms, 1-999 |
| `set_ad_filters` | state-changing | `lowPass?`, `highPass?`, `bandPass?` (enums above) | at most one family; warns about the family the instrument turned off |
| `set_ad_audio` | state-changing | `speaker?: boolean`, `volume?: 0-100` | See risk 3; `speaker: true` requires an explicit `confirm: true`; default off. Restores speaker and volume it changed unless asked to keep |
| `set_ad_display` | state-changing | `window: 1\|2\|3`, `referenceLevel?`, `perDivision?`, `afSpacing?` | unit validation per window and mode |
| `ad_marker` | state-changing | `marker 1-6`, `mode?`, `trace?`, `x?`, `reference?` | AM/FM prefix taken from `:CONFigure?` |
| `ad_marker_search` | state-changing | `marker`, `action: peak\|next\|left\|right\|min\|pkpk` | |
| `get_ad_marker` | read-only | `marker?` | X, Y, trace; returns the unit by trace and mode (Hz/s/dBm/fraction), strict parse |
| `ad_markers_all_off` | state-changing | none | |
| `get_demod_result` | read-only | none | **shipped (#196)**: wraps the undocumented `:FETCh:AM?`/`:FETCh:FM?` metrics-line readback (section 6a), confirmed live. `read_modulation` (marker-based depth/deviation via peak/pkpk) was not built: the results query answers this need directly |

Not proposed: `:CONFigure:AM/FM` as a free-standing tool (destructive preset; only as `preset: true` on `enter_analog_demod`), `:INSTrument:DEFault`, `SELect EMI`, PM/FM-stereo (undocumented), MMEMory.

Existing tools (`set_center_frequency`, `get_trace_data`, `marker_*`, `set_tracking_generator`, `measure`) should refuse or warn when the module is not SA: a cheap `:INSTrument:SELect?` guard, cached per session and invalidated by `enter_analog_demod`/`exit_analog_demod`.

## 4. Risks

1. **Remote-mode lock.** The first ordinary query already locks the front panel until the owner presses Esc (verified-hardware, "Front-panel lock"). Module switching adds nothing new, but a module change while locked is a confusing state for the owner: do not run live AD work without the owner present, and never use `:KEY:` commands to "press" a mode key (forbidden by the brief).
2. **Unsupported queries stall the instrument.** About 2.15 s of ignored commands plus a late -113. Every AD query is unproven on this firmware, so guard each getter with the module check, use fresh connections for probes, wait 2.5 s after any silent query, and let the existing hold-off apply.
3. **Audio side effects.** `:SPEaker ON` plays the demodulated signal on the loudspeaker and headphones at the system volume, which is shared with the rest of the instrument (the UM says the volume "is synchronizing with the system"). A loud or unexpected tone in a shared lab; the volume is not restored on its own. Default off, require confirmation, restore both values, do not raise volume above what was read.
4. **Settings destroyed.** `:CONFigure:AM|FM` and `:INSTrument:DEFault` reset parameters without warning. Never issue them implicitly; document them as destructive.
5. **Manual typos and ambiguities** (all would be wrong if implemented literally): `:CONFigure:AM:NDEFault` syntax shown as `:CONFigure:AM`; `:INITiate:CONTinuous` and `:AVERage[:STATe]` text says ON for both meanings; `MARKer:TABLe[:STATe]` says "1|ON" twice; `:AVERage:COUNt` header spelled `AM|FM|` and its query lists PM and FMSTereo; `BANDwidth:CHANnel` range given twice; the AF start-frequency range text is garbled; examples omit the root and mix `AM` and `AM|FM`; some examples set a marker `:Y` to a dBm value; the `SPACing` example talks about the RF window though it is WINDow3. Trust none of the examples without a live probe; the project rule "do not guess SCPI syntax" applies.
6. **Option may be absent**, then `SELect AD` may be refused, silently ignored or accepted but leave the module unchanged (section 6). The tracking generator option handling (unanswered query means absent) is the precedent.
7. **State loss on exit.** If SA state does not survive the module round trip the restore can fail halfway; use try/finally and say so.
8. **Dropped commands during an AD sweep.** The instrument may drop lines while an AD measurement runs (as in a single sweep in SA); commands could be lost silently. Use read-back for every setter.
9. **Family manual.** The UM spans several series; the 3036B-specific limits (frequency span, DBW, filter list) are "refer to the model's data manual" in places. Use the PM ranges and clamp-versus-error findings from the live check.

## 5. Simulator versus hardware

The fake (`tests/fakeUts.ts`) already models modes (measurements), wrong-mode -113, silent unsupported queries and the clamp/-224 behavior. It can cover, tests first:

- Input validation, enum parsing, range checks, `validate` refusals, the error-handling contract rows (not connected, timeout, write failure, garbage reply, instrument error, partial failure).
- A modeled AD module: `SELect` round trip, per-module state save and restore, AD-only commands giving -113 in SA and vice versa, filter mutual exclusion, speaker/volume restore, marker X/Y units by trace.
- All wiring: tool registration, contract table, docs tests, session lock.

Only hardware can establish: whether the option is installed, how long module switching takes, whether SA state survives the round trip, which SA commands fail in AD, whether the AD commands answer at all (and clamp versus error), `:CONFigure:*:NDEFault`, the real marker Y scale, any hidden measurement queries, dropped commands and sync in AD, audio behavior, and VXI-11 versus raw differences. Fake behavior for those must be tagged ASSUMED, as the fake already does, until recorded in verified-hardware.md.

## 6. Is the option installed? CONFIRMED installed (2026-11-11)

The owner's UTS3036B **has** the analog demodulation option (and separately, EMI). Confirmed live: `:INSTrument AD` (short form of `:INSTrument:SELect AD`) actually switched the mode (`:INSTrument?` read back `AD`, `:SYSTem:ERRor?` stayed `0,"No error"`), and `:INSTrument EMI` likewise switched cleanly. This was found by probing after a private firmware-disassembly repo (`uts3036b-firmware`, run on a separate machine) established that `*OPT?` is wired to the same handler as `*IDN?` (`SCPI_CoreIdnQ`) and so can never report installed options, and that the firmware internally recognizes 11 modes (`SA, IQ, EMI, AD, VSA, RTSA, VNA, PNA, FDD, TDD, NR`), not just the 3 the manuals document. The disassembly also showed *why* the mode-switch probe in section 6 below is safe: `parm_system::mode_switch` checks `Option::state` before switching and, if the mode is inactive/unlicensed, only logs `MODE Inactive.` and returns without touching SCPI's error queue or the current mode — so the original section 6 probe plan (try the switch, read it back, no error either way) holds even without a live check, and is now also confirmed empirically on a licensed unit.

### 6a. AD results readback: `:FETCh:AM#?`/`:FETCh:FM#?`/`:FETCh:PM#?` (confirmed live 2026-11-11)

Confirmed on real hardware, matching the firmware disassembly's predicted suffix map exactly:

| suffix | returns | confirmed live |
|---|---|---|
| 0 | RF spectrum trace (freq, amplitude pairs) | yes |
| 1 (default; bare `:FETCh:AM?` matches) | 15-value metrics line (below) | yes |
| 2 | demodulated waveform, min-hold | yes |
| 3 / 4 / 5 | demodulated waveform, max-hold / current / average | not individually tried; same code path as 2 |
| 6 | audio (AF) spectrum | not tried |

The 15-value metrics line is, in order: center frequency, carrier power, carrier frequency error, modulation rate, **SINAD**, **distortion/total Vrms**, **THD**, then Peak+, Peak-, (Pk-Pk)/2, RMS for the current row and the same four for the max-hold row. Live example (AM, 64 MHz center, no real modulated signal present, so carrier-frequency-error read `nan` as expected): `6.400000000e+07,-9.835685e+01,nan,1.146127224e+01,-1.408944e+01,5.063745e+00,6.787261e-01,...`.

**Caveats found live, not from disassembly:** right after the first `:INSTrument AD` round trip and readback on one TCP connection, a second mode-switch-and-readback pair on that *same* connection got no reply at all (had to reconnect; a fresh connection then showed the instrument itself was fine and had already applied the restore correctly). Treat a mode switch as "may consume the connection's reply slot for longer than a normal setter" — use a fresh connection, or a generous wait (2 s used here), before the next command after `:INSTrument <mode>`. Not yet isolated whether this is specific to leaving AD, entering AD, or any mode switch.

**Actionable for uni-t-uts-mcp:** a read-only `get_demod_result`-style tool (or extending a measurement tool) can report depth/deviation, SINAD, THD and carrier power without a screenshot. Item 7 in the proposal list below (AD results investigation) is answered; keep the screenshot fallback only for the trace/waveform view, not the numeric result.

A batched live check using documented commands only (one session, owner present, hand probing with fresh connections and waits of at least 2.5 s after any silent query; no `:KEY:`, no setters other than the module switch):

1. `*IDN?` (identity only; the model is the only thing needed).
2. `:INSTrument:SELect?` and record the answer (expected SA). Record `:SYSTem:ERRor?` as baseline.
3. Read-only, still in SA: `:OUTPut:STATe?`, `:INITiate:CONTinuous?`, center, span, RBW, reference level, attenuation, preamp: the restore list.
4. `:INSTrument:SELect AD`, wait, then `:INSTrument:SELect?`. Result AD means the option is present; SA with an error (-221 or similar) or unchanged means absent; no reply is not a result (retry once after 2.5 s, then conclude absent and say how sure).
5. Only if AD: `:CONFigure?`, `[:SENSe]:FREQuency:CENTer?`, `:AM:FREQuency:SPAN?`, `:AM:BANDwidth:CHANnel?` and a handful of other getters, recording reply, time and the late -113 pattern. Do **not** send `:SPEaker ON` or any volume change.
6. `:INSTrument:SELect SA`, read `SELect?`, then compare every item from step 3 with the originals and restore any that differ. Finish with `:SYSTem:ERRor?` clean, and ask the owner to confirm the panel state (or take a VXI-11 screenshot, see issue #172).

Because that session changes the module, it should be done once, with all probes for the sub-issues below in the same session.

## 7. Proposed split (label `proposal`; not started)

Each fits one context window; each is tests first with docs in the same PR.

1. **AD live probe session**: the batched check in section 6 plus all documented getters and the unknown-state questions; records everything (no serials, no IPs) in verified-hardware.md and corrects this file. Needs hardware and the owner. Blocks all below that touch the instrument.
2. **Module guard and module tools**: `get_instrument_module`, the cached module guard for existing tools, simulator support for `:INSTrument:SELect`.
3. **`enter_analog_demod` / `exit_analog_demod`** with save/restore (after 1 and 2).
4. **AD frequency, bandwidth and timing tools** (`get_ad_settings`, `set_ad_frequency`, `set_ad_demod_timing`).
5. **AD filters and audio** (`set_ad_filters`, `set_ad_audio` with confirmation and volume restore).
6. **AD display and markers** (`set_ad_display`, marker tools and `read_modulation`).
7. **AD results investigation**: find out whether depth, deviation, SINAD, THD and carrier power can be read remotely; screenshot-based fallback; adds AD to the manual testing guide. **Done (#196)**: `get_demod_result` wraps the confirmed-live `:FETCh:AM?`/`:FETCh:FM?` metrics readback (section 6a); the screenshot fallback stays only for the RF/waveform/AF-spectrum trace views, which this tool does not expose.
8. **AD docs and wiki**: tools reference, README table, wiki pages, manual-testing-guide group, roadmap entries (kept small, after the tools exist).
