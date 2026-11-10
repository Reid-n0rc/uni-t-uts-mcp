# Agent notes

Instructions for AI coding agents (Claude Code, Codex, etc.) working in this repo. `CLAUDE.md` points here.

## Project

MCP server (TypeScript, stdio) for UNI-T UTS series spectrum analyzers (UTS1000B/T, UTS3000B) over SCPI. Layout is modeled on [siglent-sds-mcp](https://github.com/MagnusJohansson/siglent-sds-mcp):

- `src/index.ts` – server entry, registers tool groups
- `src/connection.ts` – SCPI connection singleton: serialized queue, query timeouts, hold-off after a timed-out query, `*OPC?` command pacing, `msSinceQueryTimeout`, `expectSilence`
- `src/transports/` – the wire under `UtsConnection`. `transport.ts` defines the internal `Transport` interface (open/close/isOpen/onLost, `write` a line, `readLine`/`readBlock` with a timeout, `discardInput`) and its capability flags; `raw.ts` is raw SCPI over TCP (framing, CRLF, `#` block assembly, late-terminator swallowing); `vxi11.ts` is SCPI over the VXI-11 core channel on `Vxi11Client` (its capability flags are explicit documented constants, `VXI11_CAPABILITIES`, because hardware verification, #75, may turn `*OPC?` pacing or the hold-off back on; a reply left unread after a timeout is read away before the next write); `select.ts` parses `UTS_TRANSPORT` (raw|vxi11|auto, default raw) and `UTS_VXI11_DEVICE`, validates the device name and probes the portmapper for `auto`. `UtsConnection.connect` takes `transport`/`vxi11Device` options and names a non-raw transport in its error messages. `src/acquisition.ts` picks the sweep wait by the `dropsInputDuringSweep` flag: raw stays silent and polls `*OPC?`, a transport that queues input writes `:INITiate:IMMediate` then does one blocking `*OPC?` read. Wire differences are expressed as capability flags (`syncsCommands`, `dropsInputDuringSweep`, `holdOffAfterTimeout`, read via `connection.capabilities`), never as transport-name checks in tools. A new transport implements `Transport` and passes `tests/transportContract.ts` by calling `runTransportContract` with its own factory and fake instrument
- `src/vxi11/` – dependency-free ONC RPC stack under the VXI-11 transport (#64): `xdr.ts` (bounds-checked XDR codec), `rpc.ts` (RPC v2 over TCP, record marking, xid matching, typed `Rpc*Error`s), `portmapper.ts` (`getPort`), `client.ts` (`Vxi11Client`: connect via portmapper or explicit port, chunked `write`, `read` looping until END, `readStb`, `clear`, `close`; typed `Vxi11*Error`s with every VXI-11 error code named). Parses network input: keep every length capped and use `>>> 0` for the 0x80000000 record-marking bit (JS bitwise ops are signed)
- `tests/fakeRpcServer.ts` – in-process fake ONC RPC server + portmapper, reused by the VXI-11 fake instrument
- `tests/fakeVxi11Instrument.ts` – fake VXI-11 core-channel instrument (scriptable SCPI handler, simulated I/O timeouts, injected errors, dropped connections, and a simulated sweep that queues commands and answers `*OPC?` only when the sweep ends)
- `src/sessionLock.ts`, `connection.runExclusive` – the per-connection FIFO exclusive-session lock; transport independent. Tools are serialized per instrument (see "Concurrency" below)
- `src/tools/*.ts` – one file per tool group, each exporting `register<Group>Tools(server)`; every tool is registered with `defineTool(server, name, description, shape, annotations, handler, options?)` from `src/tools/util.ts`
- `tests/unit/`, `tests/integration/` – vitest; integration tests mock `src/connection.js`
- `docs/` – `references.md` (manuals and links), `verified-hardware.md` (what was tested on), tools reference, programming-guide notes, manual testing guide

Commands: `npm run build`, `npm test`, `npm run inspector`.

## Rules

- Commit as reid@malmoset.com (repo-local git config; check before committing).
- Sign commits (already configured globally); signing is encouraged but not required of contributors.
- Push issue branches and open PRs as described under Process. The maintainer has authorized merging green PRs into `main`. Do not tag, create releases, or bump versions without explicit go-ahead.
- Do not bump version numbers unless asked. Releases follow `docs/releasing.md` (GitHub release with tarball + GHCR image; npm is optional). User-visible changes add a line under `## [Unreleased]` in `CHANGELOG.md` in the same PR. Keep `package.json` free of npm auto-corrections (e.g. no `./` in `bin`); CI's `package contents`, install, git-install and docker smoke jobs guard the published package.
- Never commit secrets, device IPs/serials, or `.mcp.json`.
- Keep each task/issue small enough to finish in one context window; split larger work.
- Every new tool needs an integration test with a mocked connection and a `### \`tool_name\`` section in `docs/tools-reference.md` (a test fails if a registered tool is undocumented).
- **The project site is generated, not hand-maintained.** `site/index.html` is a template; the tool list on https://reid-n0rc.github.io/uni-t-uts-mcp/ comes from the server's tool definitions (descriptions) and the `## Group` / `### \`tool\`` headings of `docs/tools-reference.md`, built by `scripts/build-site.mjs` (`npm run site`). Keep those headings parseable and give every tool a clear first sentence. Hand-written site text ("Built for real hardware" cards, quick start, roadmap chips) must be updated in the same PR when the facts change. The site is self-contained: no external scripts, fonts, images or CDNs (a test enforces this).
- **Docs are part of done, updated in the same PR as the change.** A PR that adds or changes a tool, a hardware finding or instrument quirk, a workflow rule, or the project layout also updates the matching docs: `docs/tools-reference.md`, `docs/verified-hardware.md`, `docs/programming-guide.md`, `README.md` and `AGENTS.md`. Do not leave documentation for a later task.
- Mark read-only tools with `readOnlyHint: true`.
- Source of truth for commands is the UNI-T programming manual; links are in `docs/references.md`; cite the manual section in code comments when a command is non-obvious. Do not guess SCPI syntax.
- Do not copy source from other projects without keeping their license notices.

## Process

- **Issues first.** Work is tracked as GitHub issues: one roadmap/epic issue plus small task issues. Do not start a task without an issue.
- **Task sizing.** Each task must fit in one context window: one tool group or one module, with its tests and docs. Split anything larger.
- **Test-driven.** For every task: write failing tests first (commit them or keep them in the same PR as the first commit), then implement until green, then refactor. Tests use a mocked connection; hardware checks are separate, manual, and recorded in `docs/verified-hardware.md`.
- **Incremental commits.** One logical change per commit (tests, implementation, docs may be separate commits), each building and passing on its own, so a person can audit the history.
- **Issue → work → PR.** Every PR must be tied to an issue: open the issue first, do the work on branch `issue-<n>-<slug>` from `main`, then open one PR with `Closes #<n>`. No PR without an issue. Each issue gets its own new branch, and its work reaches `main` only by merging that PR; never commit or push issue work directly to `main`.
- **Privacy.** Never put device serial numbers or real IP addresses in the repo, issues, or PRs.

## Concurrency (required for every tool)

MCP clients may issue parallel tool calls, and the analyzer has one command stream, one global error queue and ignores commands during a single sweep. So **each tool's whole operation is one exclusive session**:

- **Register every tool with `defineTool`** (`src/tools/util.ts`), never `server.tool()`/`registerTool()`. `defineTool` runs the handler inside `connection.runExclusive` (FIFO, nested helper calls join the session through AsyncLocalStorage, so helpers like `applyCommands` never deadlock), turns a busy timeout or any thrown error into an `isError` result, and `createServer()` makes `server.tool`/`registerTool` throw, so a bypass fails at startup and in the tests (`tests/integration/tool-contract.test.ts` also scans `src/tools` and checks every instrument operation ran inside a session).
- Put pure input validation (no instrument access) in the `validate` option of `defineTool` so an invalid call is refused without waiting for a long sweep. `exclusive: false` is only for `disconnect`.
- Do not hold the session across user-visible waiting that is not needed, and do not start work that outlives the handler (fire-and-forget calls would escape the lock). A tool that starts a sweep must also wait for it inside the same handler.
- Tests: add the tool to the `CONTRACT` table; the contract test then also runs it in parallel mode (three copies at once and all tools at once, failures attributed to the owning call). Tests that mock `src/connection.js` with a hand-made object must provide `runExclusive: (fn) => fn()`.
- The wait limit is `UTS_BUSY_TIMEOUT_S` (default 120 s). Wiki pages that describe tool behavior or error handling should state the guarantee (issue #70).

## Error handling standard

Required for every tool that talks to the instrument. `tests/integration/tool-contract.test.ts` enforces it: it runs every registered tool against the fake connection in `tests/toolContract.ts` under not-connected, timeout, write failure, garbage/empty reply, instrument error and part-way failure modes. **A new tool must be added to the `CONTRACT` table in `tests/toolContract.ts` (kind, valid args, invalid args, args that must produce a warning) or that test fails.** Add canned replies for any new query to `QUERY_REPLIES` there.

1. **Tools never throw.** Every handler wraps everything in try/catch and returns `errorResult(...)` (isError, actionable message: what failed, which command, what to do next). No unhandled promise rejections, including fire-and-forget calls (use `.catch`).
2. **Setters:** validate input first (nothing is sent if invalid), then `applyCommands` (`*CLS`, each command synced with `*OPC?`, `:SYSTem:ERRor?` checked), then read the state back through `readBack(...)` and report every requested value, flag or enum the instrument did not take as a `warnings` entry (this unit clamps silently; check auto flags too). Failures go through `setterFailure(err, "get_x")`: instrument errors carry their code and text and say the settings may be partially applied.
3. **Getters:** parse every reply with `queryNumber` / `queryBool` / `queryParsed` (`src/instrument.ts`); a malformed or empty reply is a `ReplyError` naming the command and quoting the reply. A timeout names the command. A getter that fails part-way returns an error, never partial data.
4. **Multi-step operations** that change temporary state use try/finally to restore it; if restoring fails, say so. If a tool deliberately leaves state changed (e.g. `single_sweep` leaves single mode), failures say so.
5. **Connection problems** (not connected, closed, timeout, write failure) each have a distinct message; not-connected tells the user to call `connect`. A connection lost mid-operation names the command in flight, and `applyCommands` lists the commands that may already be applied (including the one in flight). The standard was checked on real hardware in issue #63 (see `docs/verified-hardware.md`).
6. **Hardware behavior** (clamp vs error vs ignored) is documented per tool in `docs/verified-hardware.md`.
7. **Every tool has failure-mode tests**, not only happy paths (the contract test covers the common modes; add tool-specific ones next to the tool's tests).
