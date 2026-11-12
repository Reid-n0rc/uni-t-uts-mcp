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
| `name` | string (1-32 letters, digits, `_`, `-`) | No | the `default` instrument, or the only one configured | Which instrument to connect. A new name is registered by this call (a first connect that fails leaves it unregistered). The host and port default to the target declared for that name in `UTS_INSTRUMENTS`; `UTS_IP`/`UTS_PORT` belong to `default` only. Connecting a name again replaces only that instrument's link. See `list_instruments` |
| `host` | string | No | `UTS_IP` env var (`default`) or the `UTS_INSTRUMENTS` target of `name` | Hostname or IP address (letters, digits, `.`, `-`, `_`, `:` only), or `auto` to find the analyzer with `discover_instruments` first: it connects if exactly one UNI-T analyzer answers on the local subnet(s), and otherwise returns an error that lists what was found (or says none was) and asks for an explicit `host`. The result says the host was auto-selected and shows the model and firmware (quoted) so you can check it; discovery is unauthenticated |
| `port` | integer 1-65535 | No | `UTS_PORT` env var, then `5025` | TCP port of the raw transport. VXI-11 finds its own port through the portmapper (TCP port 111), so an explicit `port` together with `transport: "vxi11"` is an error; a `port` (or `UTS_PORT`) without any transport choice selects `raw` |
| `transport` | `raw`, `vxi11` or `auto` | No | `UTS_TRANSPORT` env var, then `auto` (`raw` when only a port is given) | `raw`: raw SCPI over TCP. `vxi11`: VXI-11 core channel; fails if it cannot be opened. `auto`: VXI-11 if the portmapper on port 111 registers the VXI-11 core program and the link opens, otherwise raw (the reason for the fallback is logged to stderr and shown in the `Transport:` line) |

The VXI-11 device name comes from `UTS_VXI11_DEVICE` (default `inst0`; 1 to 64 characters from letters, digits and `. _ , -`). An invalid `transport`, `UTS_TRANSPORT` or `UTS_VXI11_DEVICE` is an error that names the offending value or variable and sends nothing. Error and timeout messages name the transport when it is not raw, for example `Query timeout after 5000ms for command: :FOO? (over VXI-11)`. Over VXI-11 a blocking `*OPC?` read is used to wait for a sweep (see `single_sweep`), a query timeout is reported about 0.5 s after the requested one, and the link stays up. Large replies are not truncated over VXI-11 (see `scpi_query` and `screenshot`).

`UTS_IP=auto` works the same way (also for the startup auto-connect, which logs the auto-selected host). An explicit `host` parameter always wins over `UTS_IP=auto` and never triggers discovery. With several instruments, discovery leaves out analyzers that are already connected under another name (they are not probed again or counted), and `UTS_IP=auto` never picks a host that `UTS_INSTRUMENTS` names; if the only analyzer found is already connected the error says so.

If `UTS_IP` is set, the server also connects automatically at startup, using `UTS_TRANSPORT` and `UTS_VXI11_DEVICE`; a failed auto-connect is logged to stderr and does not stop the server.

**Front-panel lock.** The `connect` and `disconnect` results say that the analyzer's touch screen and buttons are locked while it is in remote mode and that the user returns it to local mode with the front-panel Esc key. On a UTS3036B V1.04.0040 over raw TCP, connecting alone, `*IDN?` and `:SYSTem:LOCK?` did not lock the panel, while `:KEY:LOCK?`, `:KEY:LED?` and `:SENSe:FREQuency:CENTer?` did (VXI-11 was not separately isolated). See verified-hardware.md "Front-panel lock".

### `discover_instruments`

Find UNI-T / VXI-11 analyzers on the local network without knowing their IP address. Read-only: it only identifies, it never changes instrument state. The server broadcasts an ONC RPC portmapper request (UDP port 111, `GETPORT` for the VXI-11 core program 395183, TCP) on each local IPv4 interface (the directed broadcast address of each subnet), collects the answers for a short window, then asks each responder `*IDN?` over VXI-11 (falling back to raw SCPI on TCP 5025) and checks whether port 5025 accepts a connection. The analyzer registers VXI-11 with its portmapper, which is why it answers. Works on Windows, macOS and Linux; no dependencies.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `timeout_ms` | integer 100-10000 | No | `1500` | How long to wait for replies |

Returns JSON: `instruments` (each with `host`, `vxi11`, `vxi11Port`, `raw`, `analyzer`, `idn` with `manufacturer`, `model` and `firmware`, and a `note` when it could not be identified), `notes` (sockets that could not be opened, skipped hosts) and a `hint`. The serial number is deliberately not returned (use `identify` after connecting). `analyzer` is true for a UNI-T maker or a `UTS` model. Finding nothing is not an error.

