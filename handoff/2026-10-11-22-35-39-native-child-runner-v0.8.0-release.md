# Handoff — native participant runner + v0.8.0 release

Repo: `pi-brainstorm` (a pi extension). Single-package layout: root `package.json`,
no `packages/`, no test suite, no `tsconfig.json`.
Mainline branch is **`main`** (no `master`; `origin/HEAD -> origin/main`).

## Where things stand

| Ref | Commit | State |
| --- | --- | --- |
| `main` | `47c9f63` `chore(release): bump version to v0.8.0` | pushed to `origin/main`, tagged **`v0.8.0`** (annotated) |
| `develop` | `f796b2b` `feat: add /brainstorm-participants and meeting_list_participants` | **diverged from `main`**: 1 commit ahead (`f796b2b`) and 1 behind (`47c9f63`); currently checked out |
| `feat/native-child-spawn` | `7f2797a` | merged into `develop` (fast-forward) and `main`; safe to delete |
| `refactoring` | `7e4bfd0` | stale, pre-dates the v3 migration |

Untracked and deliberately left uncommitted: `.agents/`, `.pi/`, `package-lock.json`,
`skills-lock.json`. `.gitignore` only covers `node_modules/`, `*.tgz`, `.DS_Store` —
`.pi-meetings/` is **not** ignored.

## What was implemented (do not re-derive)

Design rationale and the full change list live in the commit message and changelog —
read those instead of re-reading the diff:

- `git show 7f2797a` — why pi-subagents v3 was dropped and what replaced it.
- `CHANGELOG.md` → `## [0.8.0]` — categorized change list for the whole history.
- `README.md` sections *Prerequisites*, *Participant models*, *Participant runtime*,
  *Migration notes* (and the mirrored `README.zh-CN.md`).

Short version: participants are now headless `pi --print --no-session` children that
the extension spawns and supervises. Facilitators call `meeting_run_round` (parallel)
or `meeting_run_cycle` (one debater at a time) instead of writing spawn JSON.

Key symbols in `extensions/brainstorm.ts` (search by name, line numbers drift):
`resolvePiCommand`, `findPiPackageBin`, `piBinFromPackageJson`, `parseModelSpec`,
`preflightParticipant`, `buildRoleBrief` / `writeRoleBrief`, `buildParticipantTask`,
`defaultMission`, `runChildPi`, `runParticipant`, `runParticipantsParallel`,
`formatOutcomes`, `resolveSessionParticipants`, `buildNativeRunnerGuide`,
`failureHandlingSection`, `mergeConfigLayer`, `activeSessions`, `activeChildren`.

## Added after the v0.8.0 release (on `develop`, untagged)

`f796b2b` adds `/brainstorm-participants` (command) and `meeting_list_participants`
(facilitator-only tool): the effective merged roster with `displayName`, `agentName`,
model or `inherit main model`, thinking level, timeout, debate-persona presence,
tombstoned names, and which config layers were loaded. `configLayers()` now backs both
`loadConfig` and the roster reporter. Version and `CHANGELOG.md` were deliberately left
at 0.8.0 — the next release run should bump to 0.9.0.

## Facts already verified (trust these, re-verify only if changing them)

- `npx tsc --noEmit --target es2022 --module es2022 --moduleResolution bundler --skipLibCheck --types node extensions/brainstorm.ts` → clean. The repo has no tsconfig; these flags approximate pi's loader.
- `require.resolve("@earendil-works/pi-coding-agent/package.json")` **fails** — pi is ESM-only and does not export `./package.json`. Hence the walk-up-to-`node_modules` strategy in `findPiPackageBin`, with a `PATH` fallback.
- In a real child session, `ctx.modelRegistry.find(provider, id)` matches multi-slash ids and ids containing `:mode` suffixes, and `hasConfiguredAuth(model)` returns **true** for extension-registered proxy providers (`getProviderAuthStatus(...).source === "fallback"`). Preflight therefore does not falsely block proxy providers. `.type` is undefined — only `.source` is populated.
- End-to-end round with three participants produced two entries on different models and one `unavailable` outcome for a bogus model; tombstoned (`disabled: true`) participants are unselectable; `round: 9` is rejected.

### Model availability observed on this machine (pi 1.1.0)

- Worked: `deepseek/deepseek-flash`, `llama-luiz/sudoingx/Ternary-Bonsai-2-27B:code-low`.
- Broken at the time of writing: `llama-luiz/PolyStrata/Ornith-1.5` (upstream proxy returned a DNS-rebinding 403), `geo-llama-swap/*` (request timeout), `groq/llama-3.1-8b-instant` (provider `model_not_found` — stale catalog entry).
- `pi auth check --provider <ext-registered provider>` reports `provider_not_found` even though the registry has that provider's models. Use `pi --list-models` and the registry probe instead of `pi auth check` when debugging preflight.

