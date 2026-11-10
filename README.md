# uni-t-uts-mcp

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server for controlling UNI-T UTS series spectrum analyzers (UTS1000B/T, UTS3000B) over SCPI.

> **Status:** under active development. The tools below work and are verified on a UNI-T UTS3036B (firmware V1.04.0040) over LAN; see [docs/verified-hardware.md](docs/verified-hardware.md). Trace data fetch, markers, measurements and the screenshot tool are not implemented yet; progress is tracked in the [roadmap issue](https://github.com/Reid-n0rc/uni-t-uts-mcp/issues/1). A full quick start (npx and Docker) is coming with the docs task.

## Tools available

| Group | Tools |
|-------|-------|
| Connection | `connect`, `disconnect`, `identify` |
| Raw SCPI | `scpi_query`, `scpi_command` (with a confirm-required safety denylist) |
| Frequency | `get_frequency`, `set_frequency` |
| Amplitude | `get_amplitude`, `set_amplitude` |
| Bandwidth, sweep, detector | `get_bandwidth`, `set_bandwidth`, `get_sweep`, `set_sweep`, `get_detector`, `set_detector` |
| Acquisition | `get_acquisition`, `set_acquisition`, `start_sweep`, `single_sweep`, `wait_for_sweep_complete` |
| Trace configuration | `get_trace`, `set_trace`, `restart_trace`, `set_trace_math` |

Parameters and behavior: [docs/tools-reference.md](docs/tools-reference.md). Set `UTS_IP` (and optionally `UTS_PORT`, default 5025) to connect automatically at startup. The default transport is raw SCPI over TCP; `UTS_TRANSPORT=vxi11` (or `auto`, which uses VXI-11 when the analyzer offers it) selects VXI-11, with `UTS_VXI11_DEVICE` (default `inst0`) naming the device. VXI-11 queues commands during a sweep instead of dropping them and lets `single_sweep` wait with one blocking `*OPC?`; see the [programming guide](docs/programming-guide.md#vxi-11-transport).

**Parallel tool calls are safe.** The instrument has a single command stream, so the server runs tool calls one at a time per instrument, first in first out: each tool's whole command sequence is atomic, results and errors are never mixed up between calls, and a long operation such as `single_sweep` makes other calls wait (they fail with `Instrument busy` after `UTS_BUSY_TIMEOUT_S` seconds, default 120). Details: [Concurrency](docs/tools-reference.md#concurrency-all-tools).

## Project layout

Modeled on [siglent-sds-mcp](https://github.com/MagnusJohansson/siglent-sds-mcp): TypeScript, stdio transport, vitest tests, npm and Docker publishing via tag-triggered GitHub Actions.

- `src/connection.ts` – serialized SCPI queue with timeouts, `*OPC?`-synced commands and hold-off after unsupported queries, on top of a pluggable transport
- `src/transports/` – the `Transport` interface with capability flags, the raw SCPI over TCP transport (`raw.ts`), the VXI-11 transport (`vxi11.ts`) and transport selection (`select.ts`: `UTS_TRANSPORT`, `UTS_VXI11_DEVICE`, the `auto` probe)
- `src/sessionLock.ts` – the FIFO exclusive-session lock behind `connection.runExclusive`; every tool is registered through `defineTool` (`src/tools/util.ts`), which runs it inside a session
- `src/blocks.ts`, `src/scpi.ts` – binary block parser; SCPI helpers and the safety denylist
- `src/instrument.ts`, `src/errors.ts`, `src/acquisition.ts` – applying settings with error-queue checks, sweep synchronization
- `src/vxi11/` – dependency-free ONC RPC/XDR client, portmapper and VXI-11 core-channel client (used by the VXI-11 transport)
- `src/tools/` – one file per tool group, registered in `src/server.ts`
- `tests/` – unit and mocked integration tests, a fake SCPI server, a transport contract suite (`transportContract.ts`), and captured instrument fixtures
- `docs/` – [tools-reference.md](docs/tools-reference.md), [verified-hardware.md](docs/verified-hardware.md), [programming-guide.md](docs/programming-guide.md), [references.md](docs/references.md)

## Supported platforms

Linux, macOS and Windows, with Node.js 22 or newer (CI builds and tests on `ubuntu-latest`, `macos-latest` and `windows-latest` with Node 22 and 24). A Docker image (Linux) is also provided. The analyzer must be reachable over the LAN on TCP port 5025 (raw SCPI); allow outbound connections to that port in any host firewall. For VXI-11 (`UTS_TRANSPORT=vxi11` or `auto`) also allow outbound TCP to port 111 (the portmapper) and to the dynamic core-channel port the portmapper reports (it changes between instrument restarts, so allow outbound connections to the analyzer on any port). Docker Desktop on macOS and Windows reaches LAN instruments through its outbound NAT, so no extra network setup is needed.

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

The project site is at https://reid-n0rc.github.io/uni-t-uts-mcp/ (source in `site/`). Its "Built for real hardware" section explains, benefit first, how the server copes with the analyzer's timing quirks. The site has an optional synthwave soundtrack, generated live in your browser with the Web Audio API (no audio files, no downloads, no external requests). It starts automatically where your browser allows it, otherwise on your first click, tap or key press (a small prompt says so); scrolling does not count, because browsers do not treat it as a user gesture. The Soundtrack button at the bottom left is the first thing in the tab order and mutes it; the choice is remembered in your browser and a muted visitor never gets autoplay. The music pauses while the tab is hidden, and the hero spectrum reacts to it. The code is `site/soundtrack.cjs`, inlined into the page at build time. Its tool list is generated from the server's own tool definitions and `docs/tools-reference.md`, so it stays current. Preview it locally with `npm run site` and open `_site/index.html`; it is deployed by `.github/workflows/pages.yml` on every change to `main` that touches the site or the tools.

## Documentation

Manual and reference links: [docs/references.md](docs/references.md).

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
