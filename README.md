# uni-t-uts-mcp

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server for controlling UNI-T UTS series spectrum analyzers (UTS1000B/T, UTS3000B) over SCPI.

> **Status:** early scaffold. No tools implemented yet.

## Planned layout

Modeled on [siglent-sds-mcp](https://github.com/MagnusJohansson/siglent-sds-mcp): TypeScript, stdio transport, one SCPI connection singleton, tool groups under `src/tools/`, vitest unit + mocked integration tests, npm and Docker publishing via tag-triggered GitHub Actions.

- `src/connection.ts` – SCPI TCP connection with query queue
- `src/tools/` – connection, frequency, amplitude, bandwidth, trace, marker, screenshot, raw SCPI
- `docs/` – `references.md` (manuals and links), `verified-hardware.md` (what was tested on), tools reference, programming-guide notes, manual testing guide

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

## Documentation

Manual and reference links: [docs/references.md](docs/references.md).

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
