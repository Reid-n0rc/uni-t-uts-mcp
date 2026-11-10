# uni-t-uts-mcp

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server for controlling UNI-T UTS series spectrum analyzers (UTS1000B/T, UTS3000B) over SCPI.

> **Status:** under active development. The tools below work and are verified on a UNI-T UTS3036B (firmware V1.04.0040) over LAN; see [docs/verified-hardware.md](docs/verified-hardware.md). Trace data, markers, measurements and the screenshot tool are not implemented yet; progress is tracked in the [roadmap issue](https://github.com/Reid-n0rc/uni-t-uts-mcp/issues/1). A full quick start (npx and Docker) is coming with the docs task.

## Tools available

| Group | Tools |
|-------|-------|
| Connection | `connect`, `disconnect`, `identify` |
| Raw SCPI | `scpi_query`, `scpi_command` (with a confirm-required safety denylist) |
| Frequency | `get_frequency`, `set_frequency` |
| Amplitude | `get_amplitude`, `set_amplitude` |
| Bandwidth, sweep, detector | `get_bandwidth`, `set_bandwidth`, `get_sweep`, `set_sweep`, `get_detector`, `set_detector` |
| Acquisition | `get_acquisition`, `set_acquisition`, `start_sweep`, `single_sweep`, `wait_for_sweep_complete` |

Parameters and behavior: [docs/tools-reference.md](docs/tools-reference.md). Set `UTS_IP` (and optionally `UTS_PORT`, default 5025) to connect automatically at startup.

## Project layout

Modeled on [siglent-sds-mcp](https://github.com/MagnusJohansson/siglent-sds-mcp): TypeScript, stdio transport, vitest tests, npm and Docker publishing via tag-triggered GitHub Actions.

- `src/connection.ts` – serialized SCPI queue with timeouts, `*OPC?`-synced commands and hold-off after unsupported queries, on top of a pluggable transport
- `src/transports/` – the `Transport` interface with capability flags, and the raw SCPI over TCP transport (`raw.ts`)
- `src/blocks.ts`, `src/scpi.ts` – binary block parser; SCPI helpers and the safety denylist
- `src/instrument.ts`, `src/errors.ts`, `src/acquisition.ts` – applying settings with error-queue checks, sweep synchronization
- `src/tools/` – one file per tool group, registered in `src/server.ts`
- `tests/` – unit and mocked integration tests, a fake SCPI server, a transport contract suite (`transportContract.ts`), and captured instrument fixtures
- `docs/` – [tools-reference.md](docs/tools-reference.md), [verified-hardware.md](docs/verified-hardware.md), [programming-guide.md](docs/programming-guide.md), [references.md](docs/references.md)

## Supported platforms

Linux, macOS and Windows, with Node.js 22 or newer (CI builds and tests on `ubuntu-latest`, `macos-latest` and `windows-latest` with Node 22 and 24). A Docker image (Linux) is also provided. The analyzer must be reachable over the LAN on TCP port 5025 (raw SCPI); allow outbound connections to that port in any host firewall. Docker Desktop on macOS and Windows reaches LAN instruments through its outbound NAT, so no extra network setup is needed.

## Setup per OS

The analyzer address is given by the `UTS_IP` environment variable (optional; without it, call the `connect` tool with a host). Use your instrument's address in place of `192.168.1.100`.

| Shell | Set `UTS_IP` for the current session |
|-------|--------------------------------------|
| bash / zsh (Linux, macOS) | `export UTS_IP=192.168.1.100` |
| PowerShell (Windows) | `$env:UTS_IP = "192.168.1.100"` |
| cmd (Windows) | `set UTS_IP=192.168.1.100` |

MCP client configuration (the `env` block sets the variable for the server, so no shell setup is needed):

macOS / Linux:

```json
{ "mcpServers": { "uni-t-uts": { "command": "npx", "args": ["-y", "uni-t-uts-mcp"], "env": { "UTS_IP": "192.168.1.100" } } } }
```

Windows (clients that cannot launch `npx` directly, which is a `.cmd` file, need `cmd /c`):

```json
{ "mcpServers": { "uni-t-uts": { "command": "cmd", "args": ["/c", "npx", "-y", "uni-t-uts-mcp"], "env": { "UTS_IP": "192.168.1.100" } } } }
```

Docker (any OS with Docker; the image is built from the `Dockerfile` in this repo):

```json
{ "mcpServers": { "uni-t-uts": { "command": "docker", "args": ["run", "-i", "--rm", "-e", "UTS_IP=192.168.1.100", "uni-t-uts-mcp"] } } }
```

From a clone, `npm ci && npm run build` works the same on every OS; then use `node` with the absolute path to `build/index.js` (for example `C:\\path\\to\\build\\index.js` in JSON on Windows) as the command.

Probe scripts take the host as an argument or from `UTS_IP`: `node scripts/probe-basics.mjs 192.168.1.100`.

## Project site

The project site is at https://reid-n0rc.github.io/uni-t-uts-mcp/ (source in `site/`). Its tool list is generated from the server's own tool definitions and `docs/tools-reference.md`, so it stays current. Preview it locally with `npm run site` and open `_site/index.html`; it is deployed by `.github/workflows/pages.yml` on every change to `main` that touches the site or the tools.

## Documentation

Manual and reference links: [docs/references.md](docs/references.md).

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
