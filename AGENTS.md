# Agent notes

Instructions for AI coding agents (Claude Code, Codex, etc.) working in this repo. `CLAUDE.md` points here.

## Project

MCP server (TypeScript, stdio) for UNI-T UTS series spectrum analyzers (UTS1000B/T, UTS3000B) over SCPI. Layout is modeled on [siglent-sds-mcp](https://github.com/MagnusJohansson/siglent-sds-mcp):

- `src/index.ts` – server entry, registers tool groups
- `src/connection.ts` – SCPI connection singleton with a query queue
- `src/tools/*.ts` – one file per tool group, each exporting `register<Group>Tools(server)`
- `tests/unit/`, `tests/integration/` – vitest; integration tests mock `src/connection.js`
- `docs/` – `references.md` (manuals and links), `verified-hardware.md` (what was tested on), tools reference, programming-guide notes, manual testing guide

Commands: `npm run build`, `npm test`, `npm run inspector`.

## Rules

- Commit as reid@malmoset.com (repo-local git config; check before committing).
- Sign commits (already configured globally); signing is encouraged but not required of contributors.
- Commit locally. Do not push, tag, or release without explicit go-ahead.
- Do not bump version numbers unless asked.
- Never commit secrets, device IPs/serials, or `.mcp.json`.
- Keep each task/issue small enough to finish in one context window; split larger work.
- Every new tool needs an integration test with a mocked connection and an entry in `docs/tools-reference.md`.
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

## Error handling standard

Required for every tool that talks to the instrument. `tests/integration/tool-contract.test.ts` enforces it: it runs every registered tool against the fake connection in `tests/toolContract.ts` under not-connected, timeout, write failure, garbage/empty reply, instrument error and part-way failure modes. **A new tool must be added to the `CONTRACT` table in `tests/toolContract.ts` (kind, valid args, invalid args, args that must produce a warning) or that test fails.** Add canned replies for any new query to `QUERY_REPLIES` there.

1. **Tools never throw.** Every handler wraps everything in try/catch and returns `errorResult(...)` (isError, actionable message: what failed, which command, what to do next). No unhandled promise rejections, including fire-and-forget calls (use `.catch`).
2. **Setters:** validate input first (nothing is sent if invalid), then `applyCommands` (`*CLS`, each command synced with `*OPC?`, `:SYSTem:ERRor?` checked), then read the state back through `readBack(...)` and report every requested value, flag or enum the instrument did not take as a `warnings` entry (this unit clamps silently; check auto flags too). Failures go through `setterFailure(err, "get_x")`: instrument errors carry their code and text and say the settings may be partially applied.
3. **Getters:** parse every reply with `queryNumber` / `queryBool` / `queryParsed` (`src/instrument.ts`); a malformed or empty reply is a `ReplyError` naming the command and quoting the reply. A timeout names the command. A getter that fails part-way returns an error, never partial data.
4. **Multi-step operations** that change temporary state use try/finally to restore it; if restoring fails, say so. If a tool deliberately leaves state changed (e.g. `single_sweep` leaves single mode), failures say so.
5. **Connection problems** (not connected, closed, timeout, write failure) each have a distinct message; not-connected tells the user to call `connect`.
6. **Hardware behavior** (clamp vs error vs ignored) is documented per tool in `docs/verified-hardware.md`.
7. **Every tool has failure-mode tests**, not only happy paths (the contract test covers the common modes; add tool-specific ones next to the tool's tests).
