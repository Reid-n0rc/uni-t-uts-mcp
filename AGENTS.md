# Agent notes

Instructions for AI coding agents (Claude Code, Codex, etc.) working in this repo. `CLAUDE.md` points here.

## Project

MCP server (TypeScript, stdio) for UNI-T UTS series spectrum analyzers (UTS1000B/T, UTS3000B) over SCPI. Layout is modeled on [siglent-sds-mcp](https://github.com/MagnusJohansson/siglent-sds-mcp):

- `src/index.ts` – server entry, registers tool groups
- `src/connection.ts` – SCPI connection singleton with a query queue
- `src/tools/*.ts` – one file per tool group, each exporting `register<Group>Tools(server)`
- `tests/unit/`, `tests/integration/` – vitest; integration tests mock `src/connection.js`
- `docs/` – tools reference, programming-guide notes, manual testing guide

Commands: `npm run build`, `npm test`, `npm run inspector`.

## Rules

- Commit as reid@malmoset.com (repo-local git config; check before committing).
- Commit locally. Do not push, tag, or release without explicit go-ahead.
- Do not bump version numbers unless asked.
- Never commit secrets, device IPs/serials, or `.mcp.json`.
- Keep each task/issue small enough to finish in one context window; split larger work.
- Every new tool needs an integration test with a mocked connection and an entry in `docs/tools-reference.md`.
- Mark read-only tools with `readOnlyHint: true`.
- Source of truth for commands is the UNI-T programming manual (https://instruments.uni-trend.com/download); cite the manual section in code comments when a command is non-obvious. Do not guess SCPI syntax.
- Do not copy source from other projects without keeping their license notices.
