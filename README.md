# pi-brainstorm

Multi-agent brainstorming and debate sessions for [pi](https://github.com/earendil-works/pi-coding-agent).

`pi-brainstorm` lets configurable agents join the same discussion with distinct roles and prompts. Their identities provide different reasoning lenses rather than different base models. Use `/brainstorm` for structured ideation or `/debate` for adversarial challenge.

The plugin stores each participant's full contribution in a local meeting blackboard under `.pi-meetings/...`. The blackboard is an implementation feature: it keeps the main chat focused on compact cards, summaries, conflicts, and conclusions while preserving the complete transcript on disk.

A Chinese (zh-CN) translation of this README is available at [README.zh-CN.md](./README.zh-CN.md).

## Features

- Configurable multi-agent brainstorming (defaults: GPT-Progressive, GPT-Localist, GPT-Diagnostician, GPT-Critic; each spawned as a subagent job with its own role prompt).
- Debate / battle mode where agents prosecute, stress-test, and challenge positions.
- Configuration-driven: add, remove, or customize participants via YAML.
- Full participant contributions stored as Markdown files under `.pi-meetings/`.
- Compact visible cards in the main conversation instead of long pasted transcripts.
- JSONL index for lightweight cross-round context.
- Built on `@narumitw/pi-subagents` v3 (`subagent_spawn` / `subagent_wait`).

## Install

Recommended one-line install:

```bash
pi install npm:@narumitw/pi-subagents && pi install npm:pi-brainstorm
```

Install only this package from npm:

```bash
pi install npm:pi-brainstorm
```

From GitHub:

```bash
pi install git:github.com/Jarcis-cy/pi-brainstorm@v0.4.3
```

For local development:

```bash
pi install /Users/jarcis/Project/pi-brainstorm
```

## Prerequisites

`pi-brainstorm` orchestrates participants through `@narumitw/pi-subagents` **v3**, which registers the `subagent_spawn` / `subagent_wait` tools. Install it separately before using `/brainstorm` or `/debate`:

```bash
pi install npm:@narumitw/pi-subagents
```

`@narumitw/pi-subagents` runs each participant job in an isolated Pi subprocess. It is a runtime prerequisite, not bundled inside `pi-brainstorm`.

The v3 runtime has **no `subagent` tool and no named-agent catalog**. `pi-brainstorm` therefore delegates with self-contained tasks: each participant's role text comes from your YAML config, and the child is granted the blackboard tools by attaching this same extension to the job.

Key v3 behaviors that shape how `pi-brainstorm` works:

- `subagent_spawn({ task, tools, extensions, thinkingLevel?, timeout? })` returns a `jobId` immediately; the job runs in the background. Wait for it with `subagent_wait({ jobId })`.
- Terminal states are `completed`, `partial`, `failed`, `timed_out`, and `cancelled`.
- Children inherit the main agent's model. There is **no per-job model override**; configure roles in YAML instead of selecting base models per participant.
- Children do **not** inherit the main agent's extension tools. `pi-brainstorm` attaches its own extension to each child and exposes only `meeting_append_entry`, `meeting_read_index`, and `meeting_read_entry`.
- Timeouts are in **seconds** (the old `PI_SUBAGENT_TIMEOUT_MS` environment variable no longer applies). Participant full text is written to `.pi-meetings/...`; the main chat should only receive short `WROTE_ENTRY` summaries and facilitator synthesis.

Project-local installs may require project trust before the attached extension can load in a child.

## Configuration

Participants are defined in YAML. The extension loads config in this order (later overrides earlier):

1. Package default: `config/default.yaml` (shipped with the package)
2. User override: `~/.pi/agent/pi-brainstorm.yaml`
3. Project override: `.pi-brainstorm.yaml` or `.pi/pi-brainstorm.yaml`

Arrays (e.g. `participants`) replace entirely; objects deep-merge.

### Adding a new participant

Create `~/.pi/agent/pi-brainstorm.yaml` (user-level) or `.pi-brainstorm.yaml` (project-level):

```yaml
participants:
  - displayName: GPT-Analyst
    agentName: gpt-analyst-brainstormer
    description: >-
      Nuanced analyst for multi-agent discussion sessions.
    roleTitle: Nuanced Analyst
    rolePrompt: |
      You are the analyst advisor in a multi-agent brainstorming session.
      Skilled in meticulous argumentation and long-form analysis.
      Answer in the language the user uses; default to English.
    whatYouDo:
      - Provide detailed, in-depth point-by-point analysis
      - Identify subtleties and edge cases
      - Write long-form arguments with a clear structure
    debatePersona:
      label: THE ANALYST
      prompt: |
        DEBATE MODE. You are THE ANALYST. Dissect every argument with
        precision. Find the weakest link in every chain of reasoning.
        Answer in the user's language; default to English.
    brainstormRole: Nuanced analyst
    # optional: per-participant thinking level and execution timeout
    # thinkingLevel: xhigh
    # timeoutSeconds: 900
```

To replace the default participants entirely, define a full `participants` list in your override file.

Top-level options are also available:

- `thinkingLevel` — default thinking level passed to `subagent_spawn` (one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Omit to inherit the main agent's level.
- `subagentTimeoutSeconds` — default job execution timeout in seconds (default `900`).
- `subagentWaitTimeoutSeconds` — default `subagent_wait` timeout in seconds (default `900`).
- `extensionPath` — override the pi-brainstorm extension path attached to children (advanced).

> The legacy `model:` field still loads for backward compatibility but is ignored: pi-subagents v3 children always inherit the main agent's model.

### Subagent runtime

`pi-brainstorm` no longer generates agent files. Each participant's role text is injected into the `subagent_spawn` task, and the child is given the blackboard tools by attaching this extension to the job. There is nothing to install under `~/.pi/agent/agents/`; you can delete any previously generated `*-brainstormer.md` files.
## Commands

```text
/brainstorm <topic>
/brainstorm-from-file <session.yaml>
/debate <topic>
/debate-from-file <session.yaml>
/brainstorm-lab <topic>
```

`/brainstorm` starts an interactive three-round multi-agent brainstorming session. After Round 1 and Round 2, the facilitator should stop, summarize the round, and wait for your feedback or permission before continuing.

`/debate` starts an open-ended multi-agent battle that should continue until convergence or user intervention.

`/brainstorm-lab` starts a v2 lab session with artifact tracking, edges, state management, and context packs.

### Session files

`/brainstorm-from-file` and `/debate-from-file` take a YAML file and run a session with a topic and a chosen subset of participants. The file lists the `agentName` values defined in your config:

```yaml
# session.yaml
topic: Bounty Hunter game concept inspired by the Dota 2 hero
participants:
  - visionary-strategist
  - player-psychologist
  - pragmatist
```

```text
/brainstorm-from-file session.yaml
```

The path is resolved relative to the current working directory (absolute paths are allowed). A missing `topic`, an empty `participants` list, or an unknown agent name is reported as an error instead of failing silently.


## How It Works

```text
facilitator -> subagent_spawn(task) -> child reads/writes blackboard via meeting_* tools
child -> meeting_append_entry -> .pi-meetings/... files
child -> short WROTE_ENTRY summary -> subagent_wait result -> facilitator context
file watcher -> compact visible card -> main chat
facilitator -> round checkpoint / consensus / disagreement / final synthesis
```

The blackboard files are the source of truth for the session. The facilitator can read the index or specific entries when producing summaries.

## Tools

The extension registers a blackboard tool set:

- `meeting_rename` (facilitator-only) renames the meeting directory to a human-readable title before Round 1 starts.
- `meeting_append_entry` writes a full participant contribution to disk and returns only a short reference.
- `meeting_read_index` lists entries by id, speaker, phase, summary, and path.
- `meeting_read_entry` reads one full entry when the facilitator or a participant needs it.
- `meeting_append_artifact`, `meeting_append_edge`, `meeting_read_artifacts`, `meeting_get_state`, `meeting_update_state`, and `meeting_log_event` back the v2 lab mode (artifact/edge/state tracking).

Children spawned for a session receive only `meeting_append_entry`, `meeting_read_index`, and `meeting_read_entry`, via the attached extension. The remaining tools stay with the facilitating main agent.

## Files

Each session writes an append-only folder under the current working directory:

```text
.pi-meetings/YYYY-MM-DD-topic/
  manifest.json
  index.jsonl
  blackboard.md
  entries/
    0001-gpt-progressive-round_1.md
    0002-gpt-localist-round_1.md
```

`blackboard.md` is the full transcript. `index.jsonl` is the compact context entry point. Full participant text lives in `entries/`.

## Safety

The extension validates that meeting paths stay under the current workspace's `.pi-meetings/` directory and rejects symlinked meeting paths, entry files, index files, and blackboard files. Entry writes use exclusive creation to avoid overwriting existing files.

## Migrating from 2.x

`pi-brainstorm` v0.6 targets `@narumitw/pi-subagents` **v3**. If you upgraded that package from 2.x, note that v3 removed the `subagent` tool, the named-agent catalog, per-job model overrides, and custom system prompts. `pi-brainstorm` was updated accordingly:

- Orchestration now uses `subagent_spawn` + `subagent_wait` instead of `subagent`.
- Participant role text is injected into the spawn task; generated agent files are gone.
- The child receives the blackboard tools through `extensions: [{ path, tools }]`.
- `model:` in participant config is ignored; use `thinkingLevel` for reasoning depth.

Start a fresh Pi session after upgrading so stored calls no longer request removed tool names.

## Development

```bash
npm pack --dry-run
```

The extension is TypeScript loaded by pi through its extension loader. Runtime dependencies imported from pi (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`) are declared as peer dependencies per pi package guidance.

## License

MIT
