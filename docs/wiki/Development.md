# Development

How this project is built and how to contribute. The authoritative rules are in [AGENTS.md](https://github.com/Reid-n0rc/uni-t-uts-mcp/blob/main/AGENTS.md) and [CONTRIBUTING.md](https://github.com/Reid-n0rc/uni-t-uts-mcp/blob/main/CONTRIBUTING.md); this page is the overview.

## Set up

```sh
git clone https://github.com/Reid-n0rc/uni-t-uts-mcp.git
cd uni-t-uts-mcp
npm ci
npm run build        # tsc -> build/
npm run typecheck    # type-checks src and tests
npm test             # vitest (no hardware needed)
npm run inspector    # try the server in the MCP Inspector
```

Requires Node.js 22+. Tests never need an analyzer: they use a mocked connection or an in-process fake SCPI server (`tests/fakeScpiServer.ts`) plus captured instrument fixtures (`tests/fixtures/`).

## Workflow

- **Issues first.** Every piece of work is a GitHub issue (goal, tests to write first, acceptance criteria, size). The [roadmap issue](https://github.com/Reid-n0rc/uni-t-uts-mcp/issues/1) lists them all. Keep each task small enough for one sitting.
- **Issue, then branch, then PR.** Work on a branch named `issue-<n>-<slug>`, and open one PR with `Closes #<n>`. No PR without an issue, and nothing goes to `main` except through a PR.
- **Test-driven.** Write failing tests first and commit them, then implement until green, then refactor.
- **Small, reviewable commits.** One logical change each, each building and passing, so the history can be audited.
- **CI.** Build, typecheck and tests run on Node 22 and 24 on Linux, macOS and Windows, plus the install and Docker smoke jobs, a check that the wiki pages build, and CodeQL. All checks must be green with zero open code-scanning alerts before merging.
- **Signed commits** are encouraged but not required.
- **Documentation is part of done.** A PR that adds or changes a tool, a hardware finding, a workflow rule or the layout updates the matching docs in the same PR.
- **No secrets, serial numbers or real IP addresses** in the repo, issues or PRs. Use placeholders such as `192.168.1.100`.
- **No tags, releases or version bumps** unless the maintainer asks.

## Documentation and this wiki

The wiki is generated from the repository and published automatically, so never edit it in the GitHub wiki editor (edits are overwritten on the next sync). Where each page lives:

| Wiki page | Source of truth |
|-----------|-----------------|
| Tools | `docs/tools-reference.md` (generated) |
| Instrument Behavior | `docs/verified-hardware.md` (generated) |
| Home | `docs/wiki/Home.md` template, with the version from `package.json` and the tool table from `docs/tools-reference.md` (generated) |
| Roadmap | `docs/wiki/Roadmap.md` template plus the open and closed issues (generated) |
| Getting Started, Architecture, Safety and Security, Troubleshooting, Development, the sidebar and footer | `docs/wiki/*.md` (hand-written, reviewed in pull requests) |

`node scripts/sync-wiki.mjs --check` builds the pages and verifies that every internal link and anchor resolves, that links to repository files point at files that exist, that every page is in the sidebar, and that no serial numbers, real IP addresses or personal email addresses are present; CI runs it on every pull request. After a change to `main` that touches `docs/`, the README, the changelog or `package.json` (and when an issue changes), the `wiki-sync.yml` workflow builds the pages and pushes an ordinary commit to the wiki repository with the default `GITHUB_TOKEN`; nothing is pushed when nothing changed. `node scripts/sync-wiki.mjs --out <dir>` builds the pages locally (the Roadmap lists issues only when `GH_TOKEN` or `GITHUB_TOKEN` is set). The project site's tool list is generated from the same `docs/tools-reference.md` by `npm run site`.

## Adding a tool

1. Open an issue; branch `issue-<n>-<slug>`.
2. Write the tests first: integration tests with a mocked connection in `tests/integration/`, including failure modes.
3. Implement it in `src/tools/<group>.ts` (export `register<Group>Tools(server)`) and register it in `src/server.ts`.
   - Read-only tools get `readOnlyHint: true`.
   - Setters validate, use `applyCommands`, read back and warn about adjusted values.
   - Getters use the strict parsers in `src/instrument.ts`.
   - Handlers never throw; return `errorResult(...)`.
4. Add the tool to the `CONTRACT` table in `tests/toolContract.ts` (and canned replies for any new query to `QUERY_REPLIES`), and to the expected names in `tests/unit/server.test.ts`.
5. Document it: a `### \`tool_name\`` section in `docs/tools-reference.md` (a test fails if it is missing), hardware findings in `docs/verified-hardware.md`, SCPI details in `docs/programming-guide.md`, and the README tool table.
6. Verify it on real hardware if you can (below) and record the result.

SCPI syntax comes from the UNI-T programming manuals (links in `docs/references.md`). Do not guess commands; cite the manual section in a code comment when a command is non-obvious.

## Testing on real hardware

Hardware checks are manual and recorded in `docs/verified-hardware.md` (model, firmware, what was observed). Rules of the road:

- Write down every setting before you change it and **restore it afterwards**; finish with a clean `:SYSTem:ERRor?`.
- Respect the instrument's quirks: one query at a time; an unsupported query stalls it for about 2 s and queues a late `-113`; the instrument ignores commands during a single sweep on the raw socket (see [Instrument Behavior](Instrument-Behavior)).
- Never send resets, network-setting changes, lock commands or file writes while probing.
- Probe scripts live in `scripts/` and read the host from `UTS_IP`; they redact serial numbers from their output.
- If you have a different model or firmware, please say which in your PR.

## Parallel work

When several people or agents work at once, each should use its own `git worktree` (not just a branch in the shared checkout), and only one should drive the real instrument at a time.

## Project layout

See [Architecture](Architecture) for the source layout, and the repository's `tests/` folder for unit tests, mocked integration tests, the fake SCPI server and the fixtures captured from the real instrument.

## Releases

Releases are made by tag-triggered GitHub Actions: a GitHub release with the npm tarball and a Docker image on GitHub Container Registry; publishing to the npm registry is optional and has not happened yet. v0.1.0 is released. Tags and releases are a maintainer decision; see [docs/releasing.md](https://github.com/Reid-n0rc/uni-t-uts-mcp/blob/main/docs/releasing.md).
