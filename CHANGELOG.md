# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0.0 the tool
names, parameters and result shapes may still change between minor versions; see
[docs/releasing.md](docs/releasing.md).

The text of a release's section is also used as its GitHub release notes.

## [Unreleased]

### Added
- Project site: the `marker.exe` readout now belongs to the animated trace. A marker flag rides the highest point of the spectrum, the readout window is anchored to it with a leader line (flipping and sliding to stay clear of the headline and the edges, and docked above the trace on phones), and its frequency and level follow the marker. With reduced motion the marker stays on a fixed peak.
- Claude Desktop one-click install: releases made after this change also attach `uni-t-uts-mcp-<version>.mcpb` (an MCP bundle: double-click it, then enter the analyzer address, port and transport in the settings dialog; the address is optional). It is built with `npm run build:mcpb`, checked in CI on Ubuntu, macOS and Windows, and not code-signed. Installing it in Claude Desktop itself has not been verified yet.
- The GitHub wiki is now generated from the repository (`scripts/sync-wiki.mjs`, `docs/wiki/`) and published automatically by `.github/workflows/wiki-sync.yml` after every change to `main`; CI checks that the pages build and every link resolves. The stale wiki content (install paths, concurrency, VXI-11, trace tools, limitations) was brought up to date.
- `npm run client-config -- --host <address>` prints (never writes) the Claude Code command and the MCP JSON for your OS and paths.
- VXI-11 as a selectable transport (`UTS_TRANSPORT=raw|vxi11|auto`, default `raw`; `UTS_VXI11_DEVICE`,
  default `inst0`; an optional `transport` parameter on `connect`). `auto` uses VXI-11 when the
  analyzer registers it with the portmapper on port 111 and falls back to raw with a logged reason.
  Over VXI-11 commands sent during a sweep are queued instead of dropped, and `single_sweep` waits
  with one blocking `*OPC?` read instead of staying silent and polling. `connect` and `identify` name
  the transport in use. Hardware verification of every tool over VXI-11 is still pending, so the
  default stays raw. Allow outbound TCP to port 111 and the dynamic VXI-11 port in a firewall.

### Changed
- The package is live on npm: `npx -y uni-t-uts-mcp` (0.1.0, published from CI with provenance, identical to the release tarball) is now the first install command in the README, site and wiki, with the tarball, `github:` spec, Docker image and clone forms kept as alternatives. `npm run client-config -- --from npm` prints it. `docs/releasing.md` documents the trusted-publishing switch and that npm processes first publishes asynchronously. A test keeps the install commands in step with the package name and version.

## [0.1.0] - 2026-11-10

First release. Every tool listed here was tested against a real UNI-T UTS3036B (firmware V1.04.0040, the
latest published at the time) over LAN; see [docs/verified-hardware.md](docs/verified-hardware.md).

### Added

- Tools for connecting and identifying: `connect`, `disconnect`, `identify`. Setting `UTS_IP` (and
  optionally `UTS_PORT`) connects automatically at startup without blocking it.
- Raw SCPI tools: `scpi_query` (single queries only, text or binary-block replies) and
  `scpi_command` (setters, synced and error-checked).
- Frequency tools: `get_frequency`, `set_frequency`.
- Amplitude tools: `get_amplitude`, `set_amplitude`.
- Bandwidth, sweep and detector tools: `get_bandwidth`, `set_bandwidth`, `get_sweep`, `set_sweep`,
  `get_detector`, `set_detector`.
- Acquisition tools: `get_acquisition`, `set_acquisition`, `single_sweep`, `start_sweep`,
  `wait_for_sweep_complete`.
