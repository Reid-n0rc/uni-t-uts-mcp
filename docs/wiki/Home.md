# uni-t-uts-mcp

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that lets an AI assistant control a **UNI-T UTS series spectrum analyzer** (UTS1000B/T, UTS3000B) over your local network. It talks SCPI over VXI-11 when the analyzer offers it, or over a raw TCP socket (port 5025), so there are no VISA drivers to install.

> **Status:** release **v<!--VERSION-->** is out. It has <!--TOOL_COUNT--> tools in <!--GROUP_COUNT--> groups, verified on a **UNI-T UTS3036B, firmware V1.04.0040**, over LAN. Limit lines and the tracking generator are not implemented yet (see the [Roadmap](Roadmap)). You can install it from the npm registry (`npx -y uni-t-uts-mcp`), the release tarball, the git tag or a Docker image (see [Getting Started](Getting-Started)).

## What you can do today

<!--TOOL_GROUPS-->

Example requests to your assistant once the server is connected:

- "Identify the analyzer and show me its current frequency, amplitude and bandwidth settings."
- "Set the center to 100 MHz with a 10 MHz span and a 10 kHz RBW."
- "Set the reference level to -20 dBm with 5 dB per division."
- "Show trace 2 as max hold, then restart it."
- "Take a single sweep and tell me when it is finished."

Every setter reads the instrument back and tells you when the analyzer changed or clamped a value (this unit clamps silently), and reports instrument errors with their code and text. Parallel tool calls are safe: the server runs tool calls one at a time per instrument, in arrival order (see [Architecture](Architecture)).

## Wiki pages

- [Getting Started](Getting-Started): requirements, install paths, configuring your MCP client
- [Tools](Tools): every tool with its parameters and behavior
- [Instrument Behavior](Instrument-Behavior): what was verified on the real analyzer, including the quirks that shape the design
- [Architecture](Architecture): how the server is built and how a tool call flows through it
- [Safety and Security](Safety-and-Security): the command denylist and how to report vulnerabilities
- [Troubleshooting](Troubleshooting): common problems and what they mean
- [Development](Development): workflow, tests, adding a tool, hardware testing rules, how this wiki is kept up to date
- [Roadmap](Roadmap): open and completed issues

## Also available

- The [project site](https://reid-n0rc.github.io/uni-t-uts-mcp/) with a quick start and the tool list.
- The repository docs: [tools-reference.md](https://github.com/Reid-n0rc/uni-t-uts-mcp/blob/main/docs/tools-reference.md), [verified-hardware.md](https://github.com/Reid-n0rc/uni-t-uts-mcp/blob/main/docs/verified-hardware.md), [programming-guide.md](https://github.com/Reid-n0rc/uni-t-uts-mcp/blob/main/docs/programming-guide.md) (SCPI syntax extracted from the UNI-T manuals) and [references.md](https://github.com/Reid-n0rc/uni-t-uts-mcp/blob/main/docs/references.md) (manual links).
- The [roadmap issue #1](https://github.com/Reid-n0rc/uni-t-uts-mcp/issues/1).

## Where this wiki comes from

This wiki is built from the repository by `scripts/sync-wiki.mjs` and published automatically after every change to `main`, so edits made directly in the GitHub wiki editor are overwritten. Tools, Instrument Behavior, Home (the status and tool table) and Roadmap are generated from `docs/tools-reference.md`, `docs/verified-hardware.md`, `package.json` and the issue tracker; the other pages live in `docs/wiki/` and change through pull requests. See [Development](Development).

## License

[MIT](https://github.com/Reid-n0rc/uni-t-uts-mcp/blob/main/LICENSE)