### Reproduction recipes

Child-only check (validates the spawn shape, ~25 s):

```bash
pi --print --no-session --model deepseek/deepseek-flash \
  --tools read,grep,find,ls,meeting_append_entry,meeting_read_index,meeting_read_entry \
  --append-system-prompt <meeting>/roles/<agentName>.md \
  -e <repo>/extensions/brainstorm.ts --approve -- "<task ending in WROTE_ENTRY>"
```

Extension-level check: import the default export with a fake `ExtensionAPI`
(`registerTool`/`registerCommand`/`registerMessageRenderer`/`on`/`sendUserMessage`),
capture the tools map, then call `meeting_run_round.execute(id, params, undefined,
onUpdate, ctx)` with a stub `ctx` (`cwd`, `ui.notify`, `model`, `modelRegistry`,
`isProjectTrusted`). Run it with `node --experimental-strip-types harness.mjs`.
This needs no real model when you only test roster/merge/validation paths.

## Suggested next steps (in rough priority)

1. **Reconcile `develop` and `main`** — they have diverged: `develop` lacks the release
   commit `47c9f63` (`package.json` 0.8.0 + `CHANGELOG.md`), and `main` lacks `f796b2b`.
   Merge `main` into `develop` before starting the next feature branch, otherwise the
   next merge into `main` will look like it deletes the changelog.
2. **Stale install pins**: both READMEs still show
   `pi install git:github.com/Jarcis-cy/pi-brainstorm@v0.4.3` (line 39 in each). Update
   to `@v0.8.0`, and note the GitHub owner in those URLs differs from the current
   remote (`igoraguiar/pi-brainstorm`).
3. **No tests exist.** The runner helpers are module-private; extracting
   `parseModelSpec`, `mergeConfigLayer`, `defaultMission`, `buildParticipantTask`, and
   the success-detection rule into an importable module would make them testable
   without spawning children.
4. **No interim progress reporting.** `meeting_run_round` / `meeting_run_cycle` ignore
   `onUpdate`; a round only reports when every child has finished. Wiring `onUpdate`
   to per-participant completion (and a small "N running" widget) is the obvious gap
   left by dropping pi-subagents.
5. **No mid-run child control.** There is no equivalent of `subagent_send` /
   `subagent_inspect` / `subagent_cancel`; a stuck child can only be killed by the
   wall-clock timeout (SIGTERM → SIGKILL after `CHILD_KILL_GRACE_MS`).
6. **Windows path is untested**: `pi.cmd` lookup and `--append-system-prompt <path>`
   (path, not inline text, so command-line length is fine) have not been exercised.
7. **`.pi-meetings/` is not gitignored**, so a session run in a real project leaves
   untracked meeting folders (including `roles/` briefs). Decide whether to ignore or
   document it.
8. **No publish pipeline**: `package.json` has no `scripts` at all, so the release
   workflow's `docker:build-and-push` step was skipped. If npm publishing is wanted,
   add a release/publish script.

## Suggested skills

- **`code-review`** — review `v0.8.0` (`git review since ee26dbe` / since the merge-base
  with `main`) along Standards and Spec axes; the runner is ~700 new lines with no tests.
- **`tdd`** — for item 3: extract the pure helpers and write the first test suite
  (red-green-refactor), plus an integration test for `meeting_run_round` success detection.
- **`codebase-design`** — the facilitator↔runner seam (`meeting_run_*` tools vs
  `runParticipant`) is the new deep module; review whether the seam and its
  `ParticipantOutcome` interface are the right cut.
- **`diagnosing-bugs`** — if a participant reports `failed` / `timeout` / `unavailable`
  in real use, this is the loop to run (child exit code, stderr capture, index-entry
  landing, registry auth source).
- **`git-commit`** — for the follow-up commits above (repo style is plain conventional
  commits, no emoji: `feat:`, `fix:`, `chore(release):`).
- **`domain-modeling`** — the vocabulary just shifted (`participant`, `role brief`,
  `round`/`cycle`, `outcome state`, tombstone). Worth capturing in a `GLOSSARY.md` so
  the README, changelog, and code agree.
- **`writing-for-agents`** — if you touch the facilitator prompt builders
  (`buildNativeRunnerGuide`, `failureHandlingSection`) or the READMEs again.
