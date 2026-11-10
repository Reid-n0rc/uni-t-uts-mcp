# Architecture

TypeScript, stdio MCP server, built on the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk). The layout follows [siglent-sds-mcp](https://github.com/MagnusJohansson/siglent-sds-mcp); the implementation is original.

```
MCP client (Claude, Inspector, ...)
        |  stdio
        v
src/index.ts ── createServer() in src/server.ts ── registers the tool groups
        |
        v
src/tools/*.ts   one file per tool group; every tool is registered through defineTool
        |             (src/tools/util.ts), which runs it as one exclusive session
        v
src/sessionLock.ts  FIFO exclusive-session lock behind connection.runExclusive
        |
        v
src/instrument.ts   applyCommands (*CLS, send, check error queue), strict reply parsing, warnings helpers
src/acquisition.ts  sweep start/complete synchronization
src/errors.ts       error-queue drain
src/scpi.ts         number/bool formatting and parsing, the safety denylist
        |
        v
src/connection.ts   serialized queue, *OPC? sync, timeouts, hold-off, on top of a transport
src/blocks.ts       IEEE 488.2 "#" block parser (handles LF and CRLF trailers)
        |
        v
src/transports/     raw SCPI over TCP (raw.ts) or VXI-11 (vxi11.ts, on src/vxi11/)
        |
        v
TCP port 5025 (raw), or port 111 and the core-channel port (VXI-11), on the analyzer
```

Other files: `src/autoconnect.ts` (connect from `UTS_IP`, `UTS_PORT`, `UTS_TRANSPORT` at startup, never throws) and `src/target.ts` (host and port validation).

## The connection layer

`UtsConnection` (`src/connection.ts`) is a singleton, on top of a pluggable transport, that turns the analyzer's quirks (see [Instrument Behavior](Instrument-Behavior)) into predictable behavior:

- **One serialized queue** for commands and queries. A command is never written in the middle of a pending query.
- **Commands are synced with `*OPC?`.** After each command it waits for the `*OPC?` reply before anything else is written (default timeout 3 s). A command can opt out (`sync: false`), which the sweep helper does.
- **Every query has a timeout** (default 5 s text, 30 s binary) that names the command.
- **Hold-off after a timeout:** the next job waits until 2.5 s after the failed query was sent, because the instrument stalls after an unsupported query.
- **`msSinceQueryTimeout()`** lets callers recognize stale `-113` errors posted after an unsupported query.
- **Binary replies** (`queryBinary`) use the block parser and swallow a late CR/LF trailer so it can never be read as the next reply.
- **Input hygiene:** a command containing CR/LF, control characters or non-ASCII is refused before sending, so one call can never smuggle a second command.
- Pending and queued jobs are rejected cleanly when the connection is closed or lost; "not connected" tells the user to call `connect`.

## Transports

The wire under the connection is a `Transport` (`src/transports/transport.ts`). Two exist:

- **Raw SCPI over TCP** (default, port 5025): LF-terminated lines, CRLF replies, `#` binary blocks assembled in `raw.ts`. While a single sweep runs the analyzer ignores every line it receives, so the sweep helper stays silent and polls `*OPC?`.
- **VXI-11** (`UTS_TRANSPORT=vxi11`, or `auto`): ONC RPC over TCP through the portmapper on port 111, implemented without dependencies in `src/vxi11/`. The analyzer queues commands sent during a sweep instead of dropping them, so the sweep helper writes `:INITiate:IMMediate` and does one blocking `*OPC?` read.

Wire differences are expressed as capability flags (`syncsCommands`, `dropsInputDuringSweep`, `holdOffAfterTimeout`), never as transport-name checks in tools, so a tool behaves the same on both. `UTS_TRANSPORT` is `raw` (default), `vxi11` or `auto` (VXI-11 when the analyzer registers it with the portmapper, else raw); `UTS_VXI11_DEVICE` names the device (default `inst0`). New transports must pass the shared contract suite `tests/transportContract.ts`.

## Concurrency: one tool call at a time

An MCP client may send several tool calls at once, but the analyzer has one command stream, one global error queue and ignores commands during a single sweep. So **each tool's whole operation is one exclusive session**: `defineTool` runs the handler inside `connection.runExclusive`, a first-in first-out lock (`src/sessionLock.ts`) that nested helper calls join, so `applyCommands` never deadlocks. Results and errors of parallel calls are never mixed up.

- A long operation such as `single_sweep` makes the other calls wait their turn.
- A call that waits longer than `UTS_BUSY_TIMEOUT_S` seconds (default 120) fails with `Instrument busy` and nothing was sent.
- The session is released on every path: when the tool returns, fails or times out, or when the connection is closed or lost (which also fails every waiting call).
- Invalid input is refused before waiting for the lock.
- A sweep started with `start_sweep` and `wait=false` releases the lock when that call returns, so use `single_sweep` or `start_sweep` with `wait=true` unless `wait_for_sweep_complete` follows.

The tool contract test runs every tool in parallel as well, and fails if a tool bypasses `defineTool`.

## Anatomy of a setter call

Taking `set_frequency` as the example:

1. **Validate** the arguments (nothing is sent if they are invalid; coupled parameter groups cannot be mixed).
2. **`applyCommands`** sends `*CLS`, then each command (each synced with `*OPC?`), then reads `:SYSTem:ERRor?` until it reports no error. Errors from the instrument become an error result with their code and text; a failure part-way lists the commands already sent.
3. **Read the state back** with strict parsers (`queryNumber`, `queryBool`, `queryParsed`).
4. **Compare** requested and actual values and return the state plus `warnings` for anything the instrument changed or clamped.

Getters are the same idea without steps 1 to 2: strict parsing, a malformed or empty reply is an error that names the command and quotes the reply, and a getter that fails part-way never returns partial data.

## Sweep synchronization

`src/acquisition.ts` picks the wait by the transport's capabilities. On the raw socket the only completion signal that works is: start the sweep without the usual `*OPC?` sync, stay silent for the sweep time read from `:SENSe:SWEep:TIME?`, then poll `*OPC?` with a short timeout until the first reply. Over VXI-11 it writes `:INITiate:IMMediate` and does one blocking `*OPC?` read. The timeout defaults to the sweep time plus 10 s, which also covers a sweep waiting for a video trigger.

## Error handling standard

Required of every tool and enforced by a contract test:

1. Tools never throw; failures are error results with actionable messages.
2. Setters validate, apply with `applyCommands`, read back, and report adjusted values as warnings.
3. Getters parse strictly and fail whole rather than return partial data.
4. Multi-step operations that change temporary state restore it (try/finally), and say so if restoring fails.
5. Connection problems (not connected, closed, timeout, write failure) each have a distinct message.
6. Hardware behavior (clamp vs error vs ignored) is documented per tool.
7. Every tool has failure-mode tests.

`tests/integration/tool-contract.test.ts` runs every registered tool against a fake connection under not-connected, timeout, write-failure, garbage-reply, empty-reply, instrument-error and part-way-failure modes, and fails if a tool is missing from its table. A second test fails if a registered tool has no section in `docs/tools-reference.md`.

## Known limitations

- **One instrument at a time** (a single connection). Multiple instruments are a proposal: [issue #67](https://github.com/Reid-n0rc/uni-t-uts-mcp/issues/67).
- **VXI-11 is not yet verified on the real analyzer.** It has been checked against a fake instrument and prototype measurements; the default transport stays raw until [issue #75](https://github.com/Reid-n0rc/uni-t-uts-mcp/issues/75) is done.
- **A long sweep blocks other tool calls**, by design, up to `UTS_BUSY_TIMEOUT_S`.
- **Not implemented yet:** trace data fetch, markers, measurements and screenshots (the analyzer stops a screenshot transfer after 144,800 bytes over LAN, [issue #42](https://github.com/Reid-n0rc/uni-t-uts-mcp/issues/42)). See the [Roadmap](Roadmap).
