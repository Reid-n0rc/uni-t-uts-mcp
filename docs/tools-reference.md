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

## Environment variables

| Variable | Description |
|----------|-------------|
| `UTS_IP` | Analyzer hostname or IP; enables auto-connect and is the default for `connect` |
| `UTS_PORT` | TCP port, default `5025` |
