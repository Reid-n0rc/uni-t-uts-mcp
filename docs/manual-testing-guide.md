# Manual testing guide

How to check this server against a real UNI-T UTS spectrum analyzer, tool group by tool group, and how to report what you found. Automated tests use a fake analyzer (`tests/fakeUts.ts`); only a real instrument shows whether the fake, the docs and the firmware agree. The reference run is on a UTS3036B, firmware V1.04.0040 (see [verified-hardware.md](verified-hardware.md)); results from the UTS1000B/T and other UTS3000B models and firmware versions are very welcome.

A test (`tests/unit/manual-testing-guide.test.ts`) fails if a tool registered by the server has no checklist step here, so the checklist cannot drift from the tool list. Parameters and behavior of every tool: [tools-reference.md](tools-reference.md).

## Prerequisites

- A UTS1000B/T or UTS3000B analyzer, powered on, with LAN enabled, on the same network as the computer that runs the server. Note the model and firmware (the `identify` step records them).
- Node.js 22 or newer and either this repository built (`npm ci && npm run build`, then `node build/index.js`) or the package installed as described in the [README](../README.md#install).
- An MCP client that can call tools, or the MCP Inspector (`npm run inspector`). Every step below is one tool call with the parameters shown.
- A short coax cable. The checks that need a signal use the analyzer's own tracking generator connected to the RF input (UTS3036B has the option; skip the tracking generator steps on a model without it, the guide says what to record). Never feed more than the input's rated level.
- About 45 minutes for one transport, twice (raw and VXI-11).

## Safe setup

- **Never put the real IP address or serial number in anything you commit, paste or attach.** Use `UTS_IP` in your client's configuration or shell, and write `192.168.1.100` (a placeholder) in notes. `identify` returns the serial number: blank it (`UNI-T,UTS3036B,<serial>,V1.04.0040`) before pasting. `discover_instruments` never returns it.
- Use a test bench with nothing attached to the RF input except what a step asks for.
- Do not run other software against the analyzer at the same time (web interface, vendor software, other scripts); it has one command stream.
- Close any menu or system page on the analyzer first, and do not touch the front panel while the run is in progress.
- The server never sends `*RST`, `:SYSTem:DEFault`, LAN setters, `:SYSTem:LOCK`, `:KEY:*:LOCK` or `:MMEMory:STORe` unless `scpi_command` is called with `confirm: true`. Do not do that in this guide.

### Remote mode and the front panel (read before you start)

The first ordinary SCPI query puts the analyzer in remote mode, and in remote mode the touch screen and the front-panel buttons are locked until you press the physical **Esc** key on the analyzer. On firmware V1.04.0040 (UTS3036B), what is known:

- A bare connection and `*IDN?` do not lock the panel; the first other query (for example `:SYSTem:LOCK?`, `:KEY:LOCK?` or `:SENSe:FREQuency:CENTer?`) does. Which other headers trigger remote mode is unknown: assume any non-common command does.
- **Never send `:KEY:` commands or queries** (not even `:KEY:LED?` or `:KEY:LOCK?`), and do not use `:SYSTem:LOCK?`, `:KEY:LOCK?` or `:KEY:LED?` to check the lock: the readbacks are unreliable. A `:KEY:` query was probably what locked the panel in the original incident.
- `:SYSTem:LOCK 0`, VXI-11 `device_local` / `device_unlock` and `:KEY:ESC` do not return the analyzer to local mode on this firmware. Only the physical **Esc** key does (power cycling works but resets settings).
- SRQ is unavailable on this firmware: status polling with `*ESE`/`*SRE` and `*OPC` followed by `*ESR?`/`*STB?` never sets the OPC bit, and VXI-11 SRQ was not delivered. The tools wait for a sweep with `*OPC?` instead.
- Because the panel is locked while you test, the checks that need your eyes on the screen (marker position, trace type) use `screenshot` over VXI-11 or the readbacks.
- **Check the lock automatically.** `node scripts/check-panel-lock.mjs` (after `npm run build`, with `UTS_IP` set) takes one VXI-11 screenshot and looks for the padlock icon in the status bar: exit 0 "unlocked", exit 1 "LOCKED: press Esc", exit 2 "unknown" (could not take or read the screenshot; look at the analyzer). It sends only `:DISPlay:DATA?` and changes no setting, but firmware disassembly says this query is not exempt from the lock logic either — it most likely re-locks the panel on every call and shows the frame from just before that (see docs/verified-hardware.md, "SCPI-layer root cause"), so do not treat a bare check as side-effect-free. `node scripts/check-panel-lock.mjs --file shot.png` classifies a saved PNG/BMP.
- **At the very end, run that check and press Esc on the analyzer only if it says LOCKED.** Then confirm the panel responds. If it does not, record the model and firmware and report it (see [Reporting template](#reporting-template)).

## Conventions

- "Raw" is raw SCPI over TCP port 5025 (`transport: "raw"`); "VXI-11" is the VXI-11 core channel (`transport: "vxi11"`, reached through the portmapper on TCP port 111). `connect` with `transport: "auto"` picks VXI-11 when the analyzer offers it. Run the full checklist once per transport and record both.
- Every setter re-reads the instrument and lists values the instrument changed in `warnings`. "OK" in the expected column means no `isError` and an empty `warnings` list unless the step says otherwise.
- After any query that got no reply wait 3 seconds before the next step (the analyzer stalls about 2 s and posts a late `-113`).
- Write down the **original value** of every setting in step S1 before you change it; the restore section at the end puts it all back.
- A deliberate error step ("expect an error") passes when the tool returns an error result that names the command, not when it succeeds.

## Checklist

Columns: step, tool call, expected result, what to record. "Record" means a line in your report (pass/fail plus the value). Step ids are stable; quote them in reports.

### G0. Setup state (run first)

| Step | Action | Expected | Record |
|------|--------|----------|--------|
| S1 | After CN2: `get_frequency`, `get_amplitude`, `get_bandwidth`, `get_sweep`, `get_acquisition`, `get_trace`, `get_detector` with `trace: 1`, `get_tracking_generator`, `get_marker` with `marker: 1`, `get_limit_line` with `line: 1` | All succeed; keep every value. The restore section needs them | The originals, in your notes (not in the report if they identify the site) |

Run S1 once, right after CN2, before any setter. It needs a connection, so do CN1 and CN2 first, then S1, then the rest of the groups.

### G1. Connection

| Step | Action | Expected | Record |
|------|--------|----------|--------|
| CN1 | `discover_instruments` (no arguments), analyzer on the local subnet | The analyzer is listed with `vxi11: true` and `raw: true` and its model and firmware, without a serial number. Finding nothing is not an error | Pass/fail, model, firmware as listed |
| CN2 | `connect` with `host: "192.168.1.100"` (your address), `transport: "raw"` | Success text with the transport, model and firmware, and a note that the panel stays locked until Esc | Pass/fail, connect time |
| CN6 | `list_instruments` | One entry, `connected: true`, `isDefault: true`, the host and transport of CN2; no serial number. (With one analyzer only the single-instrument path can be checked on real hardware; two-instrument behaviour is tested with fakes) | Pass/fail |
| CN3 | `identify` | Four comma-separated fields and a `Transport:` line | Model, firmware (serial blanked) |
| CN4 | `disconnect`, then `identify` | The `identify` call fails with a not-connected message that tells you to call `connect` | Pass/fail |
| CN5 | `connect` with `transport: "vxi11"` (the same host), then `identify` | `Transport:` says VXI-11; the same model and firmware as CN3 | Pass/fail, connect time |
| CN6 | `connect` with `transport: "vxi11"` and `port: 5025` | An error that says VXI-11 finds its own port; nothing is sent | Pass/fail |

### G2. Raw SCPI

| Step | Action | Expected | Record |
|------|--------|----------|--------|
| SC1 | `scpi_query` with `command: "*IDN?"` | The same identification string as `identify` | Pass/fail |
| SC2 | `scpi_query` with `command: ":SENSe:FREQuency:CENTer?"` | A number in Hz | The value |
| SC3 | `scpi_query` with `command: ":SENSe:FREQuency:CENTer; *IDN?"` (not a single query) or `command: ":FREQuency:CENTer 1 GHz"` | Refused before anything is sent (`scpi_query` takes one query only) | Pass/fail |
| SC4 | `scpi_query` with `command: ":SYSTem:ERRor?"` | `0,"No error"` or a stale code from an earlier probe | The reply |
| SC5 | `scpi_command` with `command: ":FREQuency:CENTer 500 MHz"`, then `get_frequency` | No error; `center_hz` is 500000000. Restore in R2 | Pass/fail |
| SC6 | `scpi_command` with `command: "*RST"` and no `confirm` | Refused (safety denylist). Do **not** pass `confirm: true` | Pass/fail |
| SC7 | `scpi_query` with an unsupported query, `command: ":FOO:BAR?"` | An error naming the command after the timeout (about 5 s); over raw the analyzer stalls about 2 s afterwards. Wait 3 s | Pass/fail, time to error, whether a `-113` followed |

### G3. Frequency

| Step | Action | Expected | Record |
|------|--------|----------|--------|
| FR1 | `get_frequency` | `center_hz`, `span_hz`, `start_hz`, `stop_hz` and the step and offset fields, consistent with each other | The original values (needed for R2) |
| FR2 | `set_frequency` with `center_hz: 1e9`, `span_hz: 10e6` | OK; the readback shows 1 GHz and 10 MHz; `start_hz` 995 MHz, `stop_hz` 1005 MHz | Pass/fail |
| FR3 | `set_frequency` with `start_hz: 100e6`, `stop_hz: 200e6` | OK; `center_hz` 150 MHz, `span_hz` 100 MHz | Pass/fail |
| FR4 | `set_frequency` with `full_span: true` | OK; span is the model's full span (3.6 GHz on the UTS3036B) | Span |
| FR5 | `set_frequency` with `center_hz: 1e9` and `full_span: true` | An error (invalid combination), nothing sent | Pass/fail |
| FR6 | `set_frequency` with `center_hz: 1e12` | Clamped by the analyzer: a `warnings` entry names the requested and actual value | Pass/fail, the clamp value |

### G4. Amplitude

| Step | Action | Expected | Record |
|------|--------|----------|--------|
| AM1 | `get_amplitude` | `reference_level`, `power_unit`, scale, attenuation, preamp and `input_impedance_ohm` (50 on the UTS3036B) | The original values (needed for R2) |
| AM2 | `set_amplitude` with `reference_level: -20`, `scale_per_div_db: 5` | OK; readback shows -20 dBm and 5 dB/div | Pass/fail |
| AM3 | `set_amplitude` with `attenuation_db: 10`, then with `attenuation_auto: true` | OK each time; auto off after the first, on after the second | Pass/fail |
| AM4 | `set_amplitude` with `reference_level: 100` | The analyzer clamps (maximum 30 dBm in dBm); a `warnings` entry says so | The clamp value |
| AM5 | `set_amplitude` with `preamp: true`, then `preamp: false` | OK; readback follows. The preamp changes the allowed reference level | Pass/fail |

### G5. Bandwidth, sweep and detector

| Step | Action | Expected | Record |
|------|--------|----------|--------|
| BW1 | `get_bandwidth`, `get_sweep`, `get_detector` | All three read cleanly | The original values (needed for R2) |
| BW2 | `set_bandwidth` with `rbw_hz: 100000`, `vbw_rbw_ratio: 1` | OK; `rbw_auto` is false, RBW 100 kHz | Pass/fail |
| BW3 | `set_bandwidth` with `rbw_hz: 12345` | RBW snaps to the 1-3-10 grid; a `warnings` entry names both values | The snapped value |
| BW4 | `set_bandwidth` with `rbw_hz: 100000` and `rbw_auto: true` | Rejected before sending | Pass/fail |
| BW5 | `set_sweep` with `sweep_points: 1001`, `sweep_time_s: 0.1` | OK; points 1001, sweep time 0.1 s, `sweep_time_auto` false | Pass/fail |
| BW6 | `set_sweep` with `sweep_time_auto: true`, then `sweep_type_auto: true` | OK; both auto flags true | Pass/fail |
| BW7 | `set_detector` with `trace: 1`, `detector: "positive"`, then `get_detector` with `trace: 1` | `positive`, auto false. Then `set_detector` with `trace: 1`, `auto: true` | Pass/fail |

### G6. Acquisition

| Step | Action | Expected | Record |
|------|--------|----------|--------|
| AQ1 | `get_acquisition` | `continuous: true` (original state) | Original mode |
| AQ2 | `set_acquisition` with `continuous: false`, then `get_acquisition` | `continuous: false` | Pass/fail |
| AQ3 | `single_sweep` | Completes within the sweep time plus a few seconds; the instrument is left in single mode | Pass/fail, elapsed time |
| AQ4 | `start_sweep` with `wait: false`, then `wait_for_sweep_complete` | Completes; nothing else was sent in between | Pass/fail, elapsed time |
| AQ5 | `start_sweep` with `method: "restart"` (single mode, `wait: true`) | Completes | Pass/fail |
| AQ6 | With a long sweep time (`set_sweep` with `sweep_time_s: 5`), call `single_sweep` | Raw: silent for about 5 s then polls; VXI-11: one blocking wait. Both succeed. Set the sweep time back to auto afterwards | Pass/fail, elapsed time per transport |
| AQ7 | `set_acquisition` with `continuous: true` | Continuous again | Pass/fail |

### G7. Trace

| Step | Action | Expected | Record |
|------|--------|----------|--------|
| TR1 | `get_trace` | Six traces with `type`, `update` and `display`; `average_count` and `average_type` | The original trace states (needed for R2) |
| TR2 | `set_trace` with `trace: 2`, `type: "max_hold"`, `display: true` | OK; readback `max_hold` | Pass/fail |
| TR3 | `restart_trace` with `trace: 2` | OK; the trace accumulation starts over | Pass/fail |
| TR4 | `set_trace` with `average_count: 10`, `average_type: "power"` | OK; readback follows | Pass/fail |
| TR5 | `set_trace_math` with `trace: 3`, `operation: "power_difference"`, `operand_a: 1`, `operand_b: 2` | OK, with a warning that the math setting cannot be read back; then `set_trace_math` with `trace: 3`, `operation: "off"` | Pass/fail |
| TR6 | `single_sweep`, then `get_trace_data` with `trace: 1` | 1001 values (or your point count), a frequency axis from start to stop, a `summary` with min, max, peak | Points, peak frequency and level |
| TR7 | `get_trace_data` with `trace: 1`, `format: "real32"`, then `format: "real64"` | Same values as ASCII to 7 digits (`real32`); the format is restored (`:FORMat?` reads `ASC8`) | Pass/fail |
| TR8 | `get_trace_data` with `trace: 1`, `max_points: 100` | 100 points, the global peak preserved, `decimation.decimated` true | Pass/fail |
| TR9 | `get_trace_data` with `fresh: true` | Runs a sweep first, reads, then continuous mode is back on | Pass/fail |
| TR10 | `set_trace` with `trace: 2`, `type: "write"`, `selected_trace: 1` | OK; trace 2 back to write | Pass/fail |

### G8. Markers

| Step | Action | Expected | Record |
|------|--------|----------|--------|
| MK1 | `get_marker` with `marker: 1` | Mode `off`, `x` and `y` null (or the existing state) | The original marker state (needed for R2) |
| MK2 | `set_marker` with `marker: 1`, `mode: "normal"`, `trace: 1`, `x_hz` inside the span | OK; readback shows the position and the level at it | Pass/fail |
| MK3 | `marker_search` with `marker: 1`, `action: "peak"`, then `"next_peak"`, `"next_left"`, `"next_right"`, `"minimum"` | Each returns the marker at a new position; the peak matches the `peak_frequency_hz` of `get_trace_data` (TR6) | Pass/fail per action |
| MK4 | `set_marker` with `marker: 2`, `mode: "delta"`, `reference_marker: 1` | Delta readout relative to marker 1; then `marker_search` with `marker: 2`, `action: "peak_to_peak"` | Pass/fail |
| MK5 | `get_peak_criteria`, then `set_peak_criteria` with `threshold_dbm: -80`, `excursion_db: 6` | OK; auto flags turn off | Original criteria, pass/fail |
| MK6 | `marker_to_instrument` with `marker: 1`, `target: "center"` | The center frequency becomes the marker frequency (check `get_frequency`). Restore in R2 | Pass/fail |
| MK7 | `markers_all_off` | `all_off: true`, no warnings | Pass/fail |
| MK8 | `get_marker` with `marker: 11` | An error before anything is sent (markers are 1 to 10) | Pass/fail |

### G9. Marker functions

| Step | Action | Expected | Record |
|------|--------|----------|--------|
| MF1 | `set_marker` with `marker: 1`, `mode: "normal"`, then `get_marker_function` | `function` and `band_span_hz` read cleanly | Original function |
| MF2 | `set_marker_function` with `marker: 1`, `function: "noise"` | OK; the function result (noise per Hz) is reported | Value |
| MF3 | `set_marker_function` with `marker: 1`, `function: "band_power"`, `band_span_hz: 1e6`, then `"band_density"`, then `"off"` | OK each time; the span is kept | Values |
| MF4 | `set_marker_ndb` with `enabled: true`, `ndb: -3`, then `get_marker_ndb` | A bandwidth in Hz (null when the trace does not fall 3 dB on both sides); then `enabled: false` | Value |
| MF5 | `set_frequency_counter` with `enabled: true`, `gate_time_s: 0.1`, then `get_frequency_counter` | A counted frequency near the marker (null while off); then `enabled: false` | Value, accuracy against the marker |

### G10. Measurements

These change the span, RBW and sweep time; `measure` and `exit_measurement` put them back. Check `get_frequency`, `get_bandwidth` and `get_sweep` against the originals afterwards.

| Step | Action | Expected | Record |
|------|--------|----------|--------|
| MS1 | `get_measurement` (no arguments) | `{"measurement": "spectrum_analyzer"}` | Pass/fail |
| MS2 | `measure` with `measurement: "channel_power"` | A channel power result (dBm, dBm/Hz) and the instrument back in spectrum analyzer mode with the original span and RBW | Value, pass/fail |
| MS3 | `configure_measurement` with `measurement: "obw"`, then `get_measurement` with `measurement: "obw"` | Parameters read back; the measurement is active | Pass/fail |
| MS4 | `read_measurement` with `measurement: "obw"` (raw: add `fetch: true`) | Occupied bandwidth in Hz. Raw ends a READ reply without a terminator, so the tool uses FETCh and says so in a warning | Value, the warning on raw |
| MS5 | `exit_measurement` | Spectrum analyzer mode; span, RBW, VBW, sweep time and continuous state verified back | Pass/fail |
| MS6 | `measure` with `measurement: "harmonics"`, `"toi"`, `"cn"`, `"acpr"`, `"time_power"` | Each returns a result or a clear error; the state is restored each time (check after the last one) | Pass/fail per measurement |
| MS7 | `read_measurement` with a measurement that is not active | An error naming the silent query | Pass/fail |

### G11. Screenshot

| Step | Action | Expected | Record |
|------|--------|----------|--------|
| SS1 | Raw: `screenshot` | Refused at once: raw truncates at 144,800 bytes and the error says to use VXI-11 | Pass/fail |
| SS2 | VXI-11: `screenshot` | A PNG (1280 x 800, about 90 KB, about 3 s) showing the spectrum; the status bar shows a padlock if the panel is locked | Pass/fail, size, time |
| SS3 | VXI-11: `scpi_query` with `command: ":SYSTem:PICture:FORMat?"` | The format you started with (BMP unless you changed it); `screenshot` restores it | Format before and after |

### G12. Limit lines

| Step | Action | Expected | Record |
|------|--------|----------|--------|
| LL1 | `get_limit_line` with `line: 1` | Reads cleanly; a line without points returns an empty list after a short wait (the instrument sends no reply for it) | The original line (needed for R2) |
| LL2 | `set_limit_line` with `line: 1`, `type: "upper"`, `trace: 1`, `points` of two or three `{frequency_hz, amplitude_dbm}` pairs inside the span, `displayed: true`, `margin_db: 3`, `margin_enabled: true` | OK; the readback matches; the line is visible in a VXI-11 `screenshot` | Pass/fail |
| LL3 | `get_limit_line` with `line: 1` | The same points, margin and type | Pass/fail |
| LL4 | `delete_limit_line` with `line: 1` | `deleted: [1]`; the points are gone (type, trace and margin stay) | Pass/fail |
| LL5 | `set_limit_line` with `line: 7` | An error before anything is sent (lines are 1 to 6) | Pass/fail |

### G13. Tracking generator

Connect the tracking generator output to the RF input. **Always switch the output off at the end.** On a model without the option skip this group; the first query gets no reply and the tools return an error naming `:OUTPut:STATe?`. Record that.

| Step | Action | Expected | Record |
|------|--------|----------|--------|
| TG1 | `get_tracking_generator` | `enabled: false` (original state) plus level, offset, reference trace and normalize | The original values (needed for R2) |
| TG2 | `set_tracking_generator` with `level_dbm: -20`, `enabled: true`, then `single_sweep` and `get_trace_data` | A visible signal across the span (the trace rises well above the noise floor) | Level of the plateau |
| TG3 | `set_tracking_generator` with `level_dbm: 5` | Rejected before anything is sent (range -40 to 0) | Pass/fail |
| TG4 | `set_tracking_generator` with `normalize: true` (output on), then off | OK; a warning if the instrument did not take it | Pass/fail |
| TG5 | `set_tracking_generator` with `enabled: false`, then `get_tracking_generator` | `enabled: false` | Pass/fail |

### G13a. Measurement function module

`select_instrument_module` switches the module and does not restore it, so **always switch back to `sa` at the end of this group**, even if a step warns or errors.

| Step | Action | Expected | Record |
|------|--------|----------|--------|
| IM1 | `get_instrument_module` | `spectrum_analyzer` (the normal starting state) | Pass/fail |
| IM2 | `select_instrument_module` with `module: "emi"` | `module: "EMI"`, no warnings if the EMI option is licensed; otherwise a `warnings` entry saying the readback did not match, and `module` still `SA` | Whether the option is licensed |
| IM3 | `select_instrument_module` with `module: "sa"` | `module: "SA"`, back to the normal state | Pass/fail |
| IM4 | `select_instrument_module` with `module: "iq"` (an invalid enum value) | Rejected before anything is sent | Pass/fail |

### G14. Discovery

| Step | Action | Expected | Record |
|------|--------|----------|--------|
| DS1 | `discover_instruments` again, now with a connection open | The connected host is listed but not probed again | Pass/fail |
| DS2 | `connect` with `host: "auto"` after `disconnect` | Connects when exactly one analyzer answers, shows its model and firmware and says the host was auto-selected | Pass/fail |
| DS3 | `connect` with `host: "auto"` with the analyzer off or on another subnet | An error saying none was found and asking for an explicit `host` | Pass/fail |

### G15. Several analyzers (only with two analyzers; skip with one)

Parallel behaviour is verified hermetically with two fake instruments; this group is the live check for owners who have two analyzers. With one analyzer, CN6 and DS1 are the only live checks of the multi-instrument code paths.

| Step | Action | Expected | Record |
|------|--------|----------|--------|
| MI1 | `connect` with `name: "sa1"` and the first host, then `connect` with `name: "sa2"` and the second host, then `list_instruments` | Both `connected: true`, no `default`; no serial numbers | Pass/fail |
| MI2 | `get_frequency` without `instrument` | An error listing `sa1, sa2` and asking for a name | Pass/fail |
| MI3 | `set_frequency` on `sa1` and `sa2` with different centers in one parallel batch, then `get_frequency` on each | Each analyzer shows its own center | Pass/fail |
| MI4 | `disconnect` with `name: "sa1"`, then `get_frequency` on `sa2` | `sa2` still answers; `sa1` reports not connected | Pass/fail |
| MI5 | `connect` with `name: "sa3"` and `host: "auto"` while `sa2` is connected | Auto-discovery leaves the connected analyzer out; with no other analyzer it says so | Pass/fail |

## Restore to the original state

Do this at the end of each transport pass (and again at the end of the day). Use the values from S1.

| Step | Action | Expected |
|------|--------|----------|
| R1 | `set_tracking_generator` with `enabled: false` (always) | Output off |
| R2 | `set_frequency` with the original center and span (or start and stop); `set_amplitude` with the original reference level, scale, attenuation, preamp and unit; `set_bandwidth` and `set_sweep` with the original RBW, VBW, ratio, sweep time and auto flags (use the auto flags, not the manual values, where they were on); `set_detector`; `set_trace` with each trace's original type, update and display and the original average count and type; `set_trace_math` with `operation: "off"` for any trace you used | Each readback matches the original with no warnings |
| R3 | `markers_all_off`; `delete_limit_line` with `all: true` if limit line 1 was empty at the start (otherwise `set_limit_line` with the original points); `set_marker_function` with `function: "off"` | Markers off, limit lines as found |
| R4 | `set_acquisition` with `continuous: true` | Continuous sweep on |
| R5 | `exit_measurement` if a measurement is active; confirm `get_measurement` returns `spectrum_analyzer` | Spectrum analyzer mode |
| R6 | `scpi_query` with `command: ":SYSTem:ERRor?"` | `0,"No error"` (a stale `-113` from an unsupported-query step is expected: query it again until it clears) |
| R7 | `disconnect` | Disconnected |
| R8 | `node scripts/check-panel-lock.mjs`; **press Esc on the analyzer only if it reports LOCKED** (exit 1) | The check reports unlocked, or after Esc the touch screen and buttons respond again |

The settings the guide never touches (display and system settings, the LAN configuration) are not changed by any step.

## Reporting template

Copy this into an issue or pull request. Blank out the serial number and use `192.168.1.100` for the address.

```text
Model:                 (for example UTS3036B)
Firmware:              (for example V1.04.0040)
Options:               (tracking generator yes/no, others)
Server version:        (from package.json or the `identify` output)
Transport(s) run:      raw / VXI-11 / auto
Client:                (MCP client and version, or Inspector)
Date:
Panel behavior:        (did the first query lock it? did Esc restore it?)

| Group                        | Raw | VXI-11 | Notes (step ids, values, surprises) |
|------------------------------|-----|--------|-------------------------------------|
| G1 Connection                |     |        |                                     |
| G2 Raw SCPI                  |     |        |                                     |
| G3 Frequency                 |     |        |                                     |
| G4 Amplitude                 |     |        |                                     |
| G5 Bandwidth, sweep, detector|     |        |                                     |
| G6 Acquisition               |     |        |                                     |
| G7 Trace                     |     |        |                                     |
| G8 Markers                   |     |        |                                     |
| G9 Marker functions          |     |        |                                     |
| G10 Measurements             |     |        |                                     |
| G11 Screenshot               |     |        |                                     |
| G12 Limit lines              |     |        |                                     |
| G13 Tracking generator       |     |        |                                     |
| G14 Discovery                |     |        |                                     |
| G15 Several analyzers        |     |        |                                     |

Restore verified (R1 to R8):   yes / no, deviations:
Error queue clean at the end:  yes / no
```

Use pass / fail / n.a. per cell. For every failure add the step id, the tool call, the full result text with the serial number and address blanked, and whether it repeats. Record discrepancies from [the manual](references.md) and surprises in [verified-hardware.md](verified-hardware.md) when you are a maintainer; others can send the report as an issue.

## Troubleshooting

| Symptom | Cause | What to do |
|---------|-------|------------|
| A query returns nothing and the tool times out; the next few commands are ignored (raw) | The analyzer does not support that query: it sends no reply, stalls about 2.15 s (lines sent meanwhile are lost) and posts `-113` about 4 s later | Wait at least 2.5 to 3 s before the next step; use a fresh connection when probing by hand; do not treat the timeout as a tool failure |
| `:SYSTem:ERRor?` shows `-113 Undefined header` that no command of yours caused | A stale error from an earlier unsupported query (it arrives seconds later) | Query again until it reads `0`; the tools already ignore a `-113` shortly after a query timeout |
| `ECONNRESET` or "connection closed" on the first call after a long idle time | The analyzer drops idle TCP connections | Call `connect` again (and `disconnect` first if needed); the next call then works |
| `connect` with `auto` or `vxi11` fails or is slow; `discover_instruments` finds nothing | The portmapper on TCP/UDP port 111 is flaky, filtered, or slow on a VPN; the VXI-11 port it reports changes when the analyzer restarts | Open port 111 and the reported port; raise `UTS_VXI11_PROBE_TIMEOUT_S` (total seconds, default 15, up to 120); or use `transport: "raw"` |
| The call fails with `Instrument busy` | Another call (named in the message) holds the instrument, usually a long `single_sweep` | Retry later, shorten the sweep time, or raise `UTS_BUSY_TIMEOUT_S` |
| Commands are lost or `*OPC?` gets no reply right after a sweep starts (raw) | The instrument ignores all input during a single sweep | Use `single_sweep`, `start_sweep` and `wait_for_sweep_complete`, never raw `*OPC?` after `:INITiate:IMMediate` |
| `screenshot` is refused | The transport is raw (it truncates at 144,800 bytes) | Reconnect with `transport: "vxi11"` |
| The touch screen and buttons do not respond | The analyzer is in remote mode | Press **Esc** on the analyzer. Do not try `:SYSTem:LOCK 0`, `device_local` or `:KEY:ESC` (they do nothing on V1.04.0040) |
| A setter returns a `warnings` entry | The analyzer clamps silently (for example reference level above 30 dBm, RBW off the 1-3-10 grid) | Not a failure: record the requested and actual values |

More in the wiki [Troubleshooting](https://github.com/Reid-n0rc/uni-t-uts-mcp/wiki/Troubleshooting) page and in [verified-hardware.md](verified-hardware.md).
