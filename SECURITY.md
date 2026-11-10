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
- the TCP connection layer (framing, injection of extra commands, resource exhaustion)
- the Docker image and the GitHub Actions workflows (secrets, supply chain)

Out of scope: vulnerabilities in the analyzer's own firmware (report those to the vendor), and issues that require an attacker who already controls the machine running the server or the instrument.

## Note for users

The server can change instrument settings. Only connect it to instruments on networks you trust, and don't expose it to untrusted MCP clients.
