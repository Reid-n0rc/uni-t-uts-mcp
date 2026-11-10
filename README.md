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

Parameters and behavior: [docs/tools-reference.md](docs/tools-reference.md). Set `UTS_IP` (and optionally `UTS_PORT`, default 5025) to connect automatically at startup.

## Project layout

Modeled on [siglent-sds-mcp](https://github.com/MagnusJohansson/siglent-sds-mcp): TypeScript, stdio transport, vitest tests, npm and Docker publishing via tag-triggered GitHub Actions.

- `src/connection.ts` – raw SCPI over TCP with a serialized queue, `*OPC?`-synced commands and hold-off after unsupported queries
- `src/blocks.ts`, `src/scpi.ts` – binary block parser; SCPI helpers and the safety denylist
- `src/instrument.ts`, `src/errors.ts`, `src/acquisition.ts` – applying settings with error-queue checks, sweep synchronization
- `src/tools/` – one file per tool group, registered in `src/server.ts`
- `tests/` – unit and mocked integration tests, a fake SCPI server, and captured instrument fixtures
- `docs/` – [tools-reference.md](docs/tools-reference.md), [verified-hardware.md](docs/verified-hardware.md), [programming-guide.md](docs/programming-guide.md), [references.md](docs/references.md)

## Documentation

Manual and reference links: [docs/references.md](docs/references.md).

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