**Scope and trust.** Discovery never scans: it sends one request per local interface to that subnet's broadcast address (never a range of hosts or ports) and talks only to hosts that answered. It does not cross routers: an analyzer on another subnet is not found by broadcast (give its address to `connect`). The portmapper protocol is unauthenticated, so replies are accepted only from ordinary host addresses inside the subnet of the interface the request left from (not loopback, multicast, broadcast, network or the computer's own address) and only when they name an unprivileged port (1024-65535); the identification text is accepted only if it consists of plain identifier characters and is shown quoted. Anything on your LAN can still pretend to be an analyzer, so check the model and address that discovery or `host: "auto"` reports. The host this server is already connected to is listed but not probed again. Optional mDNS/DNS-SD (`_lxi._tcp`) is not implemented (the analyzer was not verified to advertise it). The tool does not use the shared instrument connection, so it neither waits for nor blocks other tools.

### `disconnect`

Disconnect from the analyzer. Safe to call when not connected. Optional `name`: which instrument to disconnect (default: the default one); the others stay connected and the name stays registered, so `connect` with that name reconnects it. An unknown name is an error listing the configured ones. The result reminds the user that the analyzer is not known to return to local mode on its own: if its front panel is still locked, press Esc on the analyzer.

### `list_instruments`

List the instruments this server knows by name: the `default` one (`UTS_IP`), those from `UTS_INSTRUMENTS` and any added by `connect` with a `name`. Read-only, reads the registry only (it never waits for a running sweep), and shows no serial number. No parameters.

