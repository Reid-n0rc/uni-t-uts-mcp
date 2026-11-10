# Contributing

Thanks for helping out. This project is an MCP server for UNI-T UTS series spectrum analyzers.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). To report a security issue, see [SECURITY.md](SECURITY.md) (please do not open a public issue). Contributions are licensed under the [MIT License](LICENSE).

## Getting started

Requires Node.js 22+ (CI tests 22 and 24 on Linux, macOS and Windows, so keep code and tests portable: use `node:path`/`new URL`, no shell-outs, no hard-coded `/tmp`, and do not rely on sub-15 ms timer precision). `.gitattributes` keeps `tests/fixtures/**` byte-exact; do not re-save fixtures through an editor that changes line endings.

```sh
git clone https://github.com/Reid-n0rc/uni-t-uts-mcp.git
cd uni-t-uts-mcp
npm ci
npm run build
npm test
```

Use `npm run inspector` to try the server interactively with the MCP Inspector.

## Making changes

1. Open an issue first for anything non-trivial so we can agree on scope.
2. Every PR must be tied to an issue (`Closes #<n>`). Branch `issue-<n>-<slug>` from `main`, keep PRs small and focused.
3. Add or update tests (vitest). Integration tests mock the connection; no hardware is needed to run them.
4. Document new or changed tools in `docs/tools-reference.md`.
5. Make sure `npm run build` and `npm test` pass.
6. Signed commits are encouraged but not required.

## Tool guidelines

- SCPI commands must come from the UNI-T programming manual; cite the section when unclear.
- Mark read-only tools `readOnlyHint: true`.
- Return errors as `isError: true` results with a clear message, never throw out of a handler.

## Hardware testing

If you have a UTS1000B/T or UTS3000B, please say which model and firmware you tested on in the PR. See `docs/manual-testing-guide.md` once it exists.

## Reporting bugs

Include: analyzer model and firmware, connection method, the tool call, and the error or unexpected output. Don't post serial numbers or private network details.
