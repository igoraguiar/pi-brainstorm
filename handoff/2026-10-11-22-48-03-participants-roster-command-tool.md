# Handoff — participant roster command + tool (post-v0.8.0)

Repo: `pi-brainstorm`, a pi extension. Single-package layout (root `package.json`, no
`packages/`). Mainline branch is **`main`** (no `master`).

Read the previous handoff first for the runner architecture and the environment facts
(model availability, registry semantics, reproduction recipes) — this document only
covers what changed since it was written:

- `handoff/2026-10-11-22-35-39-native-child-runner-v0.8.0-release.md`

## Snapshot

| Ref | Commit | State |
| --- | --- | --- |
| `develop` (checked out) | `f796b2b` `feat: add /brainstorm-participants and meeting_list_participants` | **diverged from `main`**: 1 ahead, 1 behind |
| `main` | `47c9f63` `chore(release): bump version to v0.8.0` | pushed to `origin/main`, tagged **`v0.8.0`** |
| `feat/native-child-spawn` | `7f2797a` | merged everywhere; safe to delete |
| `refactoring` | `7e4bfd0` | stale |

Untracked, deliberately left uncommitted: `.agents/`, `.pi/`,
`package-lock.json`, `skills-lock.json`. `package.json` is still **0.8.0** and
`CHANGELOG.md` has no entry for `f796b2b` — the user asked to leave versioning to the
next release run.

## What was added (`f796b2b`)

Motivation and the full change list are in the commit message (`git show f796b2b`) and
in the README sections *Commands* (`/brainstorm-participants`), *Listing participants*,
and *Tools*. Do not re-derive them here.

New symbols in `extensions/brainstorm.ts` (search by name):
`configLayers`, `shortenPath`, `ParticipantSummary`, `summarizeParticipant`,
`formatParticipantRoster`, plus the `meeting_list_participants` tool registration and
the `brainstorm-participants` command registration.

Design points worth preserving:

- `configLayers(cwd)` is now the single source for config paths and is used by **both**
  `loadConfig` and the roster reporter, so reported provenance cannot drift.
- The tool is facilitator-only by construction: the child `--tools` allowlist is
  `participantCoreTools(...) + MEETING_TOOLS`, and `meeting_list_participants` is in
  neither.
- `meetingDir` with no matching entry in `activeSessions` is not an error: it falls back
  to the effective config roster and says so in the scope line.
- Existing command names (`/debate`, `/debate-from-file`) were **not** renamed — the
  user considered prefixing them and explicitly decided against it.

## Verified

- `npx tsc --noEmit --target es2022 --module es2022 --moduleResolution bundler --skipLibCheck --types node extensions/brainstorm.ts` → clean.
- Harness (fake `ExtensionAPI`, `node --experimental-strip-types`): full roster; project-override roster showing a `disabled: true` tombstone and a patched `model`; `agentName` filter; tombstoned name rejected with the `Available:` list; unknown `meetingDir` fallback.
- Real dispatch: `pi --print --no-session --model deepseek/deepseek-flash --tools meeting_list_participants -e extensions/brainstorm.ts -- "call it"` → 11-participant roster. Note pi auto-installed peer deps on that run ("added 7 packages").
- Effective roster in this workspace: 4 participants from `config/default.yaml` + 7 from `~/.pi/agent/pi-brainstorm.yaml`; none set `model:`, so all inherit the main model.

## Suggested next steps (in rough priority)

1. **Reconcile `develop` and `main`** — `git checkout develop && git merge main`.
   `develop` lacks `47c9f63` (`package.json` 0.8.0 + `CHANGELOG.md`); merging `develop`
   into `main` later would otherwise look like it deletes the changelog.
2. **Next release run**: bump to 0.9.0 and add a `CHANGELOG.md` section for `f796b2b`
   (Added: `/brainstorm-participants`, `meeting_list_participants`).
3. **Stale install pins**: both READMEs still show
   `pi install git:github.com/Jarcis-cy/pi-brainstorm@v0.4.3` (line 39 in each); the
   current remote is `igoraguiar/pi-brainstorm`. Update to `@v0.8.0` (or drop the pin).
4. **No tests exist.** `configLayers`, `mergeConfigLayer`, `parseModelSpec`,
   `summarizeParticipant`, `formatParticipantRoster`, `defaultMission`, and the
   run-success rule are pure and testable if extracted into an importable module.
5. **No interim progress reporting**: `meeting_run_round` / `meeting_run_cycle` ignore
   `onUpdate`; a round reports only after every child finishes.
6. **No mid-run child control**: no equivalent of `subagent_send` / `inspect` /
   `cancel`; a stuck child can only be killed by the wall-clock timeout.
7. **Windows untested** (`pi.cmd` lookup, `--append-system-prompt <path>`).
8. **`.pi-meetings/` is not gitignored** (`.gitignore` covers only `node_modules/`,
   `*.tgz`, `.DS_Store`), so real sessions leave untracked folders including `roles/`.
9. **No publish pipeline**: `package.json` has no `scripts`, so the release workflow's
   `docker:build-and-push` step is skipped every time.

## Suggested skills

- **`git-commit`** — the repo style is plain conventional commits (no emoji); use it for
  the `develop`/`main` reconciliation and any follow-up.
- **`tdd`** — for item 4: extract the pure helpers and write the first suite, plus an
  integration test for `meeting_run_round` success detection.
- **`code-review`** — review `develop` since `main` (Standards + Spec axes); the runner
  plus the roster feature is ~2000 changed lines with no tests.
- **`codebase-design`** — `configLayers()` / `loadConfig()` / the roster reporter is now
  a three-consumer seam; check whether the config module's interface is deep enough or
  whether provenance should be recorded per participant rather than per layer.
- **`domain-modeling`** — the vocabulary is now load-bearing (`participant`,
  `agentName`, `role brief`, `round`/`cycle`, outcome states, tombstone, config layer);
  a `GLOSSARY.md` would keep README, CHANGELOG, and code aligned.
- **`diagnosing-bugs`** — if a participant reports `failed` / `timeout` / `unavailable`
  in real use, or if the roster output disagrees with what a session actually runs.
- **`writing-for-agents`** — if you touch the facilitator prompt builders
  (`buildNativeRunnerGuide`, `failureHandlingSection`) or the READMEs again.
