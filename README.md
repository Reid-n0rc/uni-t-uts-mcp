# uni-t-uts-mcp

[![codecov](https://codecov.io/gh/Reid-n0rc/uni-t-uts-mcp/graph/badge.svg)](https://codecov.io/gh/Reid-n0rc/uni-t-uts-mcp)

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server for controlling UNI-T UTS series spectrum analyzers (UTS1000B/T, UTS3000B) over SCPI.

> **Status:** under active development. The tools below work and are verified on a UNI-T UTS3036B (firmware V1.04.0040) over LAN; see [docs/verified-hardware.md](docs/verified-hardware.md). Progress is tracked in the [roadmap issue](https://github.com/Reid-n0rc/uni-t-uts-mcp/issues/1). See [Install](#install) for setup.

> **Front panel:** while the server is talking to the analyzer it is in remote mode and its touch screen and buttons are locked. Press **Esc** on the analyzer to return it to local mode (`:SYSTem:LOCK 0`, VXI-11 unlock and a simulated `:KEY:ESC` do not work on the tested firmware). See [docs/verified-hardware.md](docs/verified-hardware.md).

## Tools available

| Group | Tools |
|-------|-------|
| Connection | `connect` (`host: "auto"` finds the analyzer), `discover_instruments`, `disconnect`, `identify` |
| Raw SCPI | `scpi_query`, `scpi_command` (with a confirm-required safety denylist) |
| Frequency | `get_frequency`, `set_frequency` |
| Amplitude | `get_amplitude`, `set_amplitude` |
| Bandwidth, sweep, detector | `get_bandwidth`, `set_bandwidth`, `get_sweep`, `set_sweep`, `get_detector`, `set_detector` |
| Acquisition | `get_acquisition`, `set_acquisition`, `start_sweep`, `single_sweep`, `wait_for_sweep_complete` |
| Trace configuration | `get_trace`, `set_trace`, `restart_trace`, `set_trace_math` |
| Trace data | `get_trace_data` |
| Markers | `get_marker`, `set_marker`, `marker_search`, `marker_to_instrument`, `markers_all_off`, `get_peak_criteria`, `set_peak_criteria`, `get_marker_function`, `set_marker_function`, `get_marker_ndb`, `set_marker_ndb`, `get_frequency_counter`, `set_frequency_counter` |
| Limit lines | `get_limit_line`, `set_limit_line`, `delete_limit_line` (no pass/fail read-back exists) |
| Measurements | `get_measurement`, `configure_measurement`, `read_measurement`, `exit_measurement`, `measure` (channel power, time-domain power, OBW, ACPR, TOI, C/N, harmonics) |
| Tracking generator | `get_tracking_generator`, `set_tracking_generator` (output, level, offset, reference trace, normalization; needs the option) |
| Screenshot | `screenshot` (PNG image of the screen; needs VXI-11, see [tools reference](docs/tools-reference.md#screenshot)) |

Parameters and behavior: [docs/tools-reference.md](docs/tools-reference.md). Set `UTS_IP` (see [Install](#install); optionally also `UTS_PORT`, default 5025) to connect automatically at startup. The default transport is `auto`: VXI-11 when the analyzer offers it (verified on the UTS3036B), otherwise raw SCPI over TCP; `UTS_TRANSPORT=raw` or `vxi11` forces one (setting only `UTS_PORT` also means raw), and `UTS_VXI11_DEVICE` (default `inst0`) names the VXI-11 device. `UTS_VXI11_PROBE_TIMEOUT_S` (default 15) is the total time allowed to reach VXI-11, retries included; raise it on a slow VPN or Tailscale path. VXI-11 queues commands during a sweep instead of dropping them, lets `single_sweep` wait with one blocking `*OPC?`, and does not truncate the screenshot transfer; see the [programming guide](docs/programming-guide.md#vxi-11-transport-srctransportsvxi11ts-srctransportsselectts).

**Parallel tool calls are safe.** The instrument has a single command stream, so the server runs tool calls one at a time per instrument, first in first out: each tool's whole command sequence is atomic, results and errors are never mixed up between calls, and a long operation such as `single_sweep` makes other calls wait (they fail with `Instrument busy` after `UTS_BUSY_TIMEOUT_S` seconds, default 120). Details: [Concurrency](docs/tools-reference.md#concurrency-all-tools).

## Project layout

Modeled on [siglent-sds-mcp](https://github.com/MagnusJohansson/siglent-sds-mcp): TypeScript, stdio transport, vitest tests, npm and Docker publishing via tag-triggered GitHub Actions.

- `src/connection.ts` – serialized SCPI queue with timeouts, `*OPC?`-synced commands and hold-off after unsupported queries, on top of a pluggable transport
- `src/discovery.ts`, `src/autoHost.ts` – network discovery (portmapper UDP broadcast on each local subnet, `*IDN?` of the responders) behind `discover_instruments` and `host=auto`
- `src/transports/` – the `Transport` interface with capability flags, the raw SCPI over TCP transport (`raw.ts`), the VXI-11 transport (`vxi11.ts`) and transport selection (`select.ts`: `UTS_TRANSPORT`, `UTS_VXI11_DEVICE`, the `auto` probe)
- `src/sessionLock.ts` – the FIFO exclusive-session lock behind `connection.runExclusive`; every tool is registered through `defineTool` (`src/tools/util.ts`), which runs it inside a session
- `src/tools/screenshot.ts` – the `screenshot` tool (PNG via `:DISPlay:DATA?`, picture format restored in a `finally`)
- `src/blocks.ts`, `src/scpi.ts` – binary block parser; SCPI helpers and the safety denylist
- `src/instrument.ts`, `src/errors.ts`, `src/acquisition.ts` – applying settings with error-queue checks, sweep synchronization
- `src/vxi11/` – dependency-free ONC RPC/XDR client, portmapper, VXI-11 core-channel client (used by the VXI-11 transport) and the interrupt-channel listener (`interrupt.ts`, SRQ client; not used by any tool)
- `src/tools/` – one file per tool group, registered in `src/server.ts`
- `tests/` – unit and mocked integration tests, a fake SCPI server, a transport contract suite (`transportContract.ts`), and captured instrument fixtures
- `mcpb/manifest.json`, `scripts/build-mcpb.mjs` – the Claude Desktop MCP bundle (`.mcpb`): manifest and the Node-only build script (`npm run build:mcpb`)
- `scripts/client-snippets.mjs` – single source for the per-client configs and links (README table, wiki page, site section); `npm run clients:sync` regenerates them
- `scripts/client-config.mjs` – the `npm run client-config` printer; also the single place that holds the install specs and the `NPM_PUBLISHED` switch
- `scripts/sync-wiki.mjs` – builds the wiki page set from the docs (see [Wiki](#wiki)); `docs/wiki/` holds the hand-written wiki pages
- `docs/` – [manual-testing-guide.md](docs/manual-testing-guide.md), [tools-reference.md](docs/tools-reference.md), [verified-hardware.md](docs/verified-hardware.md), [programming-guide.md](docs/programming-guide.md), [references.md](docs/references.md)

## Install

Everything in this section works today (v0.4.0, also on npm). You need Node.js 22 or newer (or Docker). Use your analyzer's address in place of `192.168.1.100`.

`UTS_IP` is optional. Set it to `auto` (or ask the assistant to connect with host `auto`) to find the analyzer on your local subnet without knowing its address; this works when exactly one analyzer answers and is unauthenticated, so check the model and address it reports. If you leave it out, tell the assistant "connect to the analyzer at 192.168.1.100" and it will use the `connect` tool.

### Add to your client

<!-- clients:begin -->
| Client | How | One-click |
|---|---|---|
| Claude Code | terminal, or `.mcp.json` in a project | - |
| Claude Desktop | download the `.mcpb`, or `claude_desktop_config.json` | [Download the .mcpb (GitHub releases)](https://github.com/Reid-n0rc/uni-t-uts-mcp/releases/tag/v0.4.0) |
| Cursor | install link, or `~/.cursor/mcp.json` / `.cursor/mcp.json` | [Add to Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=uni-t-uts&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInVuaS10LXV0cy1tY3AiXX0=) |
| VS Code | `.vscode/mcp.json`, or `code --add-mcp` | - |
| Windsurf | `mcp_config.json` (Cascade > Open MCP config file) | - |
| Other stdio clients | any client that launches an MCP server over stdio | - |

Copy-paste configs for each client, and what has and has not been verified, are on the [Add to Client wiki page](https://github.com/Reid-n0rc/uni-t-uts-mcp/wiki/Add-to-Client) and the [project site](https://reid-n0rc.github.io/uni-t-uts-mcp/#add-to-client).
<!-- clients:end -->

More detail follows per client.

### Claude Code

Easiest: the Claude Code plugin (this repository is also a plugin marketplace). Inside Claude Code:

```
/plugin marketplace add Reid-n0rc/uni-t-uts-mcp
/plugin install uni-t-uts@uni-t-uts-mcp
```

or from a shell: `claude plugin marketplace add Reid-n0rc/uni-t-uts-mcp` and `claude plugin install uni-t-uts@uni-t-uts-mcp`. The plugin runs `npx -y uni-t-uts-mcp` pinned to this release (0.4.0) and asks for the analyzer address, port and transport (all optional; change them later in `/plugin`). The server's tools then appear under the plugin. On Windows, where `npx` is a `.cmd` file, use the manual `claude mcp add ... cmd /c npx` commands below if the plugin's server does not start. Plugin and marketplace formats follow https://code.claude.com/docs/en/plugins-reference and https://code.claude.com/docs/en/plugins/marketplace-reference.md; the plugin files are generated by `npm run clients:sync`.

Or register the server by hand; pick one, each registers the server under the name `uni-t-uts`.

```sh
# From the npm registry (shortest; npx downloads and runs it)
claude mcp add uni-t-uts -e UTS_IP=192.168.1.100 -- npx -y uni-t-uts-mcp

# From the release tarball (same files as npm, fetched from GitHub: no build step, no install scripts)
claude mcp add uni-t-uts -e UTS_IP=192.168.1.100 -- npx -y https://github.com/Reid-n0rc/uni-t-uts-mcp/releases/download/v0.4.0/uni-t-uts-mcp-0.4.0.tgz

# From the git tag (npm clones the repository and builds it; needs git)
claude mcp add uni-t-uts -e UTS_IP=192.168.1.100 -- npx -y github:Reid-n0rc/uni-t-uts-mcp#v0.4.0

# Docker (Linux image, amd64 and arm64)
claude mcp add uni-t-uts -- docker run -i --rm -e UTS_IP=192.168.1.100 ghcr.io/reid-n0rc/uni-t-uts-mcp:0.4.0
```

On Windows, where `npx` is a `.cmd` file that clients cannot launch directly, put `cmd /c` in front of it:

```sh
claude mcp add uni-t-uts -e UTS_IP=192.168.1.100 -- cmd /c npx -y uni-t-uts-mcp

# or from the release tarball
claude mcp add uni-t-uts -e UTS_IP=192.168.1.100 -- cmd /c npx -y https://github.com/Reid-n0rc/uni-t-uts-mcp/releases/download/v0.4.0/uni-t-uts-mcp-0.4.0.tgz
```

### Claude Desktop: download the .mcpb and double-click

The bundle `uni-t-uts-mcp-0.4.0.mcpb` (an MCP bundle, the Claude Desktop extension format) is attached to the [v0.4.0 GitHub release](https://github.com/Reid-n0rc/uni-t-uts-mcp/releases/tag/v0.4.0). You can also build the file yourself (`npm ci && npm run build && npm run build:mcpb`, which writes `dist/uni-t-uts-mcp-<version>.mcpb`). Installing it in Claude Desktop itself has not been verified yet.

1. Download the `.mcpb` file.
2. Double-click it (or drag it onto Claude Desktop, or use Settings > Extensions > Advanced settings > Install Extension).
3. In the install dialog fill in the settings, then install:
   - **Analyzer address** (optional): the analyzer's address, for example `192.168.1.100`. Leave it empty and tell the assistant "connect to the analyzer at 192.168.1.100" instead.
   - **Port**: 5025 (raw SCPI); change it only if your analyzer differs.
   - **Transport**: `raw` (default), `vxi11` or `auto`.

The bundle contains the compiled server and its dependencies and uses the Node.js that comes with Claude Desktop, so nothing else needs installing (it needs Node 22 or newer). It is not code-signed, so Claude Desktop shows its usual unverified-extension notice. The bundle is built and checked in CI and started over stdio from an unpacked copy, but installing it in Claude Desktop itself has not been verified yet (issue #86 tracks the manual check).

### Claude Desktop (JSON), Cursor, VS Code and other clients

Add this `mcpServers` entry to the client's MCP configuration (Claude Desktop: `claude_desktop_config.json`; Cursor: `~/.cursor/mcp.json`; VS Code-style clients use the same entry, some under a `servers` key instead of `mcpServers`).

macOS / Linux:

```json
{ "mcpServers": { "uni-t-uts": { "command": "npx", "args": ["-y", "uni-t-uts-mcp"], "env": { "UTS_IP": "192.168.1.100" } } } }
```

Or from the release tarball:

```json
{ "mcpServers": { "uni-t-uts": { "command": "npx", "args": ["-y", "https://github.com/Reid-n0rc/uni-t-uts-mcp/releases/download/v0.4.0/uni-t-uts-mcp-0.4.0.tgz"], "env": { "UTS_IP": "192.168.1.100" } } } }
```

Windows:

```json
{ "mcpServers": { "uni-t-uts": { "command": "cmd", "args": ["/c", "npx", "-y", "uni-t-uts-mcp"], "env": { "UTS_IP": "192.168.1.100" } } } }
```

Or from the release tarball:

```json
{ "mcpServers": { "uni-t-uts": { "command": "cmd", "args": ["/c", "npx", "-y", "https://github.com/Reid-n0rc/uni-t-uts-mcp/releases/download/v0.4.0/uni-t-uts-mcp-0.4.0.tgz"], "env": { "UTS_IP": "192.168.1.100" } } } }
```

Docker (any OS with Docker):

```json
{ "mcpServers": { "uni-t-uts": { "command": "docker", "args": ["run", "-i", "--rm", "-e", "UTS_IP=192.168.1.100", "ghcr.io/reid-n0rc/uni-t-uts-mcp:0.4.0"] } } }
```

The `github:` spec works in the same place as the package name or tarball URL (replace the last argument).

### From a clone (contributors)

```sh
git clone https://github.com/Reid-n0rc/uni-t-uts-mcp.git
cd uni-t-uts-mcp
npm ci && npm run build
npm run client-config -- --host 192.168.1.100
```

`npm run client-config` only prints, it never writes a file. It shows the exact Claude Code command and the JSON block for your OS and for the absolute path of this clone (Windows paths and `cmd /c` included). Use `--from npm`, `--from tarball`, `--from github` or `--from docker` to print the other forms, and leave out `--host` to print the config without `UTS_IP`.

## Supported platforms

Linux, macOS and Windows, with Node.js 22 or newer (CI builds and tests on `ubuntu-latest`, `macos-latest` and `windows-latest` with Node 22 and 24). A Docker image (Linux) is also provided. The analyzer must be reachable over the LAN on TCP port 5025 (raw SCPI); allow outbound connections to that port in any host firewall. For VXI-11 (`UTS_TRANSPORT=vxi11` or `auto`) also allow outbound TCP to port 111 (the portmapper) and to the dynamic core-channel port the portmapper reports (it changes between instrument restarts, so allow outbound connections to the analyzer on any port). Docker Desktop on macOS and Windows reaches LAN instruments through its outbound NAT, so no extra network setup is needed.

To set the address in a shell instead of the client configuration:

| Shell | Set `UTS_IP` for the current session |
|-------|--------------------------------------|
| bash / zsh (Linux, macOS) | `export UTS_IP=192.168.1.100` |
| PowerShell (Windows) | `$env:UTS_IP = "192.168.1.100"` |
| cmd (Windows) | `set UTS_IP=192.168.1.100` |

Probe scripts take the host as an argument or from `UTS_IP`: `node scripts/probe-basics.mjs 192.168.1.100`.

## Project site

The project site is at https://reid-n0rc.github.io/uni-t-uts-mcp/ (source in `site/`). Its "Built for real hardware" section explains, benefit first, how the server copes with the analyzer's timing quirks. The site has an optional synthwave soundtrack, generated live in your browser with the Web Audio API (no audio files, no downloads, no external requests). It starts automatically where your browser allows it, otherwise on your first click, tap or key press (a small prompt says so); scrolling does not count, because browsers do not treat it as a user gesture. The Soundtrack button at the bottom left is the first thing in the tab order and mutes it; the choice is remembered in your browser and a muted visitor never gets autoplay. The tempo is about 128 BPM; to try another, add `?bpm=128` (or `#bpm=128`) to the address: values from 60 to 180 work, anything else is ignored, and it changes nothing but the tempo. The music pauses while the tab is hidden, and the hero spectrum reacts to it. A marker flag rides the highest point of the animated spectrum, and the `marker.exe` window next to it (with a short leader line) shows that point's frequency and level; with reduced motion on, the marker stays on a fixed peak. The code is `site/soundtrack.cjs` and `site/hero-marker.cjs` (the marker maths: peak finder, frequency and level mapping, window placement), both inlined into the page at build time. Its tool list is generated from the server's own tool definitions and `docs/tools-reference.md`, so it stays current. Preview it locally with `npm run site` and open `_site/index.html`; Link previews (Open Graph and Twitter card) use `site/og.png` (1200x630); `site/social-preview.png` (1280x640) is the same picture for the repository's Settings > Social preview, which GitHub only lets the maintainer upload by hand. Both are rendered from `site/og/og.html` by `npm run og-image` (headless Chrome, with the tool count read from the registered tools after `npm run build`; pass `--chrome <path>` or set `CHROME_PATH` if Chrome is elsewhere), and the generated PNGs are committed so deploys need no browser. It is deployed by `.github/workflows/pages.yml` on every change to `main` that touches the site or the tools.

## Wiki

The [project wiki](https://github.com/Reid-n0rc/uni-t-uts-mcp/wiki) (getting started, every tool, instrument behavior, architecture, troubleshooting, roadmap) is generated from this repository and published automatically after every change to `main`, so do not edit it in the GitHub wiki editor. The Tools page comes from `docs/tools-reference.md`, Instrument Behavior from `docs/verified-hardware.md`, Home from `package.json` and the tool list, and Roadmap from the issue tracker; the other pages are hand-written in [docs/wiki/](docs/wiki/) and change through pull requests. `node scripts/sync-wiki.mjs --check` builds the pages and checks every link (CI runs it); `node scripts/sync-wiki.mjs --out <dir>` writes them to a directory. The project site is at https://reid-n0rc.github.io/uni-t-uts-mcp/.

## Documentation

Have an analyzer? The [manual testing guide](docs/manual-testing-guide.md) is a checklist for every tool group on raw and VXI-11, with a reporting template. Manual and reference links: [docs/references.md](docs/references.md).

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