Returns JSON: `instruments` (each with `name`, `connected`, `isDefault`, and when connected `connection` (host and port) and `transport`; `configured` shows the host[:port] declared for it) and a `hint`. `isDefault` marks the instrument a call without a name uses: `default` if it exists, else the only one. With several instruments and none called `default`, name the one you mean (`name` for `connect`, `disconnect`, `identify`, and the optional `instrument` argument on every other tool; see [Selecting an instrument](#selecting-an-instrument-all-tools)). `UTS_INSTRUMENTS` is `name=host[:port],name2=...` or JSON (`{"sa1":"192.168.1.100:5026"}`); an invalid value is logged at startup and ignored.

### `identify`

Query `*IDN?` (manufacturer, model, serial number, firmware version). Read-only. Optional `name`: which instrument to query (default: the default one). The output ends with a `Transport:` line naming the transport in use (raw SCPI over TCP or VXI-11). An empty reply or one without four comma-separated fields is an error that quotes the reply.

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

## Limit lines

Command syntax: [programming-guide.md](programming-guide.md) section 5 (limit lines). Lines are numbered 1 to 6 (1 to 4 on the 1000-series models). Verified on the UTS3036B: see [verified-hardware.md](verified-hardware.md). **There is no pass/fail tool:** the manual documents no pass/fail read-back for limit lines. To judge a trace against a line, read both (`get_limit_line` and `get_trace_data`) or take a `screenshot`.

### `get_limit_line`

Read-only. Takes `line` (1-6, default 1) and returns `displayed`, `type` (`upper` or `lower`), `trace` (the trace the line is tested against), `margin_db`, `margin_enabled` and `points` (a list of `frequency_hz`, `amplitude_dbm`, `connected`; the instrument always reports the first point as connected). The analyzer sends no reply at all to the point query of a line without points, so the tool reads it last with a 1.5 s wait and takes that silence as an empty list; a failure of any of the other queries is an error, never an empty line.

### `set_limit_line`

Create or edit a limit line. `line` (1-6, default 1) plus at least one of `displayed`, `type` (`upper`: the trace must stay below the line, `lower`: above), `trace` (1-6), `margin_db` (-40 to 40), `margin_enabled` and `points`. `points` replaces the whole list: 1 to 10 entries of `{frequency_hz, amplitude_dbm, connected?}` in ascending frequency order (equal frequencies make a vertical step; `connected` defaults to true and is ignored for the first point). All of this is checked before anything is sent. The analyzer keeps at most 10 points and silently ignores a longer list, so the tool refuses more than 10. Setting points also turns the line's display on, so `displayed` is sent last; setting the margin switches its state on, so `margin_enabled` is sent after it. The line is read back; anything the instrument did not take is listed in `warnings`.

### `delete_limit_line`

Delete the points of one limit line (`line`) or of all of them (`all: true`); type, trace and margin settings stay. The analyzer finishes a delete a moment after it acknowledges it, so the tool re-reads the points (up to four times, 0.3 s apart) until the line is empty; for `all` it checks line 1. A line that still has points is reported in `warnings`. Returns `deleted` (`[n]` or `"all"`).

## Tracking generator

Command syntax: [programming-guide.md](programming-guide.md) section 6 (the manual calls the tracking generator the "trace source"). Verified on the UTS3036B, which has the option: see [verified-hardware.md](verified-hardware.md#tracking-generator-2026-11-11-issue-22-firmware-v1040040). On an analyzer without the option the first query gets no reply, and both tools then return an error naming `:OUTPut:STATe?` and saying the option is probably not installed; `set_tracking_generator` sends nothing in that case. The message also names the other cause of no answer: a measurement is active. The generator is unavailable in the measurement modes (entering one switches the output off and `:OUTPut:STATe` is undefined there). When this server entered the measurement (`configure_measurement`), both tools say so at once without sending anything: "the tracking generator cannot be changed while a measurement is active ... call exit_measurement first" (not a missing option); `exit_measurement` restores the output that was on.

### `get_tracking_generator`

Read-only. Returns `enabled` (output on/off), `level_dbm`, `level_offset_db`, `reference_trace`, `normalize` and `normalize_ref_level_db`.

### `set_tracking_generator`

Takes at least one of `enabled`, `level_dbm` (-40 to 0), `level_offset_db` (-200 to 200), `reference_trace`, `normalize` and `normalize_ref_level_db` (-100 to 100); ranges are checked before anything is sent (the instrument clamps silently outside them). Level and offset are set before the output is switched on. `reference_trace` only takes while the output is on (otherwise a warning says so). Switching the output off also re-asserts automatic RBW and VBW when they were automatic: the instrument otherwise leaves the RBW at a stale 300 kHz (auto sweep time 264 ms instead of 2.6 ms) with both auto flags still reading on; the tool waits 0.6 s, re-sends the auto commands and warns if the RBW did not return. With the output on the auto sweep time is about 2.15 s. Readback differences are `warnings`. On some benches the output is wired to the analyzer input: switch it off when done.

## Measurement function module

Command syntax: [programming-guide.md](programming-guide.md) section 1 (`:INSTrument[:SELect] {SA|EMI|AD}`). The owner's UTS3036B has the spectrum analyzer (SA), EMI and analog demodulation (AD) modules licensed: see [verified-hardware.md](verified-hardware.md#installed-options-and-ad-results-readback-2026-11-11-firmware-v1040040). No SCPI query reports which modules are licensed; switching to an unlicensed one is refused silently by the firmware (no SCPI error, module unchanged), which is indistinguishable here from a link glitch, so `select_instrument_module` reports a mismatch as a warning, never a guess at the cause.

### `get_instrument_module`

Read-only, safe in any module. Returns `module`: `spectrum_analyzer`, `emi` or `analog_demod`. A reply other than SA/EMI/AD is an error quoting it.

### `select_instrument_module`

`module`: `sa`, `emi` or `ad`. Sends the select and reads it back; does not restore the previous module afterwards (the caller chose the switch) and does not change the front-panel lock behavior beyond that of an ordinary command (see "Front-panel lock" in verified-hardware.md). If the readback does not match what was requested, that is reported as a `warnings` entry, not an error - this is expected when the module is not licensed. A timeout reading the module back names the analyzer's own documented quirk right after a mode switch (a reply can be silently dropped on the same connection even though the switch took); call `get_instrument_module` again, ideally after reconnecting.

**Every other tool that talks to the instrument is spectrum-analyzer-only** (#178, #191): the same-named command often means something different per module (for example `:SENSe:FREQuency:CENTer` under EMI), so before sending anything each one checks the module fresh (no caching across calls) and refuses with an actionable message naming `select_instrument_module` if it is not SA. `get_instrument_module`, `select_instrument_module`, `identify`, `scpi_query`, `scpi_command`, `connect`, `disconnect`, `discover_instruments` and `list_instruments` are exempt, since they must work in any module or send none of their own.

## Analog demodulation module

Command syntax: [programming-guide.md](programming-guide.md) section 1; state save/restore follows `docs/research/analog-demodulation.md` section 1 and the same read-back pattern `exit_measurement` uses. `get_instrument_module`/`select_instrument_module` remain the general-purpose module tools; these two add only the spectrum-analyzer state round trip around `:INSTrument:SELect AD`/`SA`.

### `enter_analog_demod`

Switches to the AD module and reads it back. From spectrum analyzer mode it saves the frequency, bandwidth, sweep time and continuous-sweep settings first (`exit_analog_demod` restores them); calling it again while already in AD keeps whatever was saved the first time rather than overwriting it. If the readback does not match (an unlicensed module is refused silently by this firmware, no SCPI error), that is a `warnings` entry, not an error - the same convention as `select_instrument_module`. Leaves the instrument in AD on purpose. Does not select or preset an AM/FM demodulation type (`:CONFigure:AM`/`:CONFigure:FM` reset that type's parameters and are out of scope here) and does not save or restore the tracking generator (unlike leaving a measurement, nothing confirms the AD module switch touches it).

### `exit_analog_demod`

Switches back to spectrum analyzer mode and, unless `restore_settings` is `false`, restores the settings `enter_analog_demod` saved, verified by read-back with one resend before giving up (same as `exit_measurement`). Always sends the switch, even if this server never called `enter_analog_demod` (for example after `select_instrument_module`); a clear `warnings` entry says so when there is nothing saved to restore, rather than guessing at settings this server never saw.

### `get_ad_settings` / `set_ad_frequency` / `set_ad_demod_timing`

Research-stage: field names and ranges come from the programming manual via [docs/research/analog-demodulation.md](research/analog-demodulation.md) sections 2-3. The AM/FM prefix each AD command needs is read fresh from `:CONFigure?` on every call, rather than assumed, since the demodulation type can change outside this server's own calls. A handful of the getters have been live-verified (`:AM:FREQuency:SPAN?`, `:AM:BANDwidth:CHANnel?`/`:RESolution?`, the AF spectrum start/stop, `:AM:DWSWeep:TIME?`, input impedance - see [verified-hardware.md](verified-hardware.md#ad-live-probe-issue-190-partial-2026-11-11-firmware-v1040040)); `:CONFigure?` itself, the demod-time/averaging getters, every FM-prefixed form, and every setter in this group are **not yet live-verified** - clamp-vs-error behavior is UNKNOWN until probed with the owner present.

`get_ad_settings` is a read-only snapshot: `demod_type`, center frequency and step, RF span, resolution bandwidth, demodulation bandwidth, AF spectrum start/stop and bandwidth, demod window sweep time, demod time and averaging, and input impedance. A silent or malformed reply to any query is an error naming that command - no partial snapshot is ever returned. Filters, audio and display/marker settings are separate tool groups.

`set_ad_frequency` configures `center_hz` (50 Hz to the instrument's max minus 50 Hz, per the manual), `span_hz` (100 Hz-12.8 MHz), `rbw_hz`/`rbw_auto` (100 Hz-1 MHz), `demod_bandwidth_hz` (400 Hz-25 MHz), `center_step_hz`/`center_step_auto`. `set_ad_demod_timing` configures `window_sweep_time_s` (1 us-500 ms), `demod_time_s`/`demod_time_auto`, `average_state`, `average_count` (1-999). Both require at least one parameter, reject `..._auto: true` combined with its matching explicit value, re-read everything requested afterwards, and report any instrument-adjusted value as a `warnings` entry. Neither restores the previous state (the caller chose the change). Both require the AD module.

### `set_ad_filters`

Sets one AD audio filter family: `low_pass_filter` (`OFF`, `LPF300`, `LPF3K`, `LPF15K`, `LPF30K`, `LPF80K`, `LPF100K`, `LPF300K`), `high_pass_filter` (`OFF`, `HPF20`, `HPF50`, `HPF300`, `HPF400`), or `band_pass_filter`/weighting (`OFF`, `AWEighting`, `CWEighting`, `CCIR1k`, `CCIR2k`, `CUNWeighting`) - at most one per call. Per the programming manual, choosing a low- or high-pass filter turns the band-pass filter off and choosing a band-pass filter turns both the low- and high-pass filters off; this tool reads all three before and after the change and reports whichever other family the instrument turned off as a `warnings` entry. The AM/FM prefix is read fresh from `:CONFigure?` each call. Requires the AD module. Not yet live-verified.

### `set_ad_audio`

Sets the AD module's `speaker` (on/off) and/or `volume_pct` (0-100), both read from and shared with the rest of the instrument. **Turning the speaker on, or raising the volume while it is already on, requires `confirm: true`** - `:SPEaker ON` plays the demodulated signal on the loudspeaker and headphones immediately, which would be an unexpected tone in a shared lab ([research doc](research/analog-demodulation.md), risk 3). By default, once the requested change is confirmed by read-back, this tool restores the speaker and volume to what they were immediately before the call (`restored: true` in the result); pass `keep: true` to leave the new state in place instead. Requires the AD module. Not yet live-verified, and intentionally not exercised against real hardware outside a confirmed, supervised live session.

### `get_demod_result`

Read-only numeric result window: center frequency, carrier power, carrier frequency error, modulation rate, SINAD, distortion/total Vrms, THD, and peak+/peak-/(pk-pk)/2/RMS for both the current and max-hold rows, without a screenshot. Wraps the undocumented bare `:FETCh:AM?`/`:FETCh:FM?` query (the 15-value metrics line), confirmed live on this firmware (see [verified-hardware.md](verified-hardware.md), "Installed options and AD results readback", and [research doc](research/analog-demodulation.md) section 6a). The AM/FM type is read fresh from `:CONFigure?` each call. Does not expose the RF spectrum trace, demodulated waveform or AF spectrum views (other `:FETCh` suffixes), which remain screenshot-only. Requires the AD module. Units beyond what the live example confirmed (Hz, dB) are plausible, not independently verified.

### `set_ad_display`

Configures one display `window` (1 RF spectrum, 2 demodulation waveform, 3 AF spectrum)'s Y-axis `reference_level` and/or `per_division`, and (window 3 only) `af_spacing` (`logarithmic`/`linear`). The unit of `reference_level`/`per_division` depends on the window and the current demod type (read fresh from `:CONFigure?`): dBm for window 1, modulation depth as a fraction (AM) or Hz deviation (FM) for window 2, and an unconfirmed unit for window 3 (the programming manual's wording is ambiguous there). Requires at least one parameter and the AD module; `af_spacing` is rejected outside window 3. Re-reads everything requested and reports any instrument-adjusted value as a `warnings` entry. Research-stage, not yet live-verified.

### `ad_marker` / `ad_marker_search` / `get_ad_marker` / `ad_markers_all_off`

AD's marker tools, separate from the spectrum-analyzer module's `set_marker`/`marker_search`/`get_marker`/`markers_all_off`: the AD module has **six** markers per demod type (not SA's ten), and AD-specific trace names (`rf_spectrum`, `demod`, `demod_average`, `demod_max`, `demod_min`, `af_spectrum`) rather than SA's numeric 1-6 trace slots. `x`'s unit is Hz for the two spectrum traces and seconds for the four demodulation-waveform traces; `y`'s unit is dBm on the RF spectrum trace, modulation depth (AM) or Hz deviation (FM) on the waveform traces, and unconfirmed on the AF spectrum trace (the same manual ambiguity as `set_ad_display`'s window 3).

`ad_marker` sets a marker's `mode` (off/normal/delta/fixed), `trace`, `reference_marker` (delta mode) and/or `x`, applied in that order, then re-reads and reports every instrument-adjusted value in `warnings`; a position set while the marker is off is a no-op, reported as a warning rather than silently ignored. `ad_marker_search` runs a `peak`/`next_peak`/`next_left`/`next_right`/`minimum`/`peak_to_peak` search, turning an off marker on. `get_ad_marker` reads one marker's mode, trace, position and value together with their units. `ad_markers_all_off` turns every marker off and confirms it by reading all six. All four require the AD module. Research-stage, not yet live-verified.

## EMI function

Research-stage: field names, ranges and groupings come from the programming manual via [docs/research/emi-function.md](research/emi-function.md); none of it has been verified live yet (EMI-12, #187, needs the owner present at the analyzer). Requires the EMI module (`select_instrument_module`); every tool here refuses with an actionable message otherwise.

### `get_emi_settings`

Read-only snapshot, grouped so one call can stay short: `standard`, `sequence`, `scan_table` (10 bands), `meters`, `detectors`, `traces`, `search`, `frequency`, `amplitude`, `trigger`. The optional `groups` argument selects which to read; by default `scan_table` is omitted (10 bands x ~11 queries each, by far the most expensive group) and every other group is included. A silent or malformed reply to any query is an error naming that command - no partial snapshot is ever returned.

### `set_emi_scan_table`

Edit the EMI module's 10-band scan table. `bands`: an array of per-band edits (`band` 1-10, plus any of `enabled`, `start_hz`, `stop_hz`, `rbw_hz`/`rbw_auto`, `time_s`/`time_auto`, `attenuation_db`/`attenuation_auto`, `points`, `preamp`). `presets`: load a CISPR band into a band (`band`, `cis`: `A` 9 kHz-150 kHz, `B` 150 kHz-30 MHz, `C` 30 MHz-300 MHz, `D` 300 MHz-1 GHz, `CD` 30 MHz-1 GHz, `E` 1 GHz-fmax); applied before any `bands` edit for the same band number. Validated before sending: `stop_hz` must be at least 100 Hz above `start_hz`, `attenuation_db` an even number 0-50, `time_s` between 1 ms and 4000 s, `points` 11-40001 (enforced by the schema). The whole 10-band table is re-read after the edit (before and after, to catch coupling) and the result reports: any field the instrument adjusted away from what was requested, and any band that was **not** requested but whose start/stop moved anyway - the neighbor-band coupling the user manual describes when bands overlap or cross. Requires the EMI module.

### `set_emi_measurement`

Configure the EMI module's measurement. All parameters optional, at least one required: `standard` (`none`/`cispr`; CISPR fixes RBW to 200 Hz/9 kHz/120 kHz/1 MHz and the EMI 6 dB filter, `none` allows 1-3-10 RBW steps 1 kHz-3 MHz), `sequence` (`scan`, `search`, `scan_search_measure`, `scan_search`, `search_measure`, `measure`), `remeasure` (`current`, `all`, `marked`), `trace_detectors`/`meter_detectors` (arrays of `{index, detector}`, trace/meter index 1-3), `meter_dwell_s` (0.001-100 s, one value for all meters), `final_detectors` (array of `{index 1-3, detector?, dwell_s? 0.001-60 s, limit_line? 1-6}`), `average_count` (1-999), `average_type` (`voltage`, `power`, `log`), `search_mode` (`peak_only`, `peak_and_limit`, `segment_and_limit`), `peak_count`/`segment_count` (1-50). `detector` is one of `positive`, `quasi_peak`, `average_continuous`, `average`, `negative`; the user manual documents quasi-peak, EMI average (`average_continuous`) and average as mutually exclusive, at most two together, and this is checked per detector group before anything is sent. Everything requested is re-read afterwards and any instrument-adjusted value is a `warnings` entry. Leaves the new state (nothing is restored). Requires the EMI module.

### `get_emi_limit_line` / `set_emi_limit_line` / `delete_emi_limit_line`

The EMI module's limit lines, reusing the SA limit-line tool's design (same parameters, same `:CALCulate:LLINe<n>` commands). Requires the EMI module. The firmware's own command-callback audit (private `uts3036b-firmware` repo) found that the EMI-prefixed `:CALCulate:FSCan:LLINe<n>...` commands and these plain `:CALCulate:LLINe<n>...` ones share the exact same callback functions as the SA limit-line implementation. Despite the shared callback, the point cap is **not** the same: **live-verified at 12 points** (2026-11-12, EMI-12, #187, owner present), not SA's 10 — 10, 11 and 12 all round-trip exactly; 15 and 20 are both silently truncated to the same 12. `set_emi_limit_line` adds two EMI-specific actions over `set_limit_line`, sent before any other setting: `copy_from` (copies another line's points via `:LLINe<n>:COPY LLINE<m>`; must name a different line) and `build_from_trace` (builds points from a trace's current data via `:LLINe<n>:BUILd TRACE<m>`, trace 1-3 since EMI has only 3 traces). Either action producing no points (an empty source) is a `warnings` entry. `delete_emi_limit_line` is unchanged from `delete_limit_line` beyond the module requirement. See [Limit lines](#limit-lines) above for the rest of the parameters and behavior.

### `get_emi_correction` / `set_emi_correction`

The EMI module's 10 correction (antenna/cable) factor slots (`[:SENSe]:CORRection:CSET<n>`, programming manual pp.125-127). Requires the EMI module. `get_emi_correction` (`slot` 1-10) reads whether the slot is enabled and its point list (`frequency_hz`, `gain_db`). `set_emi_correction` takes `slot` plus any of `points` (replaces the whole list, 1-10 points in ascending frequency order), `enabled` (on/off) or `delete` (clears the slot's points; not combined with `points`); or `all_off`/`delete_all` alone, without `slot`, to turn off or clear every slot at once. The 10-point cap was **live-verified** (2026-11-12, this unit, EMI licensed): writing 10 points round-trips exactly; writing 11 is silently rejected, with no error on `*ESR?`, `*STB?` or `:SYSTem:ERRor?`, and empties the slot's data the same way an over-cap limit-line write does — `set_emi_correction` refuses a request over 10 points locally before sending anything, rather than relying on that silent rejection. The slot is re-read after every change; anything the instrument did not take is a `warnings` entry.

### `get_emi_marker` / `set_emi_marker` / `emi_marker_search` / `emi_markers_all_off` / `get_emi_peak_criteria` / `set_emi_peak_criteria`

EMI module markers (6 markers, 3 traces; programming manual pp.94-99). `:CALCulate:FSCan:MARKer<n>:MODE`/`:TRACe`/`:REFerence` set mode (`off`/`normal`/`delta`/`fixed`), trace and the delta-mode reference marker; marker position and level readback also uses the `FSCan`-prefixed `:CALCulate:FSCan:MARKer<n>:X?`/`:Y?` form, **not** the plain, non-prefixed form the manual's own text suggests — **live-verified 2026-11-12** (EMI-12, #187, owner present): the plain form gets no reply at all on a query and `-113 Undefined header` with no effect on a set, while the `FSCan`-prefixed form works correctly for both. `get_emi_marker` (`marker` 1-6) reads mode, trace, frequency and level together; a delta marker's values are relative to its reference marker, and an off marker reads `x`/`y` as `null`. `set_emi_marker` sets mode/trace/reference_marker/frequency_hz (applied in that order), re-reads, and reports anything the instrument did not take as a `warnings` entry; `frequency_hz` on an off marker has no effect, a `warnings` entry says so. `emi_marker_search` moves a marker with `action`: `peak`, `next`, `left`, `right`, `minimum` (turns an off marker on) and returns its new position. `emi_markers_all_off` turns every marker off and confirms by re-reading all 6. `get_emi_peak_criteria`/`set_emi_peak_criteria` (`:CALCulate:FSCan:MARKer:PEAK:THReshold`/`:EXCursion`, each with a `:STATe` auto flag) are the EMI module's own peak-search criteria, separate from the SA `get_peak_criteria`/`set_peak_criteria` tools. Requires the EMI module.

### `emi_signal_list` / `get_emi_signal_list_sort` / `set_emi_signal_list_sort`

The EMI module's signal table (peak table; programming manual pp.96-104). The manual documents **no command to read the table's contents**, and almost none of these actions has a read-back - `emi_signal_list` can only confirm the command was accepted (no instrument error), never what it actually did; the result says so and names the screenshot tool (over VXI-11) as the visual verification path. `action` is one of: `add_marker` (a marker's frequency to the list, needs `marker` 1-6), `add_marker_measurement` (the measurement marker's value to the list), `replace_with_meter`/`append_meter` (a row from a meter reading; `replace_with_meter` needs `meter` 1-3, `append_meter` takes none per the manual's own listing), `delete`/`mark`/`clear_mark` (need `signal` 1-1000), `mark_all`/`clear_marks`, `set_meter` (couple a marker to a meter, needs `meter`), `zoom_in`/`zoom_out` (`signal` optional). Commands whose argument the manual writes with a leading space (`:SLISt:DELete:SIGNal <n>`, `:SLISt:REPLace:METer <n>`, etc.) are sent as a header plus a separate value, not a numeric header suffix - **inferred from the manual's own notation, not independently live-verified**. `get_emi_signal_list_sort`/`set_emi_signal_list_sort` are the one documented queryable part: sort `type` (`frequency`, or `amplitude`/`delta` relative to trace 1-3) and `order` (`ascending`/`descending`); `set_emi_signal_list_sort` reads both back and reports anything the instrument did not take as a `warnings` entry. Requires the EMI module.

## Measurements

Channel power, time-domain power, occupied bandwidth (OBW), adjacent channel power (ACPR), third-order intercept (TOI), carrier-to-noise ratio (C/N) and harmonics. The instrument has **no query for the active measurement**, and `:CONFigure:<meas>` presets the span, RBW and sweep time (for example span 3 MHz) which `:CONFigure:SANalyzer` does not put back, so these tools save and restore that state and never scan for the active mode (queries the instrument does not answer stall it, and over VXI-11 can drop the link). Spectrum analyzer mode is told by `:SENSe:DETector:TRACe1?`, which only it answers; one measurement is told by `:SENSe:<meas>:AVERage:STATe?`. While a measurement is active most spectrum analyzer queries (detector, trace type) get no reply. A probe that gets no reply costs about 4.5 s (the 1.5 s timeout plus a 3 s pause while the instrument recovers). Measurement names: `channel_power`, `time_power`, `obw`, `acpr` (`:SENSe:ACPower`), `toi`, `cn` (`CNRatio`), `harmonics`.

Parameters (`configure_measurement` and `measure`; `*` = common to all measurements): `average`* (on/off), `average_count`* (integer 1-999), `average_control`* (`exponential`, `repeat`), `average_type`* (`voltage`, `power`, `log`); `integration_bandwidth_hz` (channel_power, acpr or cn, greater than 0; channel_power is clamped by the instrument to 100 Hz-3.61 GHz); `left_limit_s`, `right_limit_s` (time_power only, 0-0.01 s; the instrument clamps the right limit to 10 ms); `percent` (obw only, above 0 up to 1; clamped to 0.9999) and `xdb` (obw only, -100 to -0.1 dB); `carrier_bandwidth_hz` (acpr, greater than 0), `offset_hz` (acpr: adjacent channel offset; cn: noise offset; 0 or more) and `offset_side` (acpr: `both`, `negative`, `positive`); `noise_bandwidth_hz` (cn, greater than 0); `fundamental_hz` (harmonics, greater than 0), `harmonics_count` (harmonics, integer 2-10, counts the fundamental; the preset is 2) and `sweep_time_s` (harmonics, 0.001-100 s). TOI has only the averaging parameters. A parameter for another measurement, or an out-of-range value, is refused before anything is sent. The parameters are read back after setting and anything the instrument changed is a `warnings` entry.

### `get_measurement`

Read-only. Without arguments it asks the one query only spectrum analyzer mode answers and returns `{"measurement": "spectrum_analyzer"}`; if that gets no reply it is an error saying a measurement is active (it does not guess which). With `measurement` set it checks that measurement and returns its parameters; an error means it is not active.

### `configure_measurement`

`measurement` plus optional parameters (above) and `preset` (default true: `:CONFigure:<meas>`; false: `:CONFigure:<meas>:NDEFault`; both change the span, RBW and sweep time). Enters the measurement, sets the parameters, reads them back and leaves the instrument in the measurement. When entered from spectrum analyzer mode the center, span, RBW, VBW, sweep time (each with its auto flag), continuous-sweep state and the tracking generator output (plus its level and offset when it was on; entering a measurement switches it off) are saved for `exit_measurement` (`saved_settings: true`). Returns `measurement`, `parameters`, `warnings`, `saved_settings`.

### `read_measurement`

Read-only. `measurement` (must be active, else an error naming the silent query), `timeout_s` (default 30, 1-600) and the flag `fetch`, false by default. `READ` starts the measurement and waits for it (over VXI-11); `fetch: true` returns the latest result at once. **Over raw TCP the instrument ends a `READ` reply without a line terminator, so FETCh is used instead and a warning says so.** Results: channel_power gives `channel_power_dbm` and `power_density_dbm_per_hz`; time_power gives `power_dbm`; obw gives `obw_hz`, `frequency_error_hz`, `xdb_bandwidth_hz` and `total_power_dbm` (queried as separate documented sub-results; the combined OBW reply has seven values of which the manual documents only four; the four are not one atomic snapshot). acpr gives `main_power_dbm`, `lower_power_dbm`, `lower_dbc`, `upper_power_dbm`, `upper_dbc` (a side that is not measured, see `offset_side`, reads `null` with a warning; the combined `:FETCh:ACPower?` has only three values, so the sub-results are queried); cn gives `carrier_dbm`, `noise_dbm`, `cn_db`; toi gives `lower_third_order` and `upper_third_order` (`frequency_hz`, `amplitude_dbm`, `dbc`, `toi_dbm`), `lower_tone` and `upper_tone` (`frequency_hz`, `amplitude_dbm`) from four queries (the documented `:FETCh:TOI:IPT?` gets no reply and is not used; each product carries its TOI); harmonics gives `fundamental` (`frequency_hz`, `amplitude_dbm`), `harmonics` (a list of `order` 2..n with `frequency_hz` and `amplitude_dbc`, n = `harmonics_count`; the instrument pads its lists to 10 values and the tool drops the padding) and `thd_percent`, `thd_dbc`. With several queries per result only the first uses READ (it runs the measurement and waits), the others FETCh that result, so they are not separate measurements. A reply that is not a number list of the expected length (`nan` right after entering a measurement, before its first result) is an error naming the command.

### `exit_measurement`

`restore_settings` (default true). Sends `:CONFigure:SANalyzer`, checks that spectrum analyzer mode answers again and, when `configure_measurement` saved settings, puts the center, span, RBW, VBW, sweep time and continuous state back and verifies them by reading every value and auto flag back: a field that differs is sent once more (the `warnings` say which), and if it still differs the call is an **error** naming each field with its actual and saved value (never a success). After the analyzer settings it restores the tracking generator output saved by `configure_measurement` (level and offset, then output on; readback verified, one resend, warning on a retry, error naming `enabled`, `level_dbm` or `level_offset_db` if it still differs; a failed analyzer restore does not skip it). With `restore_settings=false` a generator that was on stays off and a warning says so. A measurement entered another way has nothing saved: it only exits and a warning says the span, RBW and sweep time keep the measurement's values and the generator output was not restored. In spectrum analyzer mode with nothing saved it does nothing.

### `measure`

One shot that leaves the instrument as it found it: from spectrum analyzer mode it saves the state (including the tracking generator output, level and offset when on), enters `measurement` (with `preset` and the parameters), reads the result with READ (FETCh after a 1.5 s settle over raw TCP), and **always**, even after an error, exits to spectrum analyzer mode, restores the saved state (frequency settings and the tracking generator output, which entering a measurement switches off) and verifies it by readback (`try/finally`; a mismatch is retried once, then reported as an error naming the field). With the requested measurement already active it only reads and puts any parameters you passed back to their previous values. It refuses when the instrument is in neither spectrum analyzer mode nor the requested measurement (use `exit_measurement`). Returns `measurement`, `result`, `restored`, `warnings`; if the read fails the error says the instrument was restored, and if the restore fails the error says to check with `get_measurement`/`exit_measurement`.

## Screenshot

### `screenshot`

Read-only, no parameters. Captures the analyzer screen (1280 x 800) and returns it as an MCP **image content block** (`image/png`) followed by a text line with the size (about 90 KB, taking about 3 s). It reads the picture format (`:SYSTem:PICture:FORMat?`, `BMP` or `PNG`), selects `PNG`, queries `:DISPlay:DATA?` as a `#` block, checks the PNG signature, and **always restores the original format** (try/finally, also after a failed transfer). If the restore fails the result is an error that says so and still carries the image.

Needs a transport whose large replies arrive complete (`completeLargeBlocks`: VXI-11). Over raw TCP the instrument stops after exactly 144,800 bytes (issue #42), so the tool refuses at once, sends nothing, and the error tells you to reconnect with `transport: "vxi11"` (or `auto`) or set `UTS_TRANSPORT`. Errors name the command: a timeout names `:DISPlay:DATA?`, an unreadable format reply names `:SYSTem:PICture:FORMat?`, an empty or non-PNG reply is rejected, and an instrument error while selecting the format carries its code. The tool does not save files; the client receives the image. The screen shows whatever the instrument displays (including its system information page if open).

## Selecting an instrument (all tools)

Every tool except `discover_instruments` and `list_instruments` takes an optional `instrument` argument (a name from `list_instruments`: 1-32 letters, digits, `_` or `-`; `connect`, `disconnect` and `identify` call it `name`). The tool then runs on that instrument's own connection, queue and exclusive session, so calls to different instruments proceed in parallel while calls to the same instrument stay serialized.

- Omitted: the `default` instrument (`UTS_IP`), or the only configured instrument whatever its name. With one instrument nothing changes for existing users.
- An unknown name is an error that lists the configured names and sends nothing; so is an omitted name when several instruments are configured and none is called `default`.
- An instrument that is not connected fails with the usual not-connected message; the other instruments are not affected.

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
| `UTS_VXI11_PROBE_TIMEOUT_S` | Total seconds (1 to 120, default `15`) `auto` and `vxi11` may spend reaching VXI-11: up to three attempts to reach the portmapper on port 111 and open the link, with doubling pauses, all inside this budget. Raise it for a slow routed path (VPN, Tailscale) |
| `UTS_INSTRUMENTS` | Additional named instruments, `name=host[:port],...` or JSON; each is connected at startup on its own connection (own queue and lock). See `list_instruments` |
| `UTS_BUSY_TIMEOUT_S` | How long a tool call waits for another one to finish before failing with `Instrument busy`, in seconds (default `120`); see Concurrency |
