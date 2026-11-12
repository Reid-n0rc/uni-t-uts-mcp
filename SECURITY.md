# Security Policy

## Supported versions

This project is pre-release. Security fixes go to the latest commit on `main`; once versions are published, only the latest release is supported.

## Reporting a vulnerability

Please report vulnerabilities **privately**. Do not open a public issue.

Use GitHub's private vulnerability reporting: go to the repository's **Security** tab and choose **Report a vulnerability** (https://github.com/Reid-n0rc/uni-t-uts-mcp/security/advisories/new).

Please include:
- what is affected and the impact you see
- steps or a proof of concept to reproduce
- the version or commit, Node.js version, and how you ran the server (npx, Docker, from source)

Please do not include instrument serial numbers, real IP addresses, or other private network details; placeholders are fine.

You can expect an acknowledgement within about 7 days. This is a volunteer project, so fix times vary; reporters are credited in the advisory unless they prefer otherwise.

## Scope

This server sends SCPI commands to lab instruments over the network, so the areas of most interest are:

- the command denylist and parser in `src/scpi.ts` (bypasses that let state-changing or destructive commands run without `confirm`)
- the raw `scpi_command` / `scpi_query` tools and any path where untrusted text reaches the instrument
- network discovery (`src/discovery.ts`): the UDP portmapper broadcast and its replies are untrusted input (spoofed or off-subnet responders, malformed datagrams, resource use); `host=auto` must never connect to something the user cannot see
- the TCP connection layer (framing, injection of extra commands, resource exhaustion)
- the Docker image and the GitHub Actions workflows (secrets, supply chain)

Out of scope: vulnerabilities in the analyzer's own firmware (report those to the vendor), and issues that require an attacker who already controls the machine running the server or the instrument.

## Note for users

The server can change instrument settings. Only connect it to instruments on networks you trust, and don't expose it to untrusted MCP clients.

**The UTS3036B itself (V1.04.0040, confirmed by firmware disassembly, out of this project's scope to fix) has its own exposure independent of this server:** it runs the Eclipse/Xilinx TCF debug agent as root with no authentication at all (reachable over the network on the TCP port its UDP beacon on port 1534 advertises — full remote shell and filesystem access), enables SSH with blank passwords allowed and a root password hash that is identical on every unit, and starts a vendor `frpc` reverse tunnel unconditionally at every boot that publishes the web UI, the SCPI control websocket and the screen stream to a UNI-T server with no auth token (there is no way to disable this from the instrument's UI). Keep this analyzer, like any lab instrument, on an isolated or trusted network segment; block outbound TCP/7000 at your firewall if you don't want it reaching UNI-T's servers.
