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

## Environment variables

| Variable | Description |
|----------|-------------|
| `UTS_IP` | Analyzer hostname or IP; enables auto-connect and is the default for `connect` |
| `UTS_PORT` | TCP port, default `5025` |