- Trace tools: `get_trace`, `set_trace`, `restart_trace`, `set_trace_math`.
- Parsers and helpers for IEEE 488.2 binary blocks and SCPI values.
- Not implemented yet: markers, measurements and the screenshot tool (see the
  [roadmap](https://github.com/Reid-n0rc/uni-t-uts-mcp/issues/1)).

### Safety

- `scpi_command` refuses commands on a confirm-required denylist (`*RST`, `*SAV`,
  `:SYSTem:DEFault`, `:SYSTem:LOCK`, `:KEY:*:LOCK`, LAN setters, `:SYSTem:CONFigure`,
  `:MMEMory:STORe`) unless `confirm=true` is passed.
- The denylist is hardened against embedded terminators, control and non-ASCII characters,
  unterminated quotes, malformed `#` blocks and `*SAV`; it fails closed when a line cannot be parsed.
- `scpi_query` accepts exactly one query per call.
- Security policy and private vulnerability reporting (`SECURITY.md`); CodeQL code scanning.

### Error handling and reliability

- Tools never throw: failures are `isError` results that name the command and what to do next,
  with distinct messages for not connected, closed, timeout and write failure. A contract test
  enforces this for every tool.
- Setters validate input, clear the error queue, sync each command with `*OPC?`, check
  `:SYSTem:ERRor?`, read the state back and report values the instrument adjusted as warnings.
- Getters parse replies strictly; malformed or empty replies are errors, never partial data.
- Connection handling: serialized query queue, command pacing, a hold-off after unsupported-query
  stalls, stale `-113` errors ignored, CRLF handling after replies and blocks, single-sweep
  synchronisation that works around the instrument ignoring commands while a sweep runs.
- Tool calls are serialized per instrument: every tool runs inside an exclusive session, so several tool calls
  issued at the same time can no longer interleave their commands or blame errors on the wrong call. A call that
  waits too long gets a clear `Instrument busy` error (default 120 s, configurable with `UTS_BUSY_TIMEOUT_S`).
  A test fails if a tool is registered without the session wrapper.
- A transport abstraction under the connection, preparing for VXI-11 support.

### Platform support

- Linux, macOS and Windows with Node.js 22 or newer; CI builds and tests on all three with
  Node 22 and 24, plus a Docker image built from the `Dockerfile`.
- Tag-triggered release workflows: a GitHub release with the packed tarball attached, the GHCR Docker image,
  and an optional npm publish with provenance that is skipped until an npm token is configured.
- Installable straight from a git tag (`npx -y github:Reid-n0rc/uni-t-uts-mcp#<tag>`): the `prepare` script builds it.

### Documentation, site and wiki

- README, [tools reference](docs/tools-reference.md), [verified hardware](docs/verified-hardware.md)
  results, [programming guide](docs/programming-guide.md) notes and [references](docs/references.md).
- Project site on GitHub Pages, generated from the server's tool definitions and the tools reference.
- Wiki pages and plain-wording documentation passes.
- Contributor documentation: `AGENTS.md`, `CONTRIBUTING.md`, code of conduct, pull request template.
- Release process documentation ([docs/releasing.md](docs/releasing.md)) and release smoke tests
  (tarball contents, `npx`-style install and Docker image start-up) in CI.

### Known limitations

- `start_sweep` with `wait=false` releases the instrument session before the sweep ends, so another tool call
  can run while the analyzer is still sweeping and have its commands ignored; use `single_sweep` or
  `wait_for_sweep_complete` when other calls may follow.
- Markers, measurements, trace data download and the screenshot tool are not implemented yet; the analyzer
  stops sending screenshots after 144,800 bytes over the raw LAN port
  ([#42](https://github.com/Reid-n0rc/uni-t-uts-mcp/issues/42)).
- Only the raw TCP transport (port 5025) is available; a VXI-11 transport is in progress
  ([#64](https://github.com/Reid-n0rc/uni-t-uts-mcp/issues/64)).
- Verified on one analyzer model and firmware (UTS3036B V1.04.0040); other UTS models are expected to be
  similar but are untested.

[Unreleased]: https://github.com/Reid-n0rc/uni-t-uts-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Reid-n0rc/uni-t-uts-mcp/releases/tag/v0.1.0
