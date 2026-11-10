# Tools Reference

Tools are added as the roadmap (issue #1) progresses. Hardware verification status is in [verified-hardware.md](verified-hardware.md).

## Connection

### `connect`

Connect to a UNI-T UTS analyzer over `auto` (the default: VXI-11 when the analyzer offers it, else raw SCPI/TCP), VXI-11, or raw SCPI/TCP. Verifies the link with `*IDN?` and returns the transport in use and the identification string:

```
Connected to 192.168.1.100
Transport: VXI-11 (device inst0), selected by auto
Device: UNI-T,UTS3036B,<serial>,<firmware>
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `host` | string | No | `UTS_IP` env var | Hostname or IP address (letters, digits, `.`, `-`, `_`, `:` only), or `auto` to find the analyzer with `discover_instruments` first: it connects if exactly one UNI-T analyzer answers on the local subnet(s), and otherwise returns an error that lists what was found (or says none was) and asks for an explicit `host`. The result says the host was auto-selected and shows the model and firmware (quoted) so you can check it; discovery is unauthenticated |
| `port` | integer 1-65535 | No | `UTS_PORT` env var, then `5025` | TCP port of the raw transport. VXI-11 finds its own port through the portmapper (TCP port 111), so an explicit `port` together with `transport: "vxi11"` is an error; a `port` (or `UTS_PORT`) without any transport choice selects `raw` |
| `transport` | `raw`, `vxi11` or `auto` | No | `UTS_TRANSPORT` env var, then `auto` (`raw` when only a port is given) | `raw`: raw SCPI over TCP. `vxi11`: VXI-11 core channel; fails if it cannot be opened. `auto`: VXI-11 if the portmapper on port 111 registers the VXI-11 core program and the link opens, otherwise raw (the reason for the fallback is logged to stderr and shown in the `Transport:` line) |

The VXI-11 device name comes from `UTS_VXI11_DEVICE` (default `inst0`; 1 to 64 characters from letters, digits and `. _ , -`). An invalid `transport`, `UTS_TRANSPORT` or `UTS_VXI11_DEVICE` is an error that names the offending value or variable and sends nothing. Error and timeout messages name the transport when it is not raw, for example `Query timeout after 5000ms for command: :FOO? (over VXI-11)`. Over VXI-11 a blocking `*OPC?` read is used to wait for a sweep (see `single_sweep`), a query timeout is reported about 0.5 s after the requested one, and the link stays up. Large replies are not truncated over VXI-11 (see `scpi_query` and `screenshot`).

`UTS_IP=auto` works the same way (also for the startup auto-connect, which logs the auto-selected host). An explicit `host` parameter always wins over `UTS_IP=auto` and never triggers discovery.

If `UTS_IP` is set, the server also connects automatically at startup, using `UTS_TRANSPORT` and `UTS_VXI11_DEVICE`; a failed auto-connect is logged to stderr and does not stop the server.

### `discover_instruments`

Find UNI-T / VXI-11 analyzers on the local network without knowing their IP address. Read-only: it only identifies, it never changes instrument state. The server broadcasts an ONC RPC portmapper request (UDP port 111, `GETPORT` for the VXI-11 core program 395183, TCP) on each local IPv4 interface (the directed broadcast address of each subnet), collects the answers for a short window, then asks each responder `*IDN?` over VXI-11 (falling back to raw SCPI on TCP 5025) and checks whether port 5025 accepts a connection. The analyzer registers VXI-11 with its portmapper, which is why it answers. Works on Windows, macOS and Linux; no dependencies.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `timeout_ms` | integer 100-10000 | No | `1500` | How long to wait for replies |

Returns JSON: `instruments` (each with `host`, `vxi11`, `vxi11Port`, `raw`, `analyzer`, `idn` with `manufacturer`, `model` and `firmware`, and a `note` when it could not be identified), `notes` (sockets that could not be opened, skipped hosts) and a `hint`. The serial number is deliberately not returned (use `identify` after connecting). `analyzer` is true for a UNI-T maker or a `UTS` model. Finding nothing is not an error.

**Scope and trust.** Discovery never scans: it sends one request per local interface to that subnet's broadcast address (never a range of hosts or ports) and talks only to hosts that answered. It does not cross routers: an analyzer on another subnet is not found by broadcast (give its address to `connect`). The portmapper protocol is unauthenticated, so replies are accepted only from ordinary host addresses inside the subnet of the interface the request left from (not loopback, multicast, broadcast, network or the computer's own address) and only when they name an unprivileged port (1024-65535); the identification text is accepted only if it consists of plain identifier characters and is shown quoted. Anything on your LAN can still pretend to be an analyzer, so check the model and address that discovery or `host: "auto"` reports. The host this server is already connected to is listed but not probed again. Optional mDNS/DNS-SD (`_lxi._tcp`) is not implemented (the analyzer was not verified to advertise it). The tool does not use the shared instrument connection, so it neither waits for nor blocks other tools.

### `disconnect`

Disconnect from the analyzer. Safe to call when not connected. No parameters.

### `identify`

Query `*IDN?` (manufacturer, model, serial number, firmware version). Read-only. No parameters. The output ends with a `Transport:` line naming the transport in use (raw SCPI over TCP or VXI-11). An empty reply or one without four comma-separated fields is an error that quotes the reply.

## Raw SCPI

Escape hatches for commands without a dedicated tool. Syntax is in [programming-guide.md](programming-guide.md).

### `scpi_query`

Send **one** SCPI query (must end in `?`) and return the reply. Read-only: anything that is not a single query is refused (use `scpi_command`). Unsupported queries get no reply from the instrument and time out (over raw the instrument then stalls for about 2 s; over VXI-11 nothing is lost and the `-113` is in the error queue at once). Over VXI-11 the screen image works too: `:DISPlay:DATA?` with `reply: "block"` returns the whole 4 MB bitmap (the first 64 KiB are shown, the rest marked truncated) and `:DISPlay:ZBmp?` the full 200 KB stream, while over raw both stop at 144,800 bytes and time out.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `command` | string | Yes | | e.g. `*IDN?`, `:SWEep:POINts?` |
| `timeout_ms` | integer 1-120000 | No | 5000 (text), 30000 (block) | Reply timeout |
| `reply` | `text` \| `block` | No | `text` | `block` reads an IEEE 488.2 `#` binary block and returns it as base64 (first 64 KiB shown; larger replies are marked truncated) |

Only one query per call: on the UTS3036B a `;`-joined line of queries is answered with a single reply, which would be misread as the answer to the next query.

### `scpi_command`

Send a SCPI command with no reply expected. Queries are refused (use `scpi_query`). Like every setter, it clears the error queue (`*CLS`), sends the command synced with `*OPC?` and then checks `:SYSTem:ERRor?`; an error reported by the instrument (for example `-131 Invalid suffix`) is returned as an error result naming the command.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `command` | string | Yes | | e.g. `:FREQuency:CENTer 1 GHz` |
| `confirm` | boolean | No | `false` | Required to send a command on the safety denylist: `*RST`, `*SAV`, `:SYSTem:DEFault`, `:SYSTem:LOCK`, `:KEY:*:LOCK`, `:SYSTem:COMMunicate:LAN:*` setters, `:SYSTem:CONFigure`, `:MMEMory:STORe`. Only set with the user's approval |

Commands containing CR/LF, control characters or non-ASCII text, unterminated quotes, or malformed `#` blocks are refused.

## Frequency

Units are Hz. Command syntax: [programming-guide.md](programming-guide.md) section 2. Query forms and `Hz`/`GHz`/bare-number setters were verified on the UTS3036B.

### `get_frequency`

Read-only. Returns JSON with `center_hz`, `span_hz`, `start_hz`, `stop_hz`, `center_step_hz`, `center_step_auto` and `offset_hz`. No parameters.

### `set_frequency`

Frequency parameters are coupled, so choose one group per call; the settings are re-read afterwards and anything the instrument changed is listed in `warnings` (including `center_step_auto` and, with `zero_span`, a span that is not 0).

| Parameter | Type | Description |
|-----------|------|-------------|
| `center_hz` | number > 0 | Center frequency (may be combined with `span_hz`; span is set first) |
| `span_hz` | number > 0 | Span (use `zero_span` for zero span) |
| `start_hz` | number >= 0 | Start frequency (alone, or with `stop_hz`) |
| `stop_hz` | number > 0 | Stop frequency; with `start_hz` it must be greater than `start_hz`. The edge that will not cross the other is moved first |
| `full_span` | boolean | Full span; cannot be combined with center/span/start/stop |
| `zero_span` | boolean | Zero span; cannot be combined with center/span/start/stop |
| `center_step_hz` | number > 0 | Center step (turns auto step off) |
| `center_step_auto` | boolean | Automatic center step (not with `center_step_hz`) |
| `offset_hz` | number | Frequency offset |

`center`/`span` and `start`/`stop` cannot be mixed in one call. Before applying, the instrument's error queue is cleared with `*CLS`; afterwards it is checked and any error is returned as an error result (settings may be partially applied).

## Amplitude

Command syntax: [programming-guide.md](programming-guide.md) section 2 (amplitude). Verified on the UTS3036B: see [verified-hardware.md](verified-hardware.md).

### `get_amplitude`

Read-only. Returns JSON with `reference_level` (in the current `power_unit`), `power_unit` (`dBm`, `dBmV`, `dBuV`, `V`, `W`), `scale_per_div_db`, `scale_type` (`logarithmic` or `linear`), `reference_level_offset_db`, `attenuation_db`, `attenuation_auto`, `preamp` and `input_impedance_ohm`. No parameters. The input impedance is read with the `:SENSe:CORRection:IMPedance:INPut:MAGNitude?` alias because `:INPut:IMPedance?` gets no reply.

### `set_amplitude`

All parameters are optional, but at least one is required. The settings are re-read afterwards; values the instrument clamped are listed in `warnings`, and so are a `power_unit`, `scale_type`, `preamp` or `attenuation_auto` it did not take.

| Parameter | Type | Description |
|-----------|------|-------------|
| `power_unit` | `dBm` \| `dBmV` \| `dBuV` \| `V` \| `W` | Power unit (applied first) |
| `reference_level` | number | Reference level in the unit in effect after this call. In dBm the instrument accepts -100 to 30 and clamps the rest; the maximum also depends on attenuation and preamp |
| `scale_per_div_db` | number 0.1-20 | Scale per division |
| `scale_type` | `logarithmic` \| `linear` | Y scale type |
| `reference_level_offset_db` | number | Reference level offset in dB (clamped to +-327.6); it is included in the `reference_level` readback |
| `attenuation_db` | integer 0-51 | Manual attenuation; turns automatic attenuation off |
| `attenuation_auto` | boolean | Automatic attenuation (not with `attenuation_db`). The automatic value follows the reference level and may lag a moment |
| `preamp` | boolean | Preamplifier |
| `input_impedance_ohm` | 50 \| 75 | Input impedance (set through the `:SENSe:CORRection` alias; the `:INPut:IMPedance` setter is not accepted) |

Commands are sent in dependency order (unit, preamp, attenuation, impedance, scale, offset, then reference level) because the reference level is limited by the attenuation and preamp. Numbers are sent without unit suffixes. Before applying, the error queue is cleared with `*CLS`; afterwards it is checked and any error is returned as an error result (settings may be partially applied).

## Bandwidth, sweep and detector

Command syntax: [programming-guide.md](programming-guide.md) section 2. Verified on the UTS3036B: see [verified-hardware.md](verified-hardware.md). All setters clamp silently, so every setter re-reads the state and lists adjusted values in `warnings` (including requested auto flags, enums and trigger source).

### `get_bandwidth` / `set_bandwidth`

`get_bandwidth` (read-only) returns `rbw_hz`, `rbw_auto`, `vbw_hz`, `vbw_auto`, `vbw_rbw_ratio` and `filter_shape` (`gaussian` or `flattop`).

`set_bandwidth` parameters (all optional, at least one): `rbw_hz`, `rbw_auto`, `vbw_hz`, `vbw_auto`, `vbw_rbw_ratio`, `filter_shape`. A manual value turns the matching auto flag off, so `rbw_hz` with `rbw_auto=true` (and likewise for VBW) is rejected. RBW/VBW snap to 1-3-10 steps and clamp to 1 Hz..3 MHz (UTS3036B); the VBW follows RBW times the ratio while VBW is auto. Order sent: shape, RBW, ratio, VBW.

### `get_sweep` / `set_sweep`

`get_sweep` (read-only) returns `sweep_time_s`, `sweep_time_auto`, `sweep_time_rule` (`normal`/`accuracy`), `sweep_type` (`sweep`/`fft`), `sweep_type_auto`, `sweep_points`, `trigger_source` (`immediate`/`video`) and `trigger_video_level_dbm`.

`set_sweep` parameters (all optional, at least one): `sweep_points` (integer 11-40001; this is the trace length), `sweep_time_s` (1 ms-4000 s, turns auto off), `sweep_time_auto`, `sweep_time_rule`, `sweep_type`, `sweep_type_auto`, `trigger_source`, `trigger_video_level_dbm` (-170..30). External trigger is rejected by the instrument and not offered. Order sent: points, type, rule, auto flags, trigger level then source (setting the level selects the video trigger), and the manual sweep time last. Changing the span or RBW re-enables or recomputes automatic sweep time, so re-read after changing them.

### `get_detector` / `set_detector`

Uses `:SENSe:DETector:TRACe<n>` (the plain `:DETector[:FUNCtion]` is for measurements). `get_detector` (read-only) takes an optional `trace` (1-6) and returns `{traces: [{trace, detector, auto}]}`. `set_detector` takes `trace` plus `detector` (`sample`, `positive`, `negative`, `normal`, `average`; turns auto off for that trace) or `auto`.

## Acquisition

Command syntax: [programming-guide.md](programming-guide.md) sections 2 and 9. Verified on the UTS3036B: see [verified-hardware.md](verified-hardware.md). Important: while a single sweep is running the instrument ignores every command (and `*OPC?` does not block), so these tools stay silent for the sweep time and then poll `*OPC?` (`src/acquisition.ts`, `waitForSweepComplete`). `:INITiate:STOP/PAUSe/RESume` are rejected by the instrument and are not offered.

### `get_acquisition` / `set_acquisition`

`get_acquisition` (read-only) returns `continuous` (true = continuous sweep, false = single), `sweep_time_s` and `sweep_time_auto`. `set_acquisition` takes `continuous` (boolean; sends `:INITiate:CONTinuous ON|OFF`), re-reads, and reports a mismatch in `warnings`.

### `single_sweep`

Switches to single mode, runs one sweep and waits until it is complete, so the trace can be read. Optional `timeout_s` (default sweep time + 10 s; a timeout returns an error result). Leaves the instrument in single mode. Over the raw transport it stays silent for the sweep time and polls `*OPC?` (the instrument ignores input while sweeping); over VXI-11 (which queues commands) it writes `*OPC?` once and does one blocking read that returns when the sweep ends.

### `start_sweep` / `wait_for_sweep_complete`

`start_sweep` sends `:INITiate:IMMediate` (`method: "immediate"`, default) or `:INITiate:RESTart`. In single mode `wait` (default true) waits for completion; with `wait: false` call `wait_for_sweep_complete` next (nothing else can be sent meanwhile). In continuous mode the sweep is restarted, not awaited, and a warning says so. `timeout_s` is optional on all three tools.

## Trace

Command syntax: [programming-guide.md](programming-guide.md) section 3 (ambiguities 8 and 9). Trace *data* is read by `get_trace_data` (below). Behavior verified on the UTS3036B: see [verified-hardware.md](verified-hardware.md). Traces are numbered 1-6 on the UTS3036B; the tools use the per-trace forms `:TRACe<n>:...`.

### `get_trace`

Read-only. Optional `trace` (1-6; all six when omitted). Returns `selected_trace`, the global `average_count` and `average_type` (`voltage`, `power`, `log`), and `traces: [{trace, type, update, display}]` where `type` is `write`, `average`, `max_hold` or `min_hold`, `update` is true for a live trace and false for view/hold (frozen), and `display` is whether the trace is shown. Trace math cannot be read: `:CALCulate:MATH?` is not supported and stalls the instrument, so it is never queried.

### `set_trace`

All parameters optional, at least one: `selected_trace` (1-6, `:TRACe:SELect`); `trace` (1-6) with `type`, `update` and/or `display` for that trace (`type`, `update` and `display` require `trace`); `average_count` (integer 1-999, global) and `average_type` (`voltage`, `power`, `log`, global). Sent in this order: select, type, update, display, average type, average count. Everything is re-read; a value the instrument did not take is a `warnings` entry. The average count is validated to 1-999 before sending because the instrument accepts 0 (becomes 1) and 1000 (kept as 1000, not clamped). Changing a trace type, the update state or the average count restarts that trace's hold/average (see `restart_trace`).

### `restart_trace`

Restarts max hold, min hold or averaging. The instrument has no clear-trace command; this tool re-sends `:TRACe<n>:TYPE <current type>`, which was verified to clear and restart the accumulation. `:INITiate:RESTart` and `:INITiate:IMMediate` (`start_sweep`) do **not** restart a hold. Optional `trace` (1-6); without it every trace that is not in `write` type is restarted (and the result says when there was nothing to restart). Returns `restarted: [{trace, type}]` and `warnings`.

### `set_trace_math`

Sends `:CALCulate:MATH TRACE<n>,<op>,TRACE<a>,TRACE<b>,<offset>`. `trace` (1-6), `operation` (`off`, `power_difference`, `power_sum`, `log_difference`, `log_offset`), `operand_a` and `operand_b` (1-6; required unless `off`), `offset_db` (-100..100, only for the two log operations, default 0). The setting cannot be read back (no query), so the result carries `trace_state` (the trace's type/update/display) and a warning; verify through the trace data. Enabling math switches the trace on (update and display true) and `off` does not switch it off again, so restore that with `set_trace`.

### `get_trace_data`

Read-only. Reads the amplitude values of one trace with the computed axis. Parameters (all optional): `trace` (1-6, default the selected trace from `:TRACe:SELect?`; anything else is rejected before anything is sent), `format` (`ascii` default, `real32`, `real64`), `fresh` (default false), `max_points` (integer >= 2), `include_axis` (default true).

Returns compact JSON: `trace`, `trace_type` (`write`, `average`, `max_hold`, `min_hold`), `trace_updating`, `trace_displayed`, `unit` (`dBm`, `dBmV`, `dBuV`, `V`, `W` from `:UNIT:POWer?`), `format`, `points` (`:SENSe:SWEep:POINts?`), `axis`, `summary`, `decimation`, `warnings`, `values` and, with `include_axis`, `frequencies_hz` (or `times_s` in zero span).

- **Axis.** `axis.kind` is `frequency` with `start_hz`, `stop_hz`, `span_hz`, `step_hz`; the point axis is linear, `f_i = start + i*(stop-start)/(points-1)` (one point sits at the start). In **zero span** (start equals stop) there is no frequency axis: `axis.kind` is `time` with `zero_span: true`, `center_hz` and `sweep_time_s`, `times_s` runs from 0 to the sweep time, the summary has `peak_time_s` instead of `peak_frequency_hz`, and a warning says so.
- **Summary** covers the full trace even when the response is decimated: `points`, `finite_points`, `non_finite_points`, `min`, `max`, `mean` (plain mean of the values in the trace's unit, so a mean of dBm values is a log average), `peak_index`, `peak_level` and `peak_frequency_hz`. Non-finite values (NaN or infinity) are returned as `null`, left out of the statistics and reported in `warnings`.
- **Format.** `ascii` is the default: no state change, about 14 KB, 7 significant digits, and the fastest read on the unit. `real32` is a `#4` block of big-endian IEEE 754 floats (about 4 KB) with the same 7 digits as ASCII (REAL32 and ASCII gave identical values on hardware); `real64` (about 8 KB) is the full double. For the binary formats the instrument's `:FORMat` is set for the read and put back in a `finally` (as `ASCii`, the setter form, although the query answers `ASC8`; if something else had set REAL32 or REAL64 before, that format is restored). If the restore fails the error says "Could not restore the data format" and names the command to send with `scpi_command`; a read error and a restore error are both reported.
- **`fresh`.** Runs one single sweep first (the same method as `single_sweep`, valid on both transports) so the values are a complete, current sweep, reads, and switches continuous mode back on if it was on (`fresh.continuous_restored`). If that restore fails the error says so and points to `set_acquisition`. Without `fresh` the values are whatever the trace holds now, which in continuous mode can be a sweep in progress, and a frozen (view/hold) or hidden trace is reported in `warnings`.
- **`max_points`.** When the trace has more points, peak-preserving min/max decimation is applied: the trace is cut into `floor(max_points/2)` equal buckets and the minimum and maximum of each are kept in order, so the global peak and minimum are always in the result. `decimation` says `decimated: true`, `original_points`, `returned_points` and the method; `indices` gives each returned point's index in the full trace; `warnings` repeats it. Nothing is decimated silently.
- **Errors.** A malformed, empty, short or long reply is an error that names the command and quotes the start of the reply (or of the block); a value count different from `:SENSe:SWEep:POINts?` is an error naming both counts; a timeout names the command.
## Markers

Command syntax: [programming-guide.md](programming-guide.md) section 4 (markers). Markers are numbered 1 to 10; every tool validates the number before it touches the instrument. Verified on the UTS3036B: see [verified-hardware.md](verified-hardware.md).

### `get_marker`

Read-only. Optional `marker` (1-10, default 1). Returns `marker`, `mode` (`off`, `normal`, `delta`, `fixed`), `trace` (1-6), and the marker's frequency `x` (Hz; seconds in zero span) and level `y` (current power unit, dBm by default) together. A delta marker also returns `reference_marker`, and its `x` and `y` are relative to that marker. An off marker has `x` and `y` of `null`: the instrument still answers `X?`/`Y?` for it, but with stale values.

### `set_marker`

`marker` (1-10) plus at least one of `mode` (`off`, `normal`, `delta`, `fixed`), `trace` (1-6), `reference_marker` (1-10, another marker; used by delta mode) and `x_hz` (position in Hz, 0 or more). Sent in the order mode, trace, reference, x, then the marker is re-read and returned as `marker` with `warnings` for anything the instrument did not take. The instrument does **not** clamp `x_hz` to the sweep span (a position outside it is accepted and its level is meaningless), and a position set on a marker that is off is ignored (a warning says so): use `mode: "normal"` first or `marker_search`. Setting `reference_marker` on a marker that is off turns it on in delta mode (verified). For a delta marker the position is not compared because the readback is relative.

### `marker_search`

`marker` and `action`: `peak` (`:MAXimum`), `next_peak` (`:MAXimum:NEXT`), `next_left` / `next_right` (`:MAXimum:LEFT` / `:RIGHt`), `minimum` (`:MINimum`) or `peak_to_peak` (`:PTPeak`). Returns the marker (frequency and level together) after the search. A search turns a marker that is off on in normal mode; `peak_to_peak` leaves the marker in delta mode (and says so in `note`). Peaks must satisfy the criteria of `get_peak_criteria`. The search acts on the trace the marker is assigned to and the currently displayed data: use `single_sweep` first for a reproducible result.

### `marker_to_instrument`

`marker` (must be on) and `target`: `center`, `step` (center frequency step; this turns automatic step off), `start`, `stop` or `reference_level`, sent as `:CALCulate:MARKer<n>:SET:<target>`. Returns `target`, the new `value` and its `unit` (`Hz`, or the current power unit for `reference_level`). A marker that is off is refused before anything is sent. The instrument rejects a `center` that would put the span outside its range with `-224`, which is returned as an error.

### `markers_all_off`

No parameters. Sends `:CALCulate:MARKer:AOFF` and reads every marker's mode to confirm; returns `all_off` and `warnings` for any marker still on. The instrument's marker positions and traces keep their last values.

### `get_peak_criteria` / `set_peak_criteria`

Peak search criteria: `threshold_dbm` (a peak must be above it; -200 to 30) and `excursion_db` (a peak must rise this far above its valleys; 0 to 100), each with a `threshold_auto` / `excursion_auto` flag. In automatic mode the instrument computes the value from the trace and reports it. `get_peak_criteria` is read-only and takes no parameters. `set_peak_criteria` needs at least one of the four parameters; giving a value turns that criterion's automatic mode **off** (verified), `*_auto: true` switches it back on and cannot be combined with a value for the same criterion. Values outside the documented ranges are refused before anything is sent; the readback is compared and clamped values are `warnings`.

### `get_marker_function` / `set_marker_function`

A marker's function: `noise` (noise level per Hz at the marker), `band_power` (power in a band around the marker), `band_density` (power density in that band) or `off`. `get_marker_function` is read-only (`marker` 1-10, default 1) and returns `function` and `band_span_hz`. `set_marker_function` needs `marker` and at least one of `function` and `band_span_hz` (Hz, above 0); the span is sent first. The function's result is the marker's level: read it with `get_marker` (`y`). Values the instrument did not take are `warnings`.

### `get_marker_ndb` / `set_marker_ndb`

The N-dB bandwidth measurement of a marker: the width in Hz of the trace around the marker where it is within N dB of the marker level. `get_marker_ndb` (read-only) returns `enabled`, `ndb` (negative dB) and `bandwidth_hz` (`null` while off, because the result query is only sent while on, and `null` when the instrument answers `nan` because the trace does not fall N dB on both sides of the marker). `set_marker_ndb` takes `marker` and at least one of `enabled` and `ndb` (-140 to -0.01, checked before anything is sent); N is sent first. Readback differences are `warnings`.

### `get_frequency_counter` / `set_frequency_counter`

The marker frequency counter: `enabled`, `gate_time_s` and `frequency_hz` (the counted frequency of the selected marker via `:CALCulate:MARKer:FCOunt:X?`, only queried while on; `null` while off or when the instrument reports its invalid value 9.91e37). `get_frequency_counter` is read-only and takes no parameters. `set_frequency_counter` takes `enabled` and/or `gate_time_s` (1e-6 to 0.5 s, checked before anything is sent). Readback differences are `warnings`.

## Measurements

Channel power, time-domain power, occupied bandwidth (OBW), adjacent channel power (ACPR), third-order intercept (TOI), carrier-to-noise ratio (C/N) and harmonics. The instrument has **no query for the active measurement**, and `:CONFigure:<meas>` presets the span, RBW and sweep time (for example span 3 MHz) which `:CONFigure:SANalyzer` does not put back, so these tools save and restore that state and never scan for the active mode (queries the instrument does not answer stall it, and over VXI-11 can drop the link). Spectrum analyzer mode is told by `:SENSe:DETector:TRACe1?`, which only it answers; one measurement is told by `:SENSe:<meas>:AVERage:STATe?`. While a measurement is active most spectrum analyzer queries (detector, trace type) get no reply. A probe that gets no reply costs about 4.5 s (the 1.5 s timeout plus a 3 s pause while the instrument recovers). Measurement names: `channel_power`, `time_power`, `obw`, `acpr` (`:SENSe:ACPower`), `toi`, `cn` (`CNRatio`), `harmonics`.

Parameters (`configure_measurement` and `measure`; `*` = common to all measurements): `average`* (on/off), `average_count`* (integer 1-999), `average_control`* (`exponential`, `repeat`), `average_type`* (`voltage`, `power`, `log`); `integration_bandwidth_hz` (channel_power, acpr or cn, greater than 0; channel_power is clamped by the instrument to 100 Hz-3.61 GHz); `left_limit_s`, `right_limit_s` (time_power only, 0-0.01 s; the instrument clamps the right limit to 10 ms); `percent` (obw only, above 0 up to 1; clamped to 0.9999) and `xdb` (obw only, -100 to -0.1 dB); `carrier_bandwidth_hz` (acpr, greater than 0), `offset_hz` (acpr: adjacent channel offset; cn: noise offset; 0 or more) and `offset_side` (acpr: `both`, `negative`, `positive`); `noise_bandwidth_hz` (cn, greater than 0); `fundamental_hz` (harmonics, greater than 0), `harmonics_count` (harmonics, integer 2-10, counts the fundamental; the preset is 2) and `sweep_time_s` (harmonics, 0.001-100 s). TOI has only the averaging parameters. A parameter for another measurement, or an out-of-range value, is refused before anything is sent. The parameters are read back after setting and anything the instrument changed is a `warnings` entry.

### `get_measurement`

Read-only. Without arguments it asks the one query only spectrum analyzer mode answers and returns `{"measurement": "spectrum_analyzer"}`; if that gets no reply it is an error saying a measurement is active (it does not guess which). With `measurement` set it checks that measurement and returns its parameters; an error means it is not active.

### `configure_measurement`

`measurement` plus optional parameters (above) and `preset` (default true: `:CONFigure:<meas>`; false: `:CONFigure:<meas>:NDEFault`; both change the span, RBW and sweep time). Enters the measurement, sets the parameters, reads them back and leaves the instrument in the measurement. When entered from spectrum analyzer mode the center, span, RBW, VBW, sweep time (each with its auto flag) and continuous-sweep state are saved for `exit_measurement` (`saved_settings: true`). Returns `measurement`, `parameters`, `warnings`, `saved_settings`.

### `read_measurement`

Read-only. `measurement` (must be active, else an error naming the silent query), `timeout_s` (default 30, 1-600) and the flag `fetch`, false by default. `READ` starts the measurement and waits for it (over VXI-11); `fetch: true` returns the latest result at once. **Over raw TCP the instrument ends a `READ` reply without a line terminator, so FETCh is used instead and a warning says so.** Results: channel_power gives `channel_power_dbm` and `power_density_dbm_per_hz`; time_power gives `power_dbm`; obw gives `obw_hz`, `frequency_error_hz`, `xdb_bandwidth_hz` and `total_power_dbm` (queried as separate documented sub-results; the combined OBW reply has seven values of which the manual documents only four; the four are not one atomic snapshot). acpr gives `main_power_dbm`, `lower_power_dbm`, `lower_dbc`, `upper_power_dbm`, `upper_dbc` (a side that is not measured, see `offset_side`, reads `null` with a warning; the combined `:FETCh:ACPower?` has only three values, so the sub-results are queried); cn gives `carrier_dbm`, `noise_dbm`, `cn_db`; toi gives `lower_third_order` and `upper_third_order` (`frequency_hz`, `amplitude_dbm`, `dbc`, `toi_dbm`), `lower_tone` and `upper_tone` (`frequency_hz`, `amplitude_dbm`) from four queries (the documented `:FETCh:TOI:IPT?` gets no reply and is not used; each product carries its TOI); harmonics gives `fundamental` (`frequency_hz`, `amplitude_dbm`), `harmonics` (a list of `order` 2..n with `frequency_hz` and `amplitude_dbc`, n = `harmonics_count`; the instrument pads its lists to 10 values and the tool drops the padding) and `thd_percent`, `thd_dbc`. With several queries per result only the first uses READ (it runs the measurement and waits), the others FETCh that result, so they are not separate measurements. A reply that is not a number list of the expected length (`nan` right after entering a measurement, before its first result) is an error naming the command.

### `exit_measurement`

`restore_settings` (default true). Sends `:CONFigure:SANalyzer`, checks that spectrum analyzer mode answers again and, when `configure_measurement` saved settings, puts the center, span, RBW, VBW, sweep time and continuous state back and verifies them (differences are `warnings`). A measurement entered another way has nothing saved: it only exits and a warning says the span, RBW and sweep time keep the measurement's values. In spectrum analyzer mode with nothing saved it does nothing.

### `measure`

One shot that leaves the instrument as it found it: from spectrum analyzer mode it saves the state, enters `measurement` (with `preset` and the parameters), reads the result with READ (FETCh after a 1.5 s settle over raw TCP), and **always**, even after an error, exits to spectrum analyzer mode, restores the saved state and verifies it (`try/finally`). With the requested measurement already active it only reads and puts any parameters you passed back to their previous values. It refuses when the instrument is in neither spectrum analyzer mode nor the requested measurement (use `exit_measurement`). Returns `measurement`, `result`, `restored`, `warnings`; if the read fails the error says the instrument was restored, and if the restore fails the error says to check with `get_measurement`/`exit_measurement`.

## Screenshot

### `screenshot`

Read-only, no parameters. Captures the analyzer screen (1280 x 800) and returns it as an MCP **image content block** (`image/png`) followed by a text line with the size (about 90 KB, taking about 3 s). It reads the picture format (`:SYSTem:PICture:FORMat?`, `BMP` or `PNG`), selects `PNG`, queries `:DISPlay:DATA?` as a `#` block, checks the PNG signature, and **always restores the original format** (try/finally, also after a failed transfer). If the restore fails the result is an error that says so and still carries the image.

Needs a transport whose large replies arrive complete (`completeLargeBlocks`: VXI-11). Over raw TCP the instrument stops after exactly 144,800 bytes (issue #42), so the tool refuses at once, sends nothing, and the error tells you to reconnect with `transport: "vxi11"` (or `auto`) or set `UTS_TRANSPORT`. Errors name the command: a timeout names `:DISPlay:DATA?`, an unreadable format reply names `:SYSTem:PICture:FORMat?`, an empty or non-PNG reply is rejected, and an instrument error while selecting the format carries its code. The tool does not save files; the client receives the image. The screen shows whatever the instrument displays (including its system information page if open).

## Error handling (all tools)

Tools never throw; failures are `isError` results. A malformed or empty reply names the command and quotes the reply; a timeout names the command; setters report instrument errors with their code and the commands sent, and say when settings may be partially applied (also when the readback after a successful send fails). `single_sweep` failures say when the instrument may have been left in single sweep mode. A dropped connection is reported as `Connection to the spectrum analyzer was lost (<reason>) while sending|querying <command>` and the next call says to use `connect` to reconnect; the command in flight when a setter fails is named as possibly applied. See AGENTS.md "Error handling standard".

## Concurrency (all tools)

An MCP client may send several tool calls at once. The analyzer has one command stream, one global error queue, and ignores every command while a single sweep runs, so interleaved calls would corrupt each other (one call's `*CLS` clearing another's errors, a getter reading half-applied settings, queries lost during a sweep). The server therefore **runs tool calls one at a time per instrument, in the order they arrive (first in, first out)**: every tool is registered through `defineTool` (`src/tools/util.ts`), which runs the whole handler, from the first command to the last readback, as one exclusive session on the connection (`runExclusive` in `src/connection.ts`, `src/sessionLock.ts`). Parallel calls are safe and each one gets its own result and its own errors. This works the same on every transport.

- **A long operation blocks the others.** While `single_sweep` (or `start_sweep` / `wait_for_sweep_complete`) holds the instrument for the sweep time, other calls wait their turn.
- **Instrument busy.** A call that waits longer than the limit fails with `Instrument busy: waited <n> s for another tool call (<tool>) to finish and gave up...`; nothing was sent. Retry later or raise the limit. The limit is the `UTS_BUSY_TIMEOUT_S` environment variable, in seconds (default 120; an invalid value uses the default).
- **Released on every path.** A session ends when its tool returns, fails, times out, or the connection is closed or lost; closing or losing the connection also fails every waiting call (`Connection closed` or `Connection to the spectrum analyzer was lost (...)`). `disconnect` does not wait for a running call.
- **Invalid input is refused first.** Argument errors that need no instrument (schema errors and the tools' pure validation) are returned before waiting for the lock.
- **Limit.** A sweep started with `start_sweep` `wait=false` releases the lock when that call returns, so another call can run while the instrument is still sweeping (and be lost); use `single_sweep` or `start_sweep` with `wait=true` unless you call `wait_for_sweep_complete` next.

## Environment variables

| Variable | Description |
|----------|-------------|
| `UTS_IP` | Analyzer hostname or IP, or `auto` (find it on the local network); enables auto-connect and is the default for `connect` |
| `UTS_PORT` | TCP port of the raw transport, default `5025` |
| `UTS_TRANSPORT` | `auto` (default: VXI-11 if the instrument registers it with the portmapper, else raw), `raw` or `vxi11`; default for the `connect` tool's `transport` parameter. Setting `UTS_PORT` without `UTS_TRANSPORT` means `raw` |
| `UTS_VXI11_DEVICE` | VXI-11 logical device name, default `inst0` |
| `UTS_BUSY_TIMEOUT_S` | How long a tool call waits for another one to finish before failing with `Instrument busy`, in seconds (default `120`); see Concurrency |
