# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0.0:
new tools ship in minor releases (0.2.0, 0.3.0, ...); fixes, documentation-only and internal changes ship in patch
releases (0.2.1); a breaking change to a tool name or parameter is announced under "Changed" here and also raises the
minor version. See [docs/releasing.md](docs/releasing.md).

The text of a release's section is also used as its GitHub release notes.

## [Unreleased]

### Added
- `get_trace_data` (read-only): the amplitude values of one trace (1-6, default the selected trace) with the computed linear frequency axis (`:FREQuency:STARt?`/`:STOP?` over `:SENSe:SWEep:POINts?` points), the power unit, the trace type and summary statistics (min, max, mean, peak level and peak frequency). Zero span is detected and gets a time axis from 0 to the sweep time instead. `format` is `ascii` (default), `real32` or `real64`; for the binary formats the instrument's `:FORMat` is switched for the read and always restored (as `ASCii`), with an explicit error if the restore fails. `fresh` runs one single sweep first and puts continuous mode back. `max_points` applies peak-preserving min/max decimation and says so with the original point count; `include_axis` leaves out the per-point axis. Malformed, short or long replies and a count that differs from the sweep points are errors naming the command. Verified on a UTS3036B over raw and VXI-11.

## [0.2.0] - 2026-11-10

### Added
- Project site: the `marker.exe` readout now belongs to the animated trace. A marker flag rides the highest point of the spectrum, the readout window is anchored to it with a leader line (flipping and sliding to stay clear of the headline and the edges, and docked above the trace on phones), and its frequency and level follow the marker. With reduced motion the marker stays on a fixed peak.
- Claude Desktop one-click install: this release also attaches `uni-t-uts-mcp-0.2.0.mcpb` (an MCP bundle: double-click it, then enter the analyzer address, port and transport in the settings dialog; the address is optional). It is built with `npm run build:mcpb`, checked in CI on Ubuntu, macOS and Windows, and not code-signed. Installing it in Claude Desktop itself has not been verified yet.
- The GitHub wiki is now generated from the repository (`scripts/sync-wiki.mjs`, `docs/wiki/`) and published automatically by `.github/workflows/wiki-sync.yml` after every change to `main`; CI checks that the pages build and every link resolves. The stale wiki content (install paths, concurrency, VXI-11, trace tools, limitations) was brought up to date.
- `npm run client-config -- --host <address>` prints (never writes) the Claude Code command and the MCP JSON for your OS and paths.
- VXI-11 as a selectable transport (`UTS_TRANSPORT=raw|vxi11|auto`; `UTS_VXI11_DEVICE`, default `inst0`;
  an optional `transport` parameter on `connect`). `auto` uses VXI-11 when the analyzer registers it with
  the portmapper on port 111 and falls back to raw with a logged reason. Over VXI-11 commands sent during
  a sweep are queued instead of dropped, `single_sweep` waits with one blocking `*OPC?` read instead of
  staying silent and polling, and an unsupported query costs nothing but its timeout. `connect` and
  `identify` name the transport in use. Allow outbound TCP to port 111 and the dynamic VXI-11 port in a
  firewall. Verified on a UTS3036B against raw: every tool returns the same values, sweeps of 0.1 s to
  20 s are timed within about 100 ms, a deliberately too short timeout loses nothing.
- The screenshot transfer is **not truncated over VXI-11**: `:DISPlay:ZBmp?` returns its whole 200 KB
  stream and `:DISPlay:DATA?` the whole 4 MB bitmap (a PNG after `:SYSTem:PICture:FORMat PNG`), where raw
  TCP stops at 144,800 bytes. Readable today with `scpi_query` (`reply: "block"`); this unblocks the
  screenshot tool (#20) and the investigation in #42.

- Project site: a generated synthwave soundtrack with autoplay and a mute button (`?bpm=` tunes the tempo), and social preview images and link-preview meta tags for sharing the site.

### Changed
- The npm publish workflow supports npm trusted publishing (no token): set the repository variable `NPM_TRUSTED_PUBLISHING` to `true` after registering the workflow as a trusted publisher on npmjs.com; the `NPM_TOKEN` secret is only needed for a package's first publish.
- The default transport is now `auto` (VXI-11 when the analyzer offers it, otherwise raw) instead of
  `raw`. Giving only a port (`UTS_PORT` or the `connect` parameter) without a transport choice still
  means raw. Set `UTS_TRANSPORT=raw` to keep the old behavior.
- The package is live on npm: `npx -y uni-t-uts-mcp` (published from CI with provenance, identical to the release tarball) is now the first install command in the README, site and wiki, with the tarball, `github:` spec, Docker image and clone forms kept as alternatives. `npm run client-config -- --from npm` prints it. `docs/releasing.md` documents the trusted-publishing switch and that npm processes first publishes asynchronously. A test keeps the install commands in step with the package name and version.
- Documentation: the install instructions in the README, site and wiki are pinned to this release (tarball, `github:` tag and Docker tag), and the Claude Desktop bundle is described as attached to this release.

### Fixed
- VXI-11: a query that got no reply (an unsupported query, a too short timeout) declared the link lost
  after the timeout plus 5 s and stalled the next write. The analyzer never answers such a read with an
  I/O timeout error; the transport now sends a fifth of the timeout as the I/O timeout, fails the read
  at the requested timeout plus 0.5 s and keeps the link.

### Security
- The wiki sync treats text taken from GitHub issues as untrusted: it is sanitized before it is written to the wiki pages.

### Known limitations

- Trace data download and the screenshot tool are not available yet; both are planned for the next minor release
  (0.3.0, issues [#15](https://github.com/Reid-n0rc/uni-t-uts-mcp/issues/15) and
  [#20](https://github.com/Reid-n0rc/uni-t-uts-mcp/issues/20)). Over VXI-11 the screenshot is not truncated, so
  `scpi_query` with `reply: "block"` can already read it.
- Markers and measurements are not implemented.
- VXI-11 is verified on one analyzer model and firmware only (UTS3036B V1.04.0040); other UTS models are expected to
  be similar but are untested. Raw TCP stops screenshots at 144,800 bytes
  ([#42](https://github.com/Reid-n0rc/uni-t-uts-mcp/issues/42)).
- `start_sweep` with `wait=false` releases the instrument session before the sweep ends, so another tool call can run
  while the analyzer is still sweeping and have its commands ignored; use `single_sweep` or `wait_for_sweep_complete`
  when other calls may follow.
- The Claude Desktop `.mcpb` bundle is built and checked in CI but has not been installed in Claude Desktop itself yet,
  and it is not code-signed.

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

[Unreleased]: https://github.com/Reid-n0rc/uni-t-uts-mcp/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Reid-n0rc/uni-t-uts-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Reid-n0rc/uni-t-uts-mcp/releases/tag/v0.1.0
