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

Query `*IDN?` (manufacturer, model, serial number, firmware version). Read-only. No parameters.

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

Send a SCPI command with no reply expected. Queries are refused (use `scpi_query`).

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

Frequency parameters are coupled, so choose one group per call; the settings are re-read afterwards and anything the instrument changed is listed in `warnings`.

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

All parameters are optional, but at least one is required. The settings are re-read afterwards; values the instrument clamped are listed in `warnings`.

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

## Environment variables

| Variable | Description |
|----------|-------------|
| `UTS_IP` | Analyzer hostname or IP; enables auto-connect and is the default for `connect` |
| `UTS_PORT` | TCP port, default `5025` |
