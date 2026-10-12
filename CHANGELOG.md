# Changelog

All notable changes to `pi-brainstorm` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.0] - 2026-10-11

### Added

- `/brainstorm-participants` and the `meeting_list_participants` facilitator tool
  report the effective merged participant roster: `displayName`, `agentName`,
  `model` (or "inherit main model"), thinking level, timeout, debate persona,
  tombstoned names, and which config layers were loaded. `configLayers()` now backs
  both `loadConfig` and the roster reporter, so the reported provenance cannot drift
  from what is actually loaded. Children never receive the tool, since the `--tools`
  allowlist is built from `CORE_WORK_TOOLS` + `MEETING_TOOLS`. (`f796b2b`)

### Internal

- Vendor 29 agent skills from `mattpocock/skills` and `asyrafhussin/agent-skills`
  under `.agents/skills`, pinned by a new `skills-lock.json` that records each
  skill's source path and content hash. Nothing new ships: neither path is listed in
  `package.json` `files`. (`b6729c9`)
- Add two session handoff notes under `handoff/` covering the native child runner,
  the 0.8.0 release state, and the participants roster work. (`9b3a74b`)
- Ignore workspace-local `.pi/` settings and `package-lock.json`. (`ec999b5`)

## [0.8.0] - 2026-10-12

First tagged release. Versions 0.1.0 through 0.7.0 were published without tags, so
this section covers the whole history of the package up to now.

### Added

- Run participants as native headless Pi child processes, supervised by the
  extension, behind the new facilitator tools `meeting_run_round` and
  `meeting_run_cycle`. Roles, models, tool allowlists, retries, and timeouts are
  built in code instead of being emitted as prompt JSON. (**breaking**, `7f2797a`)
- Respond in the user's language, defaulting to English. (`7e4bfd0`)
- `/brainstorm-from-file` and `/debate-from-file` session files that select a topic
  and a subset of configured participants. (`4a9d167`)
- `/brainstorm-lab` v2 mode with artifact tracking, an edge graph, state management,
  and context packs. (`ab43009`)
- Human-readable meeting titles via `meeting_rename`. (`702adcd`)
- GLM participant and subagent failure handling. (`17480e2`)

### Changed

- `participants` config now merges by `agentName` across the package, user, and
  project layers; unmentioned participants survive, and `disabled: true` tombstones
  a participant so a lower-priority file cannot re-add it. (`7f2797a`)
- Per-participant `model` (`provider/modelId[:thinking]`) and `thinkingLevel` are
  honored again. A preflight rejects models whose provider has no stored or
  environment credentials and reports the participant as `unavailable`. (`7f2797a`)
- Role text is delivered to each child through `--append-system-prompt` using a
  generated brief in `.pi-meetings/<meeting>/roles/<agentName>.md`. (`7f2797a`)
- Refreshed the default GPT brainstorm roles. (`e287816`)

### Fixed

- Restore the interactive brainstorm checkpoints after Round 1 and Round 2. (`fc44d18`)
- Document subagent install and timeout behavior. (`20035ef`)

### Removed

- The `@narumitw/pi-subagents` runtime prerequisite, the `subagent_spawn` /
  `subagent_wait` orchestration, and the generated agent markdown files under
  `~/.pi/agent/agents/`. (`7f2797a`, supersedes `ee26dbe`)

### Notes

- `ee26dbe` (`feat!: migrate subagent orchestration to pi-subagents v3`) shipped in
  0.6.0 and is superseded within this release; it is not itemized as a change.
- `fd17f62` (`fix: make generated agents discoverable`) and `54c2a89`
  (`docs: clarify subagent prerequisite`) described the generated-agent and
  pi-subagents v3 behavior that this release removes.
- The four earliest commits (`81ef7c4`, `e65fb73`, `c6fcc8a`, `a32546c`) predate the
  conventional-commit convention used here and are not itemized individually: the
  initial meeting blackboard package, its README copy, the rename to
  `pi-brainstorm`, and loading participants from YAML config.
