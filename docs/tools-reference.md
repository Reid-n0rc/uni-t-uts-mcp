# Tools Reference

Tools are added as the roadmap (issue #1) progresses. Hardware verification status is in [verified-hardware.md](verified-hardware.md).

## Connection

### `connect`

Connect to a UNI-T UTS analyzer over raw SCPI/TCP. Verifies the link with `*IDN?` and returns the identification string.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `host` | string | No | `UTS_IP` env var | Hostname or IP address (letters, digits, `.`, `-`, `_`, `:` only) |
| `port` | integer 1-65535 | No | `UTS_PORT` env var, then `5025` | TCP port |

If `UTS_IP` is set, the server also connects automatically at startup; a failed auto-connect is logged to stderr and does not stop the server.

### `disconnect`

Disconnect from the analyzer. Safe to call when not connected. No parameters.

### `identify`

Query `*IDN?` (manufacturer, model, serial number, firmware version). Read-only. No parameters. An empty reply or one without four comma-separated fields is an error that quotes the reply.

## Raw SCPI

Escape hatches for commands without a dedicated tool. Syntax is in [programming-guide.md](programming-guide.md).

### `scpi_query`

Send **one** SCPI query (must end in `?`) and return the reply. Read-only: anything that is not a single query is refused (use `scpi_command`). Unsupported queries get no reply from the instrument and time out.

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

Switches to single mode, runs one sweep and waits until it is complete, so the trace can be read. Optional `timeout_s` (default sweep time + 10 s; a timeout returns an error result). Leaves the instrument in single mode.

### `start_sweep` / `wait_for_sweep_complete`

`start_sweep` sends `:INITiate:IMMediate` (`method: "immediate"`, default) or `:INITiate:RESTart`. In single mode `wait` (default true) waits for completion; with `wait: false` call `wait_for_sweep_complete` next (nothing else can be sent meanwhile). In continuous mode the sweep is restarted, not awaited, and a warning says so. `timeout_s` is optional on all three tools.

## Error handling (all tools)

Tools never throw; failures are `isError` results. A malformed or empty reply names the command and quotes the reply; a timeout names the command; setters report instrument errors with their code and the commands sent, and say when settings may be partially applied (also when the readback after a successful send fails). `single_sweep` failures say when the instrument was left in single sweep mode. See AGENTS.md "Error handling standard".

## Environment variables

| Variable | Description |
|----------|-------------|
| `UTS_IP` | Analyzer hostname or IP; enables auto-connect and is the default for `connect` |
| `UTS_PORT` | TCP port, default `5025` |
