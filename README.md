# uni-t-uts-mcp

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server for controlling UNI-T UTS series spectrum analyzers (UTS1000B/T, UTS3000B) over SCPI.

> **Status:** early scaffold. No tools implemented yet.

## Planned layout

Modeled on [siglent-sds-mcp](https://github.com/MagnusJohansson/siglent-sds-mcp): TypeScript, stdio transport, one SCPI connection singleton, tool groups under `src/tools/`, vitest unit + mocked integration tests, npm and Docker publishing via tag-triggered GitHub Actions.

- `src/connection.ts` – SCPI TCP connection with query queue
- `src/tools/` – connection, frequency, amplitude, bandwidth, trace, marker, screenshot, raw SCPI
- `docs/` – `references.md` (manuals and links), `verified-hardware.md` (what was tested on), tools reference, programming-guide notes, manual testing guide

## Documentation

Manual and reference links: [docs/references.md](docs/references.md).

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
