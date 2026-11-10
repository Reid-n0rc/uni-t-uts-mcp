# Safety and Security

This server can change instrument settings and, through the raw SCPI tools, send arbitrary commands. Only connect it to instruments on networks you trust, and do not expose the server to untrusted MCP clients.

## The command denylist

`scpi_command` refuses commands that are risky for the instrument unless you pass `confirm: true`. Only state-changing forms are blocked; the matching queries are fine.

| Command | Why it is blocked |
|---------|-------------------|
| `*RST` | Resets the instrument to factory defaults |
| `*SAV` | Writes (and may overwrite) a saved instrument state |
| `:SYSTem:DEFault` | Resets the instrument to factory defaults |
| `:SYSTem:LOCK`, `:KEY:*:LOCK` | Locks the front panel or keys |
| `:SYSTem:COMMunicate:LAN:*` (setters) | Changes network settings (could make the analyzer unreachable) |
| `:SYSTem:CONFigure` | Changes system configuration |
| `:MMEMory:STORe` | Writes files on the instrument |

An assistant should only set `confirm: true` with the user's explicit approval for that command.

### How the check works

The denylist parser is written to fail closed:

- Matching is case-insensitive and understands SCPI short forms (`SYST:DEF`, `:syst:comm:lan:ipad ...`).
- `;`-joined lines are checked statement by statement, with relative paths resolved the way the instrument would.
- CR and LF end a message (a second command after a newline is still checked); a lone CR, other control characters and any non-ASCII text are refused outright.
- Unterminated quotes and malformed or truncated `#<n><length>` binary blocks are refused, because the checker and the instrument could disagree about where a command ends.
- `scpi_query` accepts exactly one query, so the read-only tool cannot carry a command.
- The connection layer independently refuses to send any command containing CR/LF, control characters or non-ASCII.

## What the server never does by itself

- It never sends `*RST`, `*SAV`, factory resets, network setting changes, lock commands or file writes unless a command with `confirm: true` is sent.
- It never writes the instrument's serial number or IP address anywhere; the repository's rules forbid committing either.

## Network discovery trust model

`discover_instruments` and `host: "auto"` use the unauthenticated ONC RPC portmapper: they broadcast on each local subnet only (never a scan of ranges or ports), accept replies only from ordinary hosts inside that subnet and only an unprivileged VXI-11 port, send only `*IDN?` to responders, and show the identification quoted and without the serial number. `auto` connects only when exactly one UNI-T analyzer answers and always reports which host it picked. Anything on your LAN can imitate an analyzer, so check the reported model and address.

## Reporting a vulnerability

Please report vulnerabilities **privately**, not in a public issue. Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability** ([direct link](https://github.com/Reid-n0rc/uni-t-uts-mcp/security/advisories/new)). Please include what is affected, the impact, steps to reproduce, the version or commit, your Node.js version and how you ran the server. Do not include instrument serial numbers or real IP addresses.

Areas of most interest: the denylist and parser (`src/scpi.ts`), the raw SCPI tools, the connection layer (framing, command injection, resource exhaustion), and the Docker image and GitHub Actions workflows. Vulnerabilities in the analyzer's own firmware are out of scope (report those to the vendor).

The full policy is in [SECURITY.md](https://github.com/Reid-n0rc/uni-t-uts-mcp/blob/main/SECURITY.md).
