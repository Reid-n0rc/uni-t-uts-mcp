# Troubleshooting

Error results always say which command failed and, where it helps, what to do next. This page explains the common ones.

## Connecting

**"Not connected to the spectrum analyzer. Use the 'connect' tool first."**
No connection is open. Either set `UTS_IP` in the MCP client's configuration (the server then connects at startup) or call `connect` with a `host`. If auto-connect failed, the reason was written to the server's stderr (check your MCP client's server log).

**`host: "auto"` / `discover_instruments` finds nothing**
- Discovery uses a UDP broadcast on port 111 on each of the computer's own IPv4 subnets, so the analyzer must be powered, have LAN enabled and be on the same subnet; it does not cross routers (give the address to `connect` instead). Firewalls and VLAN or Wi-Fi client isolation block broadcasts.
- With several analyzers, `connect` with `auto` lists them and asks for an explicit `host`.

**`connect` fails ("Connection failed", timeout, refused)**
- Check the address and that the analyzer is on the same network as your computer.
- Test the port: `nc -z -w 2 <ip> 5025` (macOS/Linux) or `Test-NetConnection <ip> -Port 5025` (Windows PowerShell).
- Check firewalls between you and the instrument. Raw SCPI uses TCP 5025.
- The host must be a hostname or IP address (letters, digits, `.`, `-`, `_`, `:`); anything else is rejected before connecting.
- `UTS_PORT` must be an integer 1-65535.

**A call fails with "Instrument busy"**
Another tool call (named in the message) held the instrument longer than `UTS_BUSY_TIMEOUT_S` seconds (default 120), typically a `single_sweep` with a long sweep time. Nothing was sent by the call that failed. Retry later, shorten the sweep time, or raise `UTS_BUSY_TIMEOUT_S`. Parallel tool calls are otherwise safe: they run one at a time in arrival order.

**VXI-11 does not connect (`UTS_TRANSPORT=vxi11`)**
VXI-11 needs outbound TCP to port 111 (the portmapper) and to the port the portmapper reports, which changes when the analyzer restarts. Check the firewall. The default `UTS_TRANSPORT=auto` falls back to raw SCPI and logs the reason to the server's stderr, and `UTS_TRANSPORT=raw` skips VXI-11 altogether. Over a slow routed path (VPN, Tailscale) raise `UTS_VXI11_PROBE_TIMEOUT_S` (total seconds, default 15, up to 120): the portmapper connect and the link are retried inside that budget, and the log line says why `auto` fell back. `UTS_VXI11_DEVICE` must be 1 to 64 characters from letters, digits and `. _ , -`.

**"Connected but failed to initialize"**
The TCP connection opened but the analyzer did not answer `*IDN?` in time. Check that the port really is the SCPI port and that nothing else is holding the instrument.

## Timeouts and slow responses

**A query timed out and the next call is slow**
An unsupported query gets no reply and makes the analyzer unresponsive for about 2 s, so the server waits 2.5 s after any timed-out query before sending anything else. This is expected; avoid sending queries the instrument does not support (see the verified list in [Instrument Behavior](Instrument-Behavior)).

**Everything times out after changing the sweep time**
While a single sweep runs, and with a very long manual sweep time even in continuous mode, the instrument ignores most commands. Wait for the sweep to finish and set the sweep time back to automatic: `set_sweep` with `sweep_time_auto: true`.

**`single_sweep` / `wait_for_sweep_complete` timed out**
The default timeout is the sweep time plus 10 s. A sweep waiting for a video trigger can take longer; either set `trigger_source: "immediate"` or pass a larger `timeout_s`. After a timeout the instrument recovers once the sweep ends.

## Values and warnings

**"adjusted by the instrument: requested X, now Y"**
Not an error. The analyzer clamps out-of-range values silently, snaps RBW/VBW to 1-3-10 steps, rounds attenuation to an integer and couples some settings. The warning tells you what it actually took. Re-read with the matching `get_*` tool.

**The reference level changed after switching the power unit**
The reference level reads back in the unit currently selected, and includes the reference level offset. `set_amplitude` applies the unit first, then the level, in that unit.

**A manual RBW/VBW/sweep time "disappeared"**
Setting a manual value turns its auto flag off, but changing the span or RBW can make automatic sweep time apply again. Re-read after changing them.

## Instrument errors

| Error | Meaning |
|-------|---------|
| `-113 "Undefined header"` | The instrument does not know the command or query. Stale ones from an earlier unsupported query appear about 4 s later; the server ignores them for 10 s after a query timeout |
| `-131 "Invalid suffix"` | A unit suffix was not understood |
| `-224 "Illegal parameter value"` | An invalid enum value (for example a bad detector or scale name) |

Errors are returned with their code, text and the commands that were sent, and say when settings may be partially applied. Use the matching `get_*` tool to see what is currently set.

## Refused commands

**"... requires confirm=true"**
`scpi_command` refuses reset, network, lock, configuration and file-write commands unless `confirm: true` is passed. See [Safety and Security](Safety-and-Security). Commands containing newlines, control characters, non-ASCII text or unbalanced quotes are always refused.

**"scpi_query only accepts queries" / "one query per call"**
`scpi_query` takes exactly one statement ending in `?`. Use `scpi_command` for commands and make separate calls for separate queries.

## Not available yet

- **Limit lines, tracking generator:** not implemented yet; see the [Roadmap](Roadmap).
- **Screenshot:** the analyzer stops a screen image after 144,800 bytes over raw TCP but delivers all of it over VXI-11 ([issue #42](https://github.com/Reid-n0rc/uni-t-uts-mcp/issues/42)). The `screenshot` tool therefore needs VXI-11: over raw TCP it refuses with an error telling you to reconnect with `transport: "vxi11"` (or `auto`).

## Still stuck?

Open an issue and include the analyzer model and firmware, how you ran the server (release tarball, git tag, Docker or a clone; Node version; OS; `UTS_TRANSPORT`), the tool call and the exact error text. Please do not post serial numbers or private network details. For security problems use private vulnerability reporting instead (see [Safety and Security](Safety-and-Security)).
