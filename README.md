# pi-brainstorm

Multi-agent brainstorming and debate sessions for [pi](https://github.com/earendil-works/pi-coding-agent).

`pi-brainstorm` lets configurable agents join the same discussion with distinct roles and prompts. Their identities provide different reasoning lenses rather than different base models. Use `/brainstorm` for structured ideation or `/debate` for adversarial challenge.

The plugin stores each participant's full contribution in a local meeting blackboard under `.pi-meetings/...`. The blackboard is an implementation feature: it keeps the main chat focused on compact cards, summaries, conflicts, and conclusions while preserving the complete transcript on disk.

A Chinese (zh-CN) translation of this README is available at [README.zh-CN.md](./README.zh-CN.md).

## Features

- Configurable multi-agent brainstorming (defaults: GPT-Progressive, GPT-Localist, GPT-Diagnostician, GPT-Critic; each runs as a headless Pi child with its own role brief).
- Debate / battle mode where agents prosecute, stress-test, and challenge positions.
- Configuration-driven: add, remove, or customize participants via YAML.
- Per-participant model and thinking level, inherited from the main agent when unset.
- Full participant contributions stored as Markdown files under `.pi-meetings/`.
- Compact visible cards in the main conversation instead of long pasted transcripts.
- JSONL index for lightweight cross-round context.
- No subagent extension required: participants run as supervised `pi --print` subprocesses.

## Install

Recommended one-line install:

```bash
pi install npm:pi-brainstorm
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

`pi-brainstorm` has **no subagent-extension prerequisite**. It spawns and supervises
participant children itself by running headless Pi processes:

```text
pi --print --no-session --model <provider/id> --thinking <level> \
   --append-system-prompt .pi-meetings/<meeting>/roles/<agentName>.md \
   --tools read,grep,find,ls,meeting_append_entry,meeting_read_index,meeting_read_entry \
   -e <path-to>/extensions/brainstorm.ts -- "<round mission + blackboard instructions>"
```

What that means in practice:

- **Model resolution is pi's own.** Children load your settings extensions, so a
  provider registered by an extension (a proxy or custom provider) resolves exactly
  as it does for the main agent.
- **Credentials must be stored or in the environment.** A child process cannot read
  an in-process auth callback, a browser login, or a temporary OAuth token. Run
  `pi --list-models` and check the `Auth` column: only `stored` and `env` can run a
  participant. `pi-brainstorm` preflights this and reports `unavailable` instead of
  spawning a child that cannot authenticate.
- **Children are constrained by `--tools`.** Each child gets `read`, `grep`, `find`,
  `ls` plus `meeting_append_entry`, `meeting_read_index`, and `meeting_read_entry`.
  Facilitator and lab tools stay with the main agent.
- **Timeouts are wall-clock seconds per attempt**, enforced by this extension
  (SIGTERM, then SIGKILL).
- Project-local installs may require project trust before the attached extension can
  load in a child.

Nothing is installed under `~/.pi/agent/agents/`, and no agent markdown files are
generated. If you used `pi-brainstorm` 0.5.x, you can delete any previously
generated `*-brainstormer.md` files.

## Configuration

Participants are defined in YAML. The extension loads config in this order (later overrides earlier):

1. Package default: `config/default.yaml` (shipped with the package)
2. User override: `~/.pi/agent/pi-brainstorm.yaml`
3. Project override: `.pi-brainstorm.yaml` or `.pi/pi-brainstorm.yaml`

`participants` merges **by `agentName`** across layers:

| You write | Effect |
| --- | --- |
| A participant whose `agentName` already exists | Patches that participant field by field; unmentioned fields keep their lower-layer value |
| A new `agentName` | Adds a participant |
| An existing participant you do not mention | Survives unchanged |
| `disabled: true` on an `agentName` | Removes that participant, and tombstones the name so a lower-priority file cannot re-add it |

Every other array replaces entirely; objects deep-merge. Merge order is deterministic (package → user → project), so a project file can override one participant without redefining the roster.

```yaml
# .pi/pi-brainstorm.yaml — change only the critic's model, keep everything else
participants:
  - agentName: gpt-critic-brainstormer
    model: openrouter/z-ai/glm-4.6:xhigh

  - agentName: gpt-localist-brainstormer
    disabled: true
```

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
    # optional per-participant overrides
    model: anthropic/claude-sonnet-4-5   # provider/id[:thinking]; omit to inherit the main model
    thinkingLevel: xhigh
    timeoutSeconds: 900
    disabled: false
```

To replace the default participants entirely, define a full `participants` list in your override file.

Top-level options:

- `thinkingLevel` — default thinking level for every child (one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Omit to inherit the main agent's level.
- `childTimeoutSeconds` — wall-clock limit per child attempt, in seconds (default `900`). `subagentTimeoutSeconds` is the legacy name and still works.
- `maxParallel` — how many participants run at once in a round (default `4`, max `16`).
- `maxRetries` — retries per participant inside one round (default `2`, so 3 attempts total).
- `piBinary` — optional path to the pi executable used to spawn children. By default the extension resolves the installed pi package's own entry point, then `pi` on `PATH`.
- `extensionPath` — override the pi-brainstorm extension path attached to children (advanced).

### Participant models

`model` uses pi's own spec format, `provider/modelId[:thinking]`, and is resolved by
pi exactly as `pi --print --model ...` would resolve it. Model ids may contain `/`
(`openrouter/z-ai/glm-4.6`), so only the first `/` separates the provider.

A participant runs only if its provider has **stored or environment** credentials.
Process-local auth is rejected up front with an `unavailable` result and the reason,
so a round never hangs waiting on a child that cannot authenticate.

### Participant runtime

Each participant gets a generated **role brief** written to
`.pi-meetings/<meeting>/roles/<agentName>.md` and passed to the child through
`--append-system-prompt`, so the role text lands in the child's system prompt instead
of being pasted into its task. The brief is regenerated per round and lives inside the
meeting folder — it is not a global agent catalog, and it is not user-editable.

The facilitator never writes participant prompts, roles, models, or tool lists: it calls
`meeting_run_round` / `meeting_run_cycle`, and this extension builds and supervises the
child processes.
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
facilitator -> meeting_run_round / meeting_run_cycle
            -> extension spawns headless pi children (role brief + mission + --tools allowlist)
child       -> reads prior entries with meeting_read_index / meeting_read_entry
child       -> meeting_append_entry -> .pi-meetings/... files
child       -> short WROTE_ENTRY summary -> outcome (ok | failed | timeout | unavailable)
file watcher -> compact visible card -> main chat
facilitator -> round checkpoint / consensus / disagreement / final synthesis
```

The blackboard files are the source of truth for the session. The facilitator can read the index or specific entries when producing summaries.

## Tools

The extension registers a blackboard tool set:

- `meeting_run_round` (facilitator-only) runs one brainstorm round: every participant runs as a headless Pi child in parallel, reads prior entries from the blackboard, and writes its contribution. Retries happen inside the tool.
- `meeting_run_cycle` (facilitator-only) runs ONE debater and waits for it, so each debater sees every prior entry.
- `meeting_rename` (facilitator-only) renames the meeting directory to a human-readable title before Round 1 starts.
- `meeting_append_entry` writes a full participant contribution to disk and returns only a short reference.
- `meeting_read_index` lists entries by id, speaker, phase, summary, and path.
- `meeting_read_entry` reads one full entry when the facilitator or a participant needs it.
- `meeting_append_artifact`, `meeting_append_edge`, `meeting_read_artifacts`, `meeting_get_state`, `meeting_update_state`, and `meeting_log_event` back the v2 lab mode (artifact/edge/state tracking).

Participants receive only `read`, `grep`, `find`, `ls` plus `meeting_append_entry`, `meeting_read_index`, and `meeting_read_entry`. The remaining tools stay with the facilitating main agent.

A run tool reports one state per participant: `ok` (entry written, with entry id and summary), `failed`, `timeout`, or `unavailable` (model could not be verified or authenticated; no child was spawned).

## Files

Each session writes an append-only folder under the current working directory:

```text
.pi-meetings/YYYY-MM-DD-topic/
  manifest.json
  index.jsonl
  blackboard.md
  roles/
    gpt-critic-brainstormer.md
  entries/
    0001-gpt-progressive-round_1.md
    0002-gpt-localist-round_1.md
```

`blackboard.md` is the full transcript. `index.jsonl` is the compact context entry point. Full participant text lives in `entries/`, and the per-round role briefs passed to each child live in `roles/`.

## Safety

The extension validates that meeting paths stay under the current workspace's `.pi-meetings/` directory and rejects symlinked meeting paths, entry files, index files, and blackboard files. Entry writes use exclusive creation to avoid overwriting existing files.

## Migration notes

### 0.7.0 — participants are native Pi children

`pi-brainstorm` 0.7 no longer depends on `@narumitw/pi-subagents`. Uninstall it if you
installed it only for this package:

```bash
pi remove npm:@narumitw/pi-subagents
```

- Orchestration now uses `meeting_run_round` / `meeting_run_cycle`; `subagent_spawn`,
  `subagent_wait`, and the named-agent catalog are gone from this package.
- Per-participant `model:` works again, and `thinkingLevel` is passed to each child.
- Role text is delivered through `--append-system-prompt`, not pasted into a task.
- Start a fresh Pi session after upgrading so stored calls no longer request removed
  tool names.

### 0.6.0 — the pi-subagents v3 experiment

v0.6 targeted `@narumitw/pi-subagents` **v3**, which had no `subagent` tool, no
named-agent catalog, no per-job model override, and no custom system prompts. That
experiment is reverted; the v0.6 behaviour is documented here only for sessions that
still have those tool calls in history.

## Development

```bash
npm pack --dry-run
```

The extension is TypeScript loaded by pi through its extension loader. Runtime dependencies imported from pi (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`) are declared as peer dependencies per pi package guidance.

## License

MIT
