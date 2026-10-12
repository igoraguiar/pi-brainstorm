/**
 * pi-brainstorm — Multi-agent brainstorm/debate extension for Pi
 *
 * Runs brainstorm and debate sessions across multiple headless Pi participants
 * via YAML. Full participant contributions are stored in a local filesystem
 * blackboard, while the main conversation sees compact cards and facilitator
 * synthesis.
 *
 * Features:
 * - Configuration-driven participants (YAML)
 * - meeting_append_entry tool — concurrency-safe append to meeting folder
 * - meeting_read_index tool — read meeting index
 * - meeting_read_entry tool — read full entry content
 * - /brainstorm command — multi-agent brainstorming
 * - /debate command — open-ended multi-agent debate
 * - /brainstorm-lab command — v2 lab mode (artifacts/edges/state)
 * - /brainstorm-from-file, /debate-from-file — run a session from a YAML file
 *   (topic + participant agent names)
 * - meeting-entry message renderer — compact cards with expandable content
 * - File watcher — auto-posts new entries into the main conversation
 *
 * Delegation is native: participants run as headless Pi child processes that
 * this extension spawns and supervises itself (`pi --print --model <provider/id>
 * --append-system-prompt <role brief> --tools <allowlist> -e <this extension>`).
 * No subagent extension and no agent markdown files are required — YAML is the
 * single source of truth for participants, roles, and models.
 *
 * Config merging: global (~/.pi/agent/pi-brainstorm.yaml) and project
 * (.pi-brainstorm.yaml, .pi/pi-brainstorm.yaml) layers merge the `participants`
 * array by `agentName`. A project entry deep-merges over the global participant
 * with the same agentName, a new agentName is added, unmentioned global
 * participants keep running, and `disabled: true` tombstones a participant.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Text, Box } from "@earendil-works/pi-tui";
import * as YAML from "yaml";

// ────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────

interface DebatePersona {
  label: string;
  prompt: string;
}

type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

interface ParticipantConfig {
  displayName: string;
  /** Identity used when merging project config over global config. */
  agentName: string;
  description?: string;
  /**
   * Model for this participant as `provider/id[:thinking]` (e.g.
   * `openrouter/z-ai/glm-4.6:xhigh`). Authoritative: each child runs this
   * model. Omit to inherit the main agent's effective model.
   */
  model?: string;
  roleTitle?: string;
  rolePrompt: string;
  whatYouDo?: string[];
  debatePersona?: DebatePersona;
  brainstormRole?: string;
  /** Core work tools for the child (read/grep/find/ls/edit/write/bash/powershell). */
  tools?: string[];
  /** Per-participant thinking level (also expressible as a `:level` model suffix). */
  thinkingLevel?: ThinkingLevel;
  /** Per-participant child wall-clock timeout in seconds. */
  timeoutSeconds?: number;
  /**
   * Tombstone. In a project layer this drops the global participant with the
   * same agentName; in any layer it removes the participant from the session.
   */
  disabled?: boolean;
}

interface BrainstormConfig {
  participants: ParticipantConfig[];
  /** Default thinking level for children (omitted = inherit main agent). */
  thinkingLevel?: ThinkingLevel;
  /** Max participants spawned concurrently per round (default 4). */
  maxParallel?: number;
  /** Extra attempts per participant after the first failure (default 2). */
  maxRetries?: number;
  /** Default child wall-clock timeout in seconds (default 900). */
  childTimeoutSeconds?: number;
  /** Legacy alias of childTimeoutSeconds, kept so old configs keep working. */
  subagentTimeoutSeconds?: number;
  /** Override the pi executable used to spawn children. */
  piBinary?: string;
  /** Override the pi-brainstorm extension path attached to children. */
  extensionPath?: string;
  /** Set by loadConfig: tombstones that matched no participant. */
  ignoredTombstones?: string[];
}


// ────────────────────────────────────────────────────────
// Lab Mode Types (v2 Artifact System)
// ────────────────────────────────────────────────────────

interface ArtifactSourceRef {
  entryId: string;
  entryPath: string;
  sourceQuote: string;
}

type ArtifactStatus = "active" | "resolved" | "superseded" | "invalidated";
type EvidenceLevel = "strong" | "moderate" | "weak" | "none";

interface ClaimArtifact {
  type: "claim";
  id: string;
  timestamp: string;
  source: ArtifactSourceRef;
  status: ArtifactStatus;
  content: string;
  confidence: "high" | "medium" | "low";
  evidenceLevel: EvidenceLevel;
  evidenceDebt: boolean;
  acceptedBy: string[];
  challengedBy: string[];
}

interface QuestionArtifact {
  type: "question";
  id: string;
  timestamp: string;
  source: ArtifactSourceRef;
  status: ArtifactStatus;
  content: string;
  raisedBy: string;
  addressedBy: string[];
  resolution?: string;
}

interface RiskArtifact {
  type: "risk";
  id: string;
  timestamp: string;
  source: ArtifactSourceRef;
  status: ArtifactStatus;
  content: string;
  severity: "critical" | "high" | "medium" | "low";
  likelihood: "certain" | "likely" | "possible" | "unlikely";
  mitigation?: string;
}

interface EvidenceArtifact {
  type: "evidence";
  id: string;
  timestamp: string;
  source: ArtifactSourceRef;
  status: ArtifactStatus;
  content: string;
  strength: EvidenceLevel;
  supports: string[];
  opposes: string[];
}

interface DecisionArtifact {
  type: "decision";
  id: string;
  timestamp: string;
  source: ArtifactSourceRef;
  status: ArtifactStatus;
  content: string;
  rationale: string;
  blockedBy: string[];
  dependsOn: string[];
  consensus: boolean;
}

interface ActionArtifact {
  type: "action";
  id: string;
  timestamp: string;
  source: ArtifactSourceRef;
  status: ArtifactStatus;
  content: string;
  assignee: string;
  deadline?: string;
  priority: "must" | "should" | "could";
}

type Artifact =
  | ClaimArtifact
  | QuestionArtifact
  | RiskArtifact
  | EvidenceArtifact
  | DecisionArtifact
  | ActionArtifact;

type EdgeType = "supports" | "opposes" | "duplicates" | "blocks" | "resolves" | "supersedes";

interface Edge {
  id: string;
  from: string;
  to: string;
  type: EdgeType;
  creator: string;
  basis: string;
  status: "active" | "invalidated";
  timestamp: string;
}

type SessionPhase =
  | "briefing"
  | "diverge"
  | "challenge"
  | "evidence_check"
  | "converge"
  | "conclusion"
  | "archived";

interface MeetingState {
  meetingDir: string;
  topic: string;
  phase: SessionPhase;
  round: number;
  participants: string[];
  openQuestions: string[];
  activeConflicts: string[];
  acceptedDecisions: string[];
  pendingActions: string[];
  nextStep: string;
  lastUpdated: string;
  controllerReasoning?: string;
}

type EventType =
  | "facilitator_decision"
  | "user_feedback"
  | "participant_entry"
  | "artifact_generated"
  | "edge_created"
  | "state_transition"
  | "digest_generated"
  | "error"
  | "retry";

interface MeetingEvent {
  id: string;
  type: EventType;
  timestamp: string;
  agent?: string;
  summary: string;
  details: Record<string, unknown>;
}

// ────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────

const MEETING_TOOLS = [
  "meeting_append_entry",
  "meeting_read_index",
  "meeting_read_entry",
];

/** Pi core work tools a child may be given. Children never get facilitator tools. */
const CORE_WORK_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "edit",
  "write",
  "bash",
  "powershell",
] as const;

const DEFAULT_CORE_WORK_TOOLS = ["read", "grep", "find", "ls"] as const;

const VALID_THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const DEFAULT_CHILD_TIMEOUT_SECONDS = 900;
const DEFAULT_MAX_PARALLEL = 4;
const DEFAULT_MAX_RETRIES = 2;

/** /brainstorm has a fixed three-round protocol. */
const MAX_BRAINSTORM_ROUNDS = 3;

/** Upper bound for a child wall-clock timeout (seconds). */
const MAX_CHILD_TIMEOUT_SECONDS = 24 * 60 * 60;

/** Cap on captured child stdout/stderr per attempt. */
const MAX_CHILD_OUTPUT_CHARS = 400_000;

/** Grace period between SIGTERM and SIGKILL when a child is killed. */
const CHILD_KILL_GRACE_MS = 5_000;

function isValidTimeoutSeconds(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_CHILD_TIMEOUT_SECONDS
  );
}

function isValidPositiveInt(value: unknown, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= max
  );
}

// ────────────────────────────────────────────────────────
// Config helpers
// ────────────────────────────────────────────────────────

/**
 * Deep-merge two values. Arrays are replaced entirely; objects are
 * merged recursively; scalars use the overlay value.
 *
 * `participants` is NOT merged by this generic rule — see mergeParticipants.
 */
function deepMerge(base: any, overlay: any): any {
  if (overlay === null || overlay === undefined) return base;
  if (base === null || base === undefined) return overlay;

  if (Array.isArray(base) && Array.isArray(overlay)) {
    return overlay;
  }

  if (
    typeof base === "object" &&
    typeof overlay === "object" &&
    !Array.isArray(base) &&
    !Array.isArray(overlay)
  ) {
    const result: Record<string, unknown> = { ...base };
    for (const key of Object.keys(overlay)) {
      result[key] =
        key in result
          ? deepMerge(result[key], overlay[key])
          : (overlay as Record<string, unknown>)[key];
    }
    return result;
  }

  return overlay;
}

/**
 * Merge a participant list by identity (`agentName`).
 *
 * - overlay entry with an existing agentName  -> deep-merge onto that participant
 * - overlay entry with a new agentName        -> appended (global order preserved)
 * - overlay entry with `disabled: true`       -> tombstone that agentName
 * - global participant no overlay mentions    -> kept as-is
 *
 * A tombstone naming an unknown agentName is reported, not fatal.
 */
function mergeParticipants(
  base: unknown[],
  overlay: unknown[],
  ignoredTombstones: string[]
): any[] {
  const merged = base.map((entry) => ({ ...(entry as any) }));
  const indexOf = new Map<string, number>();
  for (let i = 0; i < merged.length; i++) {
    const name = typeof merged[i].agentName === "string" ? merged[i].agentName.trim() : "";
    if (name && !indexOf.has(name)) indexOf.set(name, i);
  }

  for (const raw of overlay) {
    const entry = { ...(raw as any) };
    const name = typeof entry.agentName === "string" ? entry.agentName.trim() : "";

    if (!name) {
      // Missing identity: let validateParticipants report it precisely.
      merged.push(entry);
      continue;
    }

    const at = indexOf.get(name);
    if (at === undefined) {
      if (entry.disabled === true) {
        if (!ignoredTombstones.includes(name)) ignoredTombstones.push(name);
        continue;
      }
      indexOf.set(name, merged.length);
      merged.push(entry);
      continue;
    }

    if (entry.disabled === true) {
      merged[at] = { ...merged[at], disabled: true };
      continue;
    }

    merged[at] = deepMerge(merged[at], entry);
  }

  return merged.filter((entry) => entry?.disabled !== true);
}

/**
 * Merge one config layer. Scalars and objects use deepMerge; `participants`
 * merges by agentName so a project file patches the global roster instead of
 * replacing it.
 */
function mergeConfigLayer(
  base: any,
  overlay: any,
  ignoredTombstones: string[]
): any {
  if (Array.isArray(base?.participants) && Array.isArray(overlay?.participants)) {
    return {
      ...deepMerge(base, { ...overlay, participants: undefined }),
      participants: mergeParticipants(
        base.participants,
        overlay.participants,
        ignoredTombstones
      ),
    };
  }

  const merged = deepMerge(base, overlay);
  if (Array.isArray(merged.participants)) {
    merged.participants = merged.participants.filter(
      (entry: any) => entry?.disabled !== true
    );
  }
  return merged;
}

/**
 * Resolve extension directory from import.meta.url.
 */
function getExtensionDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/**
 * Load and merge config from all locations, in priority order (later wins):
 *   1. Package default: config/default.yaml (relative to package root or extension dir)
 *      Also try brainstorm.yaml in extension dir (for manual installs)
 *   2. User override: ~/.pi/agent/pi-brainstorm.yaml
 *   3. Project override: {cwd}/.pi-brainstorm.yaml
 *   4. Project override: {cwd}/.pi/pi-brainstorm.yaml
 *
 * `participants` merges by agentName across layers: a later layer patches the
 * participant with the same agentName, new agentNames are added, unmentioned
 * participants survive, and `disabled: true` tombstones one.
 */
function loadConfig(cwd: string): BrainstormConfig {
  const extensionDir = getExtensionDir();
  const packageRoot = path.dirname(extensionDir);
  const ignoredTombstones: string[] = [];

  // Step 1: package/extension defaults
  const defaultCandidates = [
    path.join(packageRoot, "config", "default.yaml"),
    path.join(extensionDir, "config", "default.yaml"),
    path.join(extensionDir, "brainstorm.yaml"),
  ];

  let merged: any = {};
  let loadedAny = false;

  for (const candidate of defaultCandidates) {
    if (fs.existsSync(candidate)) {
      try {
        const raw = fs.readFileSync(candidate, "utf-8");
        const parsed = YAML.parse(raw);
        if (parsed && typeof parsed === "object") {
          merged = mergeConfigLayer(merged, parsed, ignoredTombstones);
          loadedAny = true;
        }
      } catch (err: any) {
        throw new Error(
          `Failed to parse config ${candidate}: ${err.message}`
        );
      }
    }
  }

  if (!loadedAny) {
    throw new Error(
      "No pi-brainstorm config found. Expected config/default.yaml in package root or extension directory."
    );
  }

  // Step 2: user override
  const userPath = path.join(getAgentDir(), "pi-brainstorm.yaml");
  if (fs.existsSync(userPath)) {
    try {
      const raw = fs.readFileSync(userPath, "utf-8");
      const parsed = YAML.parse(raw);
      if (parsed && typeof parsed === "object") {
        merged = mergeConfigLayer(merged, parsed, ignoredTombstones);
      }
    } catch (err: any) {
      throw new Error(
        `Failed to parse user config ${userPath}: ${err.message}`
      );
    }
  }

  // Step 3: project overrides
  const projectCandidates = cwd
    ? [path.join(cwd, ".pi-brainstorm.yaml"), path.join(cwd, ".pi", "pi-brainstorm.yaml")]
    : [];

  for (const candidate of projectCandidates) {
    if (fs.existsSync(candidate)) {
      try {
        const raw = fs.readFileSync(candidate, "utf-8");
        const parsed = YAML.parse(raw);
        if (parsed && typeof parsed === "object") {
          merged = mergeConfigLayer(merged, parsed, ignoredTombstones);
        }
      } catch (err: any) {
        throw new Error(
          `Failed to parse project config ${candidate}: ${err.message}`
        );
      }
    }
  }

  merged.ignoredTombstones = ignoredTombstones;
  return merged as BrainstormConfig;
}

/**
 * Resolve and validate participants for a command invocation.
 * Returns validated participant array; throws with a clear message on failure.
 */
function isSafeAgentName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/.test(value);
}

function validateParticipants(
  participants: ParticipantConfig[] | undefined,
  configKey: string
): ParticipantConfig[] {
  if (!participants || !Array.isArray(participants) || participants.length === 0) {
    throw new Error(
      `pi-brainstorm config must define at least one participant under '${configKey}'.`
    );
  }

  const requiredFields: (keyof ParticipantConfig)[] = [
    "displayName",
    "agentName",
    "rolePrompt",
  ];

  const seenAgentNames = new Set<string>();
  for (let i = 0; i < participants.length; i++) {
    const p = participants[i];
    for (const field of requiredFields) {
      if (!p[field]) {
        throw new Error(
          `Participant at ${configKey}[${i}] is missing required field "${field}".`
        );
      }
    }
    if (typeof p.displayName !== "string" || !p.displayName.trim()) {
      throw new Error(
        `Participant at ${configKey}[${i}] has invalid displayName.`
      );
    }
    if (typeof p.agentName !== "string" || !p.agentName.trim()) {
      throw new Error(
        `Participant at ${configKey}[${i}] has invalid agentName.`
      );
    }
    if (!isSafeAgentName(p.agentName)) {
      throw new Error(
        `Participant "${p.displayName}" has unsafe agentName "${p.agentName}". Use only letters, digits, dot, underscore, and hyphen; it must start with a letter or digit.`
      );
    }
    if (seenAgentNames.has(p.agentName)) {
      throw new Error(
        `Duplicate agentName "${p.agentName}" in ${configKey}. Each participant must use a distinct agentName.`
      );
    }
    seenAgentNames.add(p.agentName);
    if (p.disabled !== undefined && typeof p.disabled !== "boolean") {
      throw new Error(
        `Participant "${p.displayName ?? p.agentName}" has invalid disabled. Use true or false.`
      );
    }
    if (p.model !== undefined && (typeof p.model !== "string" || !p.model.trim())) {
      throw new Error(
        `Participant at ${configKey}[${i}] has invalid model.`
      );
    }
    if (typeof p.rolePrompt !== "string" || !p.rolePrompt.trim()) {
      throw new Error(
        `Participant at ${configKey}[${i}] has invalid rolePrompt.`
      );
    }
    if (
      p.thinkingLevel !== undefined &&
      !VALID_THINKING_LEVELS.includes(p.thinkingLevel)
    ) {
      throw new Error(
        `Participant "${p.displayName}" has invalid thinkingLevel "${p.thinkingLevel}". Allowed: ${VALID_THINKING_LEVELS.join(", ")}.`
      );
    }
    if (p.timeoutSeconds !== undefined && !isValidTimeoutSeconds(p.timeoutSeconds)) {
      throw new Error(
        `Participant "${p.displayName}" has invalid timeoutSeconds. Use a finite number in (0, ${MAX_CHILD_TIMEOUT_SECONDS}].`
      );
    }
  }

  return participants;
}


// ────────────────────────────────────────────────────────
// Native child runner (headless Pi subprocesses)
// ────────────────────────────────────────────────────────

type ParticipantState = "ok" | "failed" | "timeout" | "unavailable";

interface ParticipantOutcome {
  agentName: string;
  displayName: string;
  model: string;
  state: ParticipantState;
  attempts: number;
  entryId?: string;
  entryPath?: string;
  summary?: string;
  error?: string;
}

interface SessionState {
  kind: SessionKind;
  topic: string;
  participants: ParticipantConfig[];
  config: BrainstormConfig;
}

/** meetingDir -> session state, so the run tools know who the participants are. */
const activeSessions = new Map<string, SessionState>();

/** Live child processes, killed on session shutdown. */
const activeChildren = new Set<ChildProcessWithoutNullStreams>();

/**
 * Path to this extension file. It is attached to every child (`-e <path>`) so
 * children can use the blackboard tools: a child only gets the tools this
 * extension registers, filtered by the `--tools` allowlist.
 */
function extensionAttachmentPath(config: BrainstormConfig): string {
  return config.extensionPath ?? path.join(getExtensionDir(), "brainstorm.ts");
}

/** Core work tools for a child. Facilitator and lab tools are never granted. */
function participantCoreTools(participant: ParticipantConfig): string[] {
  const requested = (participant.tools ?? []).filter((tool) =>
    (CORE_WORK_TOOLS as readonly string[]).includes(tool)
  );
  return requested.length > 0 ? requested : [...DEFAULT_CORE_WORK_TOOLS];
}

function resolveMaxParallel(config: BrainstormConfig): number {
  return isValidPositiveInt(config.maxParallel, 16) ? config.maxParallel : DEFAULT_MAX_PARALLEL;
}

function resolveMaxRetries(config: BrainstormConfig): number {
  return isValidPositiveInt(config.maxRetries, 5) ? config.maxRetries : DEFAULT_MAX_RETRIES;
}

function resolveTimeoutSeconds(
  config: BrainstormConfig,
  participant: ParticipantConfig
): number {
  const value =
    participant.timeoutSeconds ??
    config.childTimeoutSeconds ??
    config.subagentTimeoutSeconds;
  return isValidTimeoutSeconds(value) ? value : DEFAULT_CHILD_TIMEOUT_SECONDS;
}

/**
 * Parse a `provider/id[:thinking]` model spec. Model ids may contain `/`
 * (e.g. `openrouter/z-ai/glm-4.6`), so only the first `/` splits the provider.
 */
function parseModelSpec(raw: string): {
  provider: string;
  id: string;
  thinking?: ThinkingLevel;
} | null {
  const value = raw.trim();
  if (!value) return null;

  let rest = value;
  let thinking: ThinkingLevel | undefined;
  const lastColon = rest.lastIndexOf(":");
  if (lastColon > -1) {
    const candidate = rest.slice(lastColon + 1);
    if ((VALID_THINKING_LEVELS as readonly string[]).includes(candidate)) {
      thinking = candidate as ThinkingLevel;
      rest = rest.slice(0, lastColon);
    }
  }

  const slash = rest.indexOf("/");
  if (slash < 1 || slash === rest.length - 1) return null;

  const provider = rest.slice(0, slash);
  const id = rest.slice(slash + 1);
  if (!provider || !id || /\s/.test(provider)) return null;
  return { provider, id, thinking };
}

/**
 * Locate the pi package that this extension was installed alongside. pi is
 * ESM-only and does not export ./package.json, so `require.resolve` cannot find
 * it; walk up the directory tree instead.
 */
/** Read the `pi` bin entry out of a pi package.json. Returns null if unusable. */
function piBinFromPackageJson(pkgJson: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf-8"));
    const binEntry = pkg.bin;
    let bin: string | undefined;
    if (typeof binEntry === "string") {
      bin = binEntry;
    } else if (binEntry && typeof binEntry.pi === "string") {
      bin = binEntry.pi;
    }
    if (!bin) return null;

    const binPath = path.resolve(path.dirname(pkgJson), bin);
    return fs.existsSync(binPath) ? binPath : null;
  } catch {
    // Malformed package.json.
    return null;
  }
}

function findPiPackageBin(seedDirs: string[]): string | null {
  for (const seed of seedDirs) {
    if (!seed) continue;
    let dir = path.resolve(seed);
    for (let depth = 0; depth < 8; depth++) {
      const pkgJson = path.join(
        dir,
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "package.json"
      );
      if (fs.existsSync(pkgJson)) {
        const binPath = piBinFromPackageJson(pkgJson);
        if (binPath) return binPath;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/**
 * Resolve the pi executable used to spawn children. Order: explicit config/env
 * override, the pi package installed alongside this extension (spawned with the
 * current Node binary so the child matches the host version), then `pi` on PATH.
 */
function resolvePiCommand(config: BrainstormConfig): { command: string; prefixArgs: string[] } {
  const override = config.piBinary ?? process.env.PI_BRAINSTORM_PI_BIN;
  if (override) {
    return isJsEntry(override)
      ? { command: process.execPath, prefixArgs: [override] }
      : { command: override, prefixArgs: [] };
  }

  const seeds = [getExtensionDir(), process.cwd()];
  const piBin = findPiPackageBin(seeds);
  if (piBin) return { command: process.execPath, prefixArgs: [piBin] };

  const executable = process.platform === "win32" ? "pi.cmd" : "pi";
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, executable);
    if (fs.existsSync(candidate)) return { command: candidate, prefixArgs: [] };
  }

  return { command: "pi", prefixArgs: [] };
}

function isJsEntry(value: string): boolean {
  return /\.(js|mjs|cjs)$/i.test(value);
}

interface PreflightResult {
  ok: boolean;
  modelArg?: string;
  thinkingLevel?: ThinkingLevel;
  reason?: string;
}

/**
 * Verify a participant's model can actually run in a child process before
 * spawning anything: the spec must parse, the model must exist in the
 * registry, and its provider must have credentials a child can read.
 */
function preflightParticipant(
  ctx: any,
  participant: ParticipantConfig
): PreflightResult {
  const registry = ctx?.modelRegistry;

  if (participant.model) {
    const spec = parseModelSpec(participant.model);
    if (!spec) {
      return {
        ok: false,
        reason: `invalid model spec "${participant.model}" (expected provider/id[:thinking])`,
      };
    }
    if (!registry) {
      return { ok: false, reason: "model registry unavailable; cannot verify model" };
    }
    const model = registry.find(spec.provider, spec.id);
    if (!model) {
      return {
        ok: false,
        reason: `model ${spec.provider}/${spec.id} not found (check \`pi --list-models\`)`,
      };
    }
    if (registry.hasConfiguredAuth && !registry.hasConfiguredAuth(model)) {
      const status = registry.getProviderAuthStatus?.(spec.provider);
      const source = status?.source ?? "none";
      return {
        ok: false,
        reason:
          `provider ${spec.provider} has no credentials a child process can read ` +
          `(auth source: ${source}). Configure stored or environment credentials.`,
      };
    }
    const thinkingLevel =
      participant.thinkingLevel ?? spec.thinking;
    return {
      ok: true,
      modelArg: `${spec.provider}/${spec.id}`,
      thinkingLevel,
    };
  }

  const mainModel = ctx?.model;
  if (!mainModel) {
    return { ok: false, reason: "no model configured and no main model to inherit" };
  }
  const inherited = participant.thinkingLevel ?? ctx?.thinkingLevel;
  return {
    ok: true,
    modelArg: `${mainModel.provider}/${mainModel.id}`,
    thinkingLevel: inherited,
  };
}

/** The role text a participant carries into its child's system prompt. */
function participantRoleText(
  participant: ParticipantConfig,
  mode: "brainstorm" | "debate" | "lab"
): string {
  if (mode === "debate" && participant.debatePersona?.prompt) {
    return participant.debatePersona.prompt.trim();
  }
  return participant.rolePrompt.trim();
}

/**
 * Build the per-participant role brief passed to the child through
 * `--append-system-prompt`. This replaces the old agent markdown files: it is
 * regenerated per round inside the meeting folder and is not a global catalog.
 */
function buildRoleBrief(
  participant: ParticipantConfig,
  mode: "brainstorm" | "debate" | "lab"
): string {
  const roleTitle = participant.roleTitle ? ` — ${participant.roleTitle}` : "";
  const focusItems = participant.whatYouDo?.length
    ? participant.whatYouDo
    : ["Join the multi-agent discussion and provide a distinctive perspective"];
  const coreTools = participantCoreTools(participant);
  const readOnly = coreTools.every(
    (tool) => tool === "read" || tool === "grep" || tool === "find" || tool === "ls"
  );

  const notDo = [
    readOnly
      ? "Never write code or modify project files; you only read them"
      : "Only modify files when your round mission explicitly asks you to",
    "Never delegate to other agents and never spawn sub-agents",
    "Never paste long analyses into chat; write your FULL contribution with " +
      "meeting_append_entry, then reply only with WROTE_ENTRY plus a one-sentence summary",
  ];

  return [
    `# ${participant.displayName} (${participant.agentName})${roleTitle}`,
    "",
    participantRoleText(participant, mode),
    "",
    "## What You Do",
    focusItems.map((item) => `- ${item}`).join("\n"),
    "",
    "## What You Do Not Do",
    notDo.map((item) => `- ${item}`).join("\n"),
    "",
    "## Worker Preamble",
    "You are a terminal worker. Work directly with tools. Do NOT spawn sub-agents.",
    "",
  ].join("\n");
}

/** Write the role brief for one participant and return its path. */
async function writeRoleBrief(
  absDir: string,
  participant: ParticipantConfig,
  mode: "brainstorm" | "debate" | "lab"
): Promise<string> {
  const rolesDir = path.join(absDir, "roles");
  await fsp.mkdir(rolesDir, { recursive: true });
  assertDirectoryNoSymlink(rolesDir, "roles directory");

  const briefPath = path.join(rolesDir, `${participant.agentName}.md`);
  assertWritableFilePath(briefPath, absDir, "participant role brief");
  await fsp.writeFile(briefPath, buildRoleBrief(participant, mode), "utf-8");
  return briefPath;
}

/** The self-contained task handed to one participant child. */
function buildParticipantTask(options: {
  participant: ParticipantConfig;
  topic: string;
  absDir: string;
  phase: string;
  mission: string;
  priorContext: "none" | "read";
  retryNote?: string;
}): string {
  const { participant, topic, absDir, phase, mission, priorContext, retryNote } = options;

  const priorStep =
    priorContext === "none"
      ? "There are no prior entries to read for this phase."
      :
      "First call meeting_read_index({ meetingDir }) on the meeting directory, then " +
      "meeting_read_entry({ meetingDir, entryPath }) for the entries you need, and " +
      "respond to them. Never invent prior contributions you have not read.";

  return [
    `You are the participant "${participant.displayName}" (${participant.agentName}) in a multi-agent session.`,
    "Your role brief is already in your system prompt; follow it exactly.",
    "",
    `Topic: ${topic}`,
    `Meeting blackboard directory: ${absDir}`,
    `Phase: ${phase}`,
    "",
    `MISSION: ${mission}`,
    "",
    `PRIOR CONTEXT: ${priorStep}`,
    "",
    "STEPS:",
    "1. Read any prior context from the blackboard (see PRIOR CONTEXT above).",
    "2. Write your FULL contribution with meeting_append_entry:",
    "   meeting_append_entry({",
    `     meetingDir: "${absDir}",`,
    `     speaker: "${participant.displayName}",`,
    `     phase: "${phase}",`,
    '     summary: "<one sentence>",',
    '     content: "<your complete analysis — in the user\'s language, default English>"',
    "   })",
    "3. Reply with ONLY: WROTE_ENTRY: <your one-sentence summary>",
    "",
    "RULES:",
    "- Write your FULL analysis to the blackboard, never to the chat.",
    "- Do not include wrapper tags, hidden thinking markers, or tool-call text inside content.",
    "- Do not delegate or spawn sub-agents.",
    "- Finish your contribution and return; do not ask questions.",
    retryNote ? `\nNOTE: ${retryNote}` : "",
  ].join("\n");
}

/** Default mission text for a round/cycle when the facilitator supplies none. */
function defaultMission(
  mode: "brainstorm" | "debate" | "lab",
  unitLabel: string,
  unitNumber: number,
  topic: string,
  isFinal: boolean
): string {
  if (mode === "debate") {
    return (
      `Read the full debate record, then advance your position: attack the weakest ` +
      `point you can find in the other participants' entries, defend your own ` +
      `position against the strongest objection so far, and concede explicitly where ` +
      `you are wrong. Topic: ${topic}.`
    );
  }
  if (unitNumber <= 1) {
    return `Give your independent initial analysis of: ${topic}. Cover assumptions, options, risks, and what you would actually do.`;
  }
  if (isFinal) {
    return (
      `Read every prior entry, then give your FINAL recommendation for: ${topic}. ` +
      `Synthesize the best ideas from the other participants, keep what survives ` +
      `criticism, and state what you changed your mind about.`
    );
  }
  return (
    `Read the ${unitLabel} ${unitNumber - 1} entries, then challenge the other ` +
    `participants' positions and improve your own for: ${topic}. Be specific about ` +
    `which entry you are responding to.`
  );
}

interface ChildRunResult {
  state: "ok" | "timeout" | "failed";
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
}

/** Run one headless pi child to completion, timeout, or failure. */
function runChildPi(options: {
  command: string;
  args: string[];
  cwd: string;
  timeoutSeconds: number;
}): Promise<ChildRunResult> {
  const { command, args, cwd, timeoutSeconds } = options;

  return new Promise<ChildRunResult>((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: any) {
      resolve({
        state: "failed",
        stdout: "",
        stderr: "",
        exitCode: null,
        error: `spawn failed: ${err?.message ?? String(err)}`,
      });
      return;
    }

    activeChildren.add(child);

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const append = (current: string, chunk: Buffer | string): string => {
      const next = current + String(chunk);
      return next.length > MAX_CHILD_OUTPUT_CHARS ? next.slice(0, MAX_CHILD_OUTPUT_CHARS) : next;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });

    const killChild = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
      const hardKill = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }, CHILD_KILL_GRACE_MS);
      hardKill.unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, timeoutSeconds * 1000);
    timer.unref();

    const finish = (result: ChildRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeChildren.delete(child);
      resolve(result);
    };

    child.on("error", (err) => {
      finish({
        state: "failed",
        stdout,
        stderr,
        exitCode: null,
        error: `child error: ${err.message}`,
      });
    });

    child.on("close", (code) => {
      if (timedOut) {
        finish({
          state: "timeout",
          stdout,
          stderr,
          exitCode: code,
          error: `timed out after ${timeoutSeconds}s`,
        });
        return;
      }
      if (code === 0) {
        finish({ state: "ok", stdout, stderr, exitCode: code });
        return;
      }
      finish({
        state: "failed",
        stdout,
        stderr,
        exitCode: code,
        error: `child exited with code ${code}`,
      });
    });
  });
}

/** Read index.jsonl entries for a meeting. Returns [] when absent or unreadable. */
async function readIndexEntries(absDir: string): Promise<any[]> {
  try {
    const raw = await fsp.readFile(path.join(absDir, "index.jsonl"), "utf-8");
    return raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/**
 * Run one participant to completion with retries. Success requires: exit 0,
 * a `WROTE_ENTRY` marker in the child's output, and a NEW index entry for
 * this speaker+phase.
 */
async function runParticipant(options: {
  ctx: any;
  config: BrainstormConfig;
  participant: ParticipantConfig;
  mode: "brainstorm" | "debate" | "lab";
  absDir: string;
  topic: string;
  phase: string;
  mission: string;
  priorContext: "none" | "read";
}): Promise<ParticipantOutcome> {
  const { ctx, config, participant, mode, absDir, topic, phase, mission, priorContext } = options;

  const base: ParticipantOutcome = {
    agentName: participant.agentName,
    displayName: participant.displayName,
    model: participant.model ?? "(inherit main model)",
    state: "failed",
    attempts: 0,
  };

  const ready = preflightParticipant(ctx, participant);
  const modelArg = ready.modelArg;
  if (!ready.ok || !modelArg) {
    return {
      ...base,
      state: "unavailable",
      error: ready.reason ?? "model preflight failed",
    };
  }
  base.model = modelArg;

  const piCommand = resolvePiCommand(config);
  const extPath = extensionAttachmentPath(config);
  if (!fs.existsSync(extPath)) {
    return {
      ...base,
      state: "unavailable",
      error: `cannot find the pi-brainstorm extension to attach: ${extPath}`,
    };
  }

  let briefPath: string;
  try {
    briefPath = await writeRoleBrief(absDir, participant, mode);
  } catch (err: any) {
    return { ...base, state: "unavailable", error: `role brief failed: ${err.message}` };
  }

  const tools = [
    ...new Set([...participantCoreTools(participant), ...MEETING_TOOLS]),
  ];
  const timeoutSeconds = resolveTimeoutSeconds(config, participant);
  const maxRetries = resolveMaxRetries(config);
  const projectTrusted =
    typeof ctx?.isProjectTrusted === "function" ? ctx.isProjectTrusted() : true;

  let lastError = "";

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const entriesBefore = await readIndexEntries(absDir);

    const task = buildParticipantTask({
      participant,
      topic,
      absDir,
      phase,
      mission,
      priorContext,
      retryNote:
        attempt > 1
          ? `PREVIOUS ATTEMPT FAILED (${lastError || "unknown error"}). This is retry ${
              attempt - 1
            } of ${maxRetries}. Complete your contribution and end with WROTE_ENTRY.`
          : undefined,
    });

    const args = [
      ...piCommand.prefixArgs,
      "--print",
      "--no-session",
      "--model",
      modelArg,
      "--tools",
      tools.join(","),
      "--append-system-prompt",
      briefPath,
      "-e",
      extPath,
      projectTrusted ? "--approve" : "--no-approve",
    ];
    if (ready.thinkingLevel) args.push("--thinking", ready.thinkingLevel);
    args.push("--", task);

    const run = await runChildPi({
      command: piCommand.command,
      args,
      cwd: ctx.cwd,
      timeoutSeconds,
    });

    const entriesAfter = await readIndexEntries(absDir);
    const newEntry = entriesAfter
      .slice(entriesBefore.length)
      .find((entry) => entry?.speaker === participant.displayName && entry?.phase === phase);

    const wroteMarker = run.stdout.includes("WROTE_ENTRY");

    if (run.state === "ok" && wroteMarker && newEntry) {
      return {
        ...base,
        state: "ok",
        attempts: attempt,
        entryId: newEntry.id,
        entryPath: newEntry.path,
        summary: typeof newEntry.summary === "string" ? newEntry.summary : "(no summary)",
      };
    }

    if (run.state === "timeout") {
      lastError = run.error ?? `timed out after ${timeoutSeconds}s`;
    } else if (wroteMarker && !newEntry) {
      lastError = "child reported WROTE_ENTRY but no matching index entry landed";
    } else if (run.exitCode !== 0) {
      lastError = run.error ?? `child exited with code ${run.exitCode}`;
    } else {
      lastError =
        run.stderr.trim().slice(0, 300) ||
        run.error ||
        "child finished without a WROTE_ENTRY marker";
    }

    if (attempt <= maxRetries) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
    }
  }

  return { ...base, state: lastError.includes("timed out") ? "timeout" : "failed", error: lastError };
}

/** Run participants with a concurrency cap, preserving input order in results. */
async function runParticipantsParallel<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<ParticipantOutcome>
): Promise<ParticipantOutcome[]> {
  const results: ParticipantOutcome[] = [];
  let next = 0;

  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push(
      (async (): Promise<void> => {
        for (;;) {
          const index = next++;
          if (index >= items.length) return;
          results[index] = await fn(items[index]);
        }
      })()
    );
  }

  await Promise.all(workers);
  return results;
}

function formatOutcomes(
  outcomes: ParticipantOutcome[],
  unitLabel: string,
  unitNumber: number
): string {
  const ok = outcomes.filter((o) => o.state === "ok");
  const bad = outcomes.filter((o) => o.state !== "ok");

  const lines = [
    `${unitLabel} ${unitNumber}: ${ok.length}/${outcomes.length} participants wrote entries.`,
    "",
    ...ok.map(
      (o) =>
        `  ✅ ${o.displayName} (${o.agentName}) [${o.model}] entry ${o.entryId}: ${o.summary}`
    ),
    ...bad.map(
      (o) =>
        `  ❌ ${o.displayName} (${o.agentName}) [${o.model}] ${o.state.toUpperCase()}` +
        `${o.attempts ? ` after ${o.attempts} attempt(s)` : ""}: ${o.error ?? "unknown error"}`
    ),
    "",
    bad.length
      ? "Failed participants did not write an entry. Do NOT invent their content. Present them as \"did not respond\" and continue."
      : "All participants wrote their entries.",
  ];

  return lines.join("\n");
}

interface RosterResult {
  ok: boolean;
  config?: BrainstormConfig;
  participants?: ParticipantConfig[];
  topic?: string;
  error?: string;
}

/** Resolve the roster for a meeting directory, falling back to the config. */
async function resolveSessionParticipants(
  ctx: any,
  absDir: string,
  selector?: string[]
): Promise<RosterResult> {
  let config: BrainstormConfig;
  try {
    config = loadConfig(ctx.cwd);
  } catch (err: any) {
    return { ok: false, error: `config error: ${err.message}` };
  }

  const session = activeSessions.get(absDir);
  let pool: ParticipantConfig[];
  try {
    pool = session
      ? session.participants
      : validateParticipants(config.participants, "participants");
    const participants = selector ? selectParticipants(pool, selector) : pool;

    let topic = session?.topic;
    if (!topic) {
      const manifest = await readManifest(absDir);
      topic = manifest?.topic ?? "the meeting topic";
    }

    return { ok: true, config, participants, topic };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

/** Build a standard tool error result. */
function toolError(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: {},
    isError: true,
  };
}

/**
 * Shared delegation guide injected into every facilitator prompt. Delegation is
 * done by these extension tools, not by a subagent extension: the facilitator
 * never pastes role text or spawn options.
 */
function buildNativeRunnerGuide(
  config: BrainstormConfig,
  participants: ParticipantConfig[],
  mode: "brainstorm" | "debate" | "lab"
): string[] {
  const roster = participants
    .map(
      (p) =>
        `- **${p.displayName}** — agentName \`${p.agentName}\` — model \`${
          p.model ?? "inherit main model"
        }\``
    )
    .join("\n");

  const isDebate = mode === "debate";
  const maxParallel = isDebate ? 1 : resolveMaxParallel(config);
  const maxRetries = resolveMaxRetries(config);

  return [
    "## PARTICIPANT EXECUTION (native headless Pi children)",
    "",
    "Participants run as headless Pi child processes that this extension spawns and",
    "supervises. You do NOT write their prompts, roles, models, or tool lists, and you",
    "must NOT paste participant text into a task. Call the run tool for the unit:",
    "",
    isDebate
      ? "```js\nmeeting_run_cycle({ meetingDir: \"<MEETING_DIR>\", cycle: 1, agentName: \"<agentName>\" })\n```"
      : "```js\nmeeting_run_round({ meetingDir: \"<MEETING_DIR>\", round: 1 })\n```",
    "",
    isDebate
      ? "`meeting_run_cycle` runs ONE participant at a time (a debater must see every prior entry). Run it once per debater per cycle."
      : `\`meeting_run_round\` runs ALL participants in parallel (up to ${maxParallel} at a time), each reading prior entries from the blackboard itself.`,
    "",
    `Each attempt is bounded by a wall-clock timeout (default ${DEFAULT_CHILD_TIMEOUT_SECONDS}s) and retried up to ${maxRetries} time(s) inside the tool.`,
    "Each child gets: its role brief in the system prompt, a self-contained task, its",
    "configured model, and only `read/grep/find/ls` plus `meeting_append_entry`,",
    "`meeting_read_index`, `meeting_read_entry`. Facilitator and lab tools stay with you.",
    "",
    "The tool returns one line per participant with state `ok`, `failed`, `timeout`, or",
    "`unavailable`, plus the entry id and summary. Never fabricate a missing participant's content.",
    "",
    "### Roster",
    roster,
    "",
  ];
}


// ────────────────────────────────────────────────────────
// Prompt builders
// ────────────────────────────────────────────────────────

/** Shared failure-handling block for participant runs. */
function failureHandlingSection(
  unit: "round" | "cycle",
  actor: "consultant" | "debater"
): string[] {
  return [
    "## FAILURE HANDLING",
    `The run tool already retried each ${actor} (default 3 attempts) and reports one state per participant.`,
    "",
    "### Reading the result",
    `- \`ok\` — the ${actor} wrote an entry; the entry id and summary are returned.`,
    "- `failed` — the child errored or never wrote an entry, after all retries.",
    "- `timeout` — the child hit its wall-clock timeout and was killed.",
    "- `unavailable` — the participant's model could not be verified or authenticated; no child was spawned.",
    "",
    "### What you do next",
    `- Do NOT re-run a whole ${unit} because one ${actor} failed.`,
    "- Proceed with the participants who succeeded, and mark the rest as \"[displayName] ([agentName]): did not respond\".",
    `- You MAY re-run a single ${actor} with \`participants: [\"<agentName>\"]\` when the failure looks transient (rate limit, network).`,
    `- If the same ${actor} fails in 2 consecutive ${unit}s, warn the user with the real display name and model.`,
    `- Continue to the next ${unit} normally — do not drop them permanently; they may recover.`,
    "",
    "### NEVER do this",
    `- Do NOT fabricate or simulate a ${actor}'s response.`,
    "- Do NOT paste participant full text into chat; it is on the blackboard.",
    `- Do NOT abort the entire session because one ${actor} failed.`,
    "",
  ];
}

/**
 * Build the facilitator prompt for /brainstorm.
 */
function buildBrainstormPrompt(
  topic: string,
  absDir: string,
  config: BrainstormConfig,
  participants: ParticipantConfig[]
): string {
  const consultantLines = participants
    .map(
      (p) =>
        `- **${p.displayName}** (${p.agentName}) [${p.model ?? "inherit main model"}]: ${
          p.brainstormRole || p.roleTitle || "Consultant"
        } — run with meeting_run_round.`
    )
    .join("\n");

  return [
    `BLACKBOARD BRAINSTORMING SESSION: ${topic}`,
    "",
    `Initial meeting folder: \`${absDir}\``,
    "",
    "You are facilitating a round-robin brainstorming session using the MEETING BLACKBOARD.",
    "Each consultant writes their FULL contribution to disk via meeting_append_entry.",
    "",
    "## Consultants (3 rounds)",
    consultantLines,
    "",
    ...buildNativeRunnerGuide(config, participants, "brainstorm"),
    "",
    "## PRE-ROUND STEP — Assign a Human-Readable Title",
    "",
    `Before Round 1, choose a concise human-readable meeting title for "${topic}" and call:`,
    `  meeting_rename({ meetingDir: "${absDir}", title: "<your concise title>" })`,
    "",
    "Use the returned `newMeetingDir` for ALL subsequent meeting tools. If rename fails, continue with the original meetingDir.",
    "After renaming, replace every `<MEETING_DIR>` placeholder in the task template with the current meeting directory.",
    "",
    "## CRITICAL INSTRUCTIONS",
    "",
    "### Blackboard-first — the blackboard is the single source of truth",
    "",
    "You never paste participant text into a participant task. `meeting_run_round` tells each child to read prior entries from the blackboard itself.",
    "",
    "- Round 1: participants write initial analysis. There are no prior entries to read.",
    "- Round 2: children read Round 1 entries from the blackboard before responding.",
    "- Round 3: children read ALL prior round entries AND any User feedback entries.",
    '- User feedback: if the user gives feedback that exists only in chat, APPEND it to the blackboard first with `meeting_append_entry({ speaker: "User", phase: "Feedback after Round N", summary, content })`, then run the next round.',
    "",
    "### Running a round",
    "1. `meeting_run_round({ meetingDir: \"<current meetingDir>\", round: 1 })` — runs every participant in parallel, retries failures, and returns one line per participant.",
    "2. Read the returned states. `ok` lines include the entry id and one-sentence summary.",
    "3. `meeting_read_index({ meetingDir })` to confirm what landed, then present your structural overview.",
    "",
    "Rounds 2 and 3 are the same call with a higher `round`. Optional `mission` overrides the default round mission; optional `participants: [\"<agentName>\", ...]` narrows the round to a subset.",
    "",
    ...failureHandlingSection("round", "consultant"),
    "## IMPORTANT",
    "- Respond in the language the user uses; default to English.",
    "- Save `transcript.md` and, after the user confirms, `conclusion.md`.",
    "- The user can intervene at any time to steer the discussion.",
  ].join("\n");
}

/**
 * Build the facilitator prompt for /debate.
 */
function buildDebatePrompt(
  topic: string,
  absDir: string,
  config: BrainstormConfig,
  participants: ParticipantConfig[]
): string {
  const debaterLines = participants
    .map((p) => {
      const persona = p.debatePersona;
      if (persona) {
        return `- **${p.displayName}** (${p.agentName}): ${persona.label} — attack other positions, find flaws, expose assumptions.`;
      }
      return `- **${p.displayName}** (${p.agentName})`;
    })
    .join("\n");

  return [
    `⚔️ BLACKBOARD DEBATE: ${topic}`,
    "",
    `Initial meeting folder: \`${absDir}\``,
    "",
    "You are facilitating an OPEN-ENDED debate using the MEETING BLACKBOARD.",
    "Each debater writes their FULL argument to disk via meeting_append_entry.",
    "Continue until the debate CONVERGES or the user intervenes.",
    "",
    "## Debaters (cycling indefinitely)",
    debaterLines,
    "",
    ...buildNativeRunnerGuide(config, participants, "debate"),
    "",
    "## PRE-ROUND STEP — Assign a Human-Readable Title",
    "",
    `Before Cycle 1, choose a concise human-readable meeting title for "${topic}" and call:`,
    `  meeting_rename({ meetingDir: "${absDir}", title: "<your concise title>" })`,
    "",
    "Use the returned `newMeetingDir` for ALL subsequent meeting tools. If rename fails, continue with the original meetingDir.",
    "After renaming, replace every `<MEETING_DIR>` placeholder in the task template with the current meeting directory.",
    "",
    "## CRITICAL INSTRUCTIONS",
    "",
    "### Blackboard-first — the blackboard is the single source of truth",
    "",
    "You never paste debate history into a participant task. Each child reads the record itself.",
    "",
    "- Every debater calls meeting_read_index and meeting_read_entry on the current meetingDir to read the complete debate history before writing.",
    "- NEVER summarize or truncate the debate record for a debater — they read it from the blackboard.",
    '- If the user provides feedback in chat, APPEND it to the blackboard as `speaker: "User", phase: "Feedback"`, then continue the cycle.',
    "",
    "### Running a cycle",
    "Debate is a CHAIN: each debater must see all prior entries before writing.",
    "1. `meeting_run_cycle({ meetingDir: \"<current meetingDir>\", cycle: 1, agentName: \"<agentName>\" })` — runs ONE debater and waits for it.",
    "2. Run it once per debater, in order, to complete cycle 1.",
    "3. `meeting_read_index({ meetingDir })` to confirm every entry landed before judging convergence.",
    "",
    ...failureHandlingSection("cycle", "debater"),
    "## Rules",
    "- NEVER stop at a predetermined count. Only convergence or user intervention ends this debate.",
    "- Respond in the language the user uses; default to English.",
    "- After convergence, save `transcript.md` immediately and, after the user confirms, `conclusion.md`.",
    "- Present: (1) the debate arc, (2) who conceded what, (3) final synthesis.",
  ].join("\n");
}

/**
 * Build the facilitator prompt for /brainstorm-lab (v2).
 */
function buildBrainstormLabPrompt(
  topic: string,
  absDir: string,
  config: BrainstormConfig,
  participants: ParticipantConfig[]
): string {
  const consultantLines = participants
    .map(
      (p) =>
        `- **${p.displayName}** (${p.agentName}) [${p.model ?? "inherit main model"}]: ${
          p.brainstormRole || p.roleTitle || "Consultant"
        } — run with meeting_run_round.`
    )
    .join("\n");

  return [
    `🧪 BLACKBOARD BRAINSTORM LAB (v2): ${topic}`,
    "",
    `Initial meeting folder: \`${absDir}\``,
    "",
    "You are facilitating a v2 lab brainstorming session with ARTIFACT TRACKING, EDGE GRAPH, and STATE MANAGEMENT.",
    "Each consultant writes their FULL contribution to disk via meeting_append_entry.",
    "",
    "## Consultants (3 rounds)",
    consultantLines,
    "",
    ...buildNativeRunnerGuide(config, participants, "lab"),
    "",
    "## PRE-ROUND STEP — Assign a Human-Readable Title",
    "",
    `Before Round 1, choose a concise human-readable meeting title for "${topic}" and call:`,
    `  meeting_rename({ meetingDir: "${absDir}", title: "<your concise title>" })`,
    "",
    "Use the returned `newMeetingDir` for ALL subsequent meeting tools. If rename fails, continue with the original meetingDir.",
    "After renaming, replace every `<MEETING_DIR>` placeholder in the task template with the current meeting directory.",
    "",
    "## V2 LAB TOOLS (you, the facilitator, only — NOT the participants)",
    "",
    "You have these new tools for the artifact/graph/state system:",
    "",
    "- **meeting_append_artifact**: Extract structured artifacts (Claim, Question, Risk, Evidence, Decision, Action) from entries. REQUIRES sourceEntryId + sourceQuote.",
    "- **meeting_append_edge**: Define relationships between artifacts (supports, opposes, duplicates, blocks, resolves, supersedes). Records creator, basis, status.",
    "- **meeting_read_artifacts**: Query artifacts by type, status, or source entry. Always returns source quotes.",
    "- **meeting_get_state**: Read current meeting state (phase, open questions, conflicts, decisions, actions, next step). Derived fields are always rebuilt from artifacts+edges.",
    "- **meeting_update_state**: Advance the meeting phase, round, and set the next step. Phase transitions are auto-logged as events. Phase is validated against allowed values.",
    "- **meeting_log_event**: Record important events (facilitator decisions, user feedback, errors, retries) for auditability.",
    "",
    "The participant execution guide above explains that children only get `meeting_append_entry`, `meeting_read_index`, and `meeting_read_entry`. Do the artifact/edge/state work yourself.",
    "",
    "## CRITICAL INSTRUCTIONS",
    "",
    "### Blackboard-first — the blackboard is the single source of truth",
    "",
    "You never paste participant text into a participant task. `meeting_run_round` tells each child to read prior entries from the blackboard itself.",
    "",
    "- Round 1: participants write initial analysis. There are no prior entries to read.",
    "- Round 2: children read Round 1 entries from the blackboard before responding.",
    "- Round 3: children read ALL prior round entries AND any User feedback entries.",
    '- User feedback: append to the blackboard first as `speaker: "User", phase: "Feedback after Round N"`.',
    "",
    "### Running a round",
    "1. `meeting_run_round({ meetingDir: \"<current meetingDir>\", round: 1 })` — runs every participant in parallel and returns one line per participant.",
    "2. Rounds 2 and 3 are the same call with a higher `round`.",
    "3. `meeting_read_index({ meetingDir })` to confirm what landed before extracting artifacts.",
    "",
    "### ARTIFACT EXTRACTION (after each round):",
    "",
    "After each round completes, YOU (the facilitator) MUST extract structured artifacts from every entry:",
    "",
    "1. Read each entry with meeting_read_entry.",
    '2. For each Claim found: call meeting_append_artifact with type: "claim", the claim content, sourceEntryId, sourceEntryPath, sourceQuote (verbatim), confidence (high/medium/low), and evidenceLevel (strong/moderate/weak/none).',
    '3. For each Question found: call meeting_append_artifact with type: "question", the question content, and raisedBy.',
    '4. For each Risk identified: call with type: "risk", severity, and likelihood.',
    '5. For each Evidence cited: call with type: "evidence", strength, and supports/opposes artifact IDs.',
    '6. For each Decision proposed: call with type: "decision", rationale, blockedBy, and dependsOn.',
    '7. For each Action item: call with type: "action", assignee, and priority.',
    "",
    "**Hard rules for artifacts:**",
    '- sourceQuote MUST be a non-empty verbatim quote from the source entry.',
    '- High-confidence claims with evidenceLevel="none" are auto-marked as evidenceDebt.',
    "- Decisions with non-empty blockedBy are auto-marked as non-consensus.",
    "",
    "### EDGE CREATION (after artifact extraction):",
    "",
    "After extracting artifacts, define relationships:",
    '- If artifact A supports B: meeting_append_edge with type: "supports"',
    '- If A opposes B: meeting_append_edge with type: "opposes"',
    '- If A blocks B: meeting_append_edge with type: "blocks"',
    '- If A resolves B: meeting_append_edge with type: "resolves"',
    "- Every edge must record creator, basis, and status.",
    "",
    "### STATE MANAGEMENT:",
    "",
    "- After each round, call meeting_update_state to advance the phase and round:",
    '  * After Round 1: phase="challenge", round=1, nextStep="Round 2 — challenge and refine"',
    '  * After Round 2: phase="evidence_check", round=2, nextStep="Round 3 — final synthesis"',
    '  * After Round 3: phase="converge", round=3, nextStep="Generate conclusion"',
    "- Include controllerReasoning explaining why this phase transition.",
    "- Call meeting_log_event for every facilitator decision and user feedback.",
    "",
    "### NOISE REDUCTION (CRITICAL):",
    "",
    "- **DO NOT echo every participant entry detail.** The entries are on the blackboard.",
    "- Default output: ONLY show structural summary (round structure, conflict changes, new questions, next step).",
    "- Put per-entry echo behind verbose/debug — only expand when the user asks.",
    "- Your output format after each round:",
    "  1. Round summary (what was discussed, key additions)",
    "  2. Conflict matrix (who disagreed with whom, on what)",
    "  3. New open questions",
    "  4. Accepted decisions (if any)",
    "  5. Next step recommendation",
    "- Keep it brief. The blackboard has the full detail.",
    "",
    "### CONTEXT PACK (before Round 2 and 3):",
    "",
    "Before launching Round 2 or Round 3, generate a CONTEXT PACK from the current state:",
    "- Call meeting_get_state to get current openQuestions, activeConflicts, acceptedDecisions.",
    "- Call meeting_read_artifacts to get relevant artifacts with source quotes.",
    "- Pass that pack to the round through `mission`: `meeting_run_round({ meetingDir, round: 2, mission: \"<context pack summary + the challenge instruction>\" })`.",
    "- The pack is a navigation aid, not a replacement: every child still reads the blackboard itself.",
    "",
    "### HARD RULES FOR FINAL CONCLUSION:",
    "",
    "1. Every assertion in conclusion must reference an artifact ID, entry ID, AND source quote.",
    '2. High-confidence claims with evidenceLevel="none" → downgrade in conclusion, mark as evidence debt.',
    "3. A decision blocked by unresolved risks/conflicts must NOT be written as consensus.",
    "4. Every edge in the conclusion trail must have creator, basis, and status documented.",
    "5. User feedback must be logged as an event, reflected in state, and may create new artifacts.",
    "",
    "## Protocol (same as legacy /brainstorm)",
    "",
    "Round 1: Each consultant gives initial analysis. Run in parallel.",
    "Stop after Round 1. Present your structural overview, then ASK for user feedback or permission to continue.",
    "Round 2: only after user replies. Run meeting_run_round({ round: 2 }) — children read Round 1 entries plus your context-pack mission, then challenge others and improve.",
    "Stop after Round 2. Present updated overview, then ASK for permission.",
    "Round 3: only after user replies. Run meeting_run_round({ round: 3 }) — children read ALL entries and each gives a FINAL recommendation, synthesizing the best ideas.",
    "",
    "After Round 3, present the complete structural overview and ask whether to write the final conclusion. Only write conclusion.md after the user confirms.",
    "",
    ...failureHandlingSection("round", "consultant"),
    "## IMPORTANT",
    "- Respond in the language the user uses; default to English.",
    "- Save `transcript.md` and, after the user confirms, `conclusion.md`.",
    "- The user can intervene at any time to steer the discussion.",
    "- Legacy /brainstorm and /debate remain available as escape hatches.",
  ].join("\n");
}

// ────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────

/** Sanitize a string for use in filenames (keep letters, digits, hyphens, underscores). */
function sanitizeFilenamePart(raw: string): string {
  return (
    raw
      .replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 60)
      .toLowerCase() || "unknown"
  );
}

/** Format today's date as YYYY-MM-DD. */
function todayStr(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Validate that meetingDir is a subdirectory of cwd/.pi-meetings. Returns the resolved absolute path. */
function validateMeetingDir(meetingDir: string, cwd: string): string {
  const resolved = path.resolve(cwd, meetingDir);
  const meetingsRoot = path.resolve(cwd, ".pi-meetings");
  if (!fs.existsSync(meetingsRoot)) {
    fs.mkdirSync(meetingsRoot, { recursive: true });
  }
  assertDirectoryNoSymlink(meetingsRoot, "meetings root");
  assertPathInside(meetingsRoot, resolved, "meetingDir");
  const rootReal = fs.realpathSync(meetingsRoot);
  const targetReal = fs.existsSync(resolved)
    ? fs.realpathSync(resolved)
    : fs.realpathSync(path.dirname(resolved));
  assertPathInside(rootReal, targetReal, "meetingDir real path");
  return resolved;
}

function assertPathInside(baseDir: string, targetPath: string, label: string): void {
  const rel = path.relative(baseDir, targetPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`${label} must stay under ${baseDir}, got ${targetPath}`);
  }
}

function assertDirectoryNoSymlink(dirPath: string, label: string): void {
  const stat = fs.lstatSync(dirPath);
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link: ${dirPath}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} must be a directory: ${dirPath}`);
  }
}

function assertExistingFileNoSymlink(filePath: string, label: string): void {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`${label} must be a regular file: ${filePath}`);
  }
}

function assertWritableFilePath(filePath: string, baseDir: string, label: string): void {
  assertPathInside(baseDir, filePath, label);
  if (fs.existsSync(filePath)) {
    assertExistingFileNoSymlink(filePath, label);
    assertPathInside(fs.realpathSync(baseDir), fs.realpathSync(filePath), `${label} real path`);
  }
}

/** Parse entry filename like "0001-gpt-round-1.md" into parts. */
function parseEntryFilename(
  filename: string
): { id: string; speaker: string; phase: string } | null {
  const match = filename.match(/^(\d{4})-(.+)-(.+)\.md$/);
  if (!match) return null;
  return { id: match[1], speaker: match[2], phase: match[3] };
}

/** Read the first heading from an entry file to use as display summary. */
function readEntrySummary(absPath: string): string {
  try {
    const content = fs.readFileSync(absPath, "utf-8");
    const m = content.match(/^#\s*(.+)$/m);
    return m ? m[1].trim() : path.basename(absPath, ".md");
  } catch {
    return path.basename(absPath, ".md");
  }
}

/** Strip CR/LF/control chars, collapse whitespace, trim, max ~80 chars. */
function sanitizeHumanTitle(raw: string): string {
  return (
    raw
      .replace(/[\r\n\x00-\x1f\x7f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "Untitled meeting"
  );
}

/** Return current time as HHMMSS. */
function timeStr(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}${mm}${ss}`;
}

/** Generate initial meeting name for a kind. */
function initialMeetingName(kind: "brainstorm" | "debate"): string {
  return `${todayStr()}-${kind}-${timeStr()}`;
}

/**
 * Create a unique meeting directory under cwd/.pi-meetings/.
 * Tries baseName, then baseName-2 through baseName-50.
 * Returns the absolute directory and the actual meeting name used.
 */
async function createUniqueMeetingDir(
  cwd: string,
  baseName: string
): Promise<{ absDir: string; meetingName: string }> {
  // validateMeetingDir ensures root exists
  const candidates: string[] = [baseName];
  for (let suffix = 2; suffix <= 50; suffix++) {
    candidates.push(`${baseName}-${suffix}`);
  }

  for (const candidate of candidates) {
    const absDir = path.resolve(cwd, ".pi-meetings", candidate);
    // Validate resolves & ensures root
    validateMeetingDir(absDir, cwd);
    if (!fs.existsSync(absDir)) {
      await fsp.mkdir(absDir);
      assertDirectoryNoSymlink(absDir, "meeting directory");
      const entriesDir = path.join(absDir, "entries");
      await fsp.mkdir(entriesDir);
      assertDirectoryNoSymlink(entriesDir, "entries directory");
      return { absDir, meetingName: candidate };
    }
  }

  throw new Error(
    `Could not create unique meeting directory under .pi-meetings/ for base name "${baseName}". Tried up to ${baseName}-50.`
  );
}


/**
 * Seed the lab-specific files for a brainstorm-lab meeting.
 */
async function seedLabMeeting(
  absDir: string,
  topic: string,
  participants: ParticipantConfig[]
): Promise<void> {
  const now = new Date().toISOString();

  // artifacts.jsonl
  const artifactsPath = path.join(absDir, "artifacts.jsonl");
  assertWritableFilePath(artifactsPath, absDir, "meeting artifacts");
  await fsp.writeFile(artifactsPath, "", "utf-8");

  // edges.jsonl
  const edgesPath = path.join(absDir, "edges.jsonl");
  assertWritableFilePath(edgesPath, absDir, "meeting edges");
  await fsp.writeFile(edgesPath, "", "utf-8");

  // events.jsonl — seed with creation event
  const eventsPath = path.join(absDir, "events.jsonl");
  assertWritableFilePath(eventsPath, absDir, "meeting events");
  const initEvent: MeetingEvent = {
    id: "evt-001",
    type: "state_transition",
    timestamp: now,
    agent: "System",
    summary: "Lab meeting created",
    details: { topic, initialPhase: "briefing" },
  };
  await fsp.writeFile(eventsPath, JSON.stringify(initEvent) + "\n", "utf-8");

  // state.json
  const statePath = path.join(absDir, "state.json");
  assertWritableFilePath(statePath, absDir, "meeting state");
  const initialState: MeetingState = {
    meetingDir: absDir,
    topic,
    phase: "briefing",
    round: 0,
    participants: participants.map((p) => p.displayName),
    openQuestions: [],
    activeConflicts: [],
    acceptedDecisions: [],
    pendingActions: [],
    nextStep: "Rename the meeting, then proceed to Round 1",
    lastUpdated: now,
  };
  await fsp.writeFile(statePath, JSON.stringify(initialState, null, 2), "utf-8");
}

/** Check whether a meeting already has entries. */
async function meetingHasEntries(absDir: string): Promise<boolean> {
  const manifest = await readManifest(absDir);
  if (manifest && manifest.entryCount > 0) return true;

  const count = await getEntryCount(absDir);
  if (count > 0) return true;

  const entriesDir = path.join(absDir, "entries");
  if (fs.existsSync(entriesDir)) {
    try {
      const files = await fsp.readdir(entriesDir);
      if (files.some((f) => f.endsWith(".md"))) return true;
    } catch {
      // ignore
    }
  }

  return false;
}

/** Replace the first markdown heading in blackboard.md, preserving session prefix. */
function replaceBlackboardHeading(absDir: string, title: string): void {
  const blackboardPath = path.join(absDir, "blackboard.md");
  assertWritableFilePath(blackboardPath, absDir, "meeting blackboard");

  let content = fs.readFileSync(blackboardPath, "utf-8");
  content = content.replace(
    /^# (Meeting|Debate|Lab): .*$/m,
    `# $1: ${title}`
  );
  fs.writeFileSync(blackboardPath, content, "utf-8");
}

/** Update state.json.meetingDir after a meeting rename. */
async function updateStateMeetingDir(absDir: string, newMeetingDir: string): Promise<void> {
  const statePath = path.join(absDir, "state.json");
  try {
    assertWritableFilePath(statePath, absDir, "meeting state");
    const raw = await fsp.readFile(statePath, "utf-8");
    const state: MeetingState = JSON.parse(raw);
    state.meetingDir = newMeetingDir;
    state.lastUpdated = new Date().toISOString();
    await fsp.writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");
  } catch {
    // state.json may not exist for legacy meetings — that's fine
  }
}

/**
 * Move all direct children from oldAbsDir into a newly-created targetAbsDir,
 * then remove oldAbsDir. Rejects if target already exists. Rejects symlinks
 * among old dir's direct children.
 */
async function moveMeetingDirectoryNoOverwrite(
  oldAbsDir: string,
  targetAbsDir: string
): Promise<void> {
  if (fs.existsSync(targetAbsDir)) {
    throw new Error(`Target directory already exists: ${targetAbsDir}`);
  }

  const children = await fsp.readdir(oldAbsDir, { withFileTypes: true });
  for (const child of children) {
    if (child.isSymbolicLink()) {
      throw new Error(
        `Symlink detected in meeting directory: ${path.join(oldAbsDir, child.name)}`
      );
    }
  }

  await fsp.mkdir(targetAbsDir);
  assertDirectoryNoSymlink(targetAbsDir, "target meeting directory");

  for (const child of children) {
    await fsp.rename(
      path.join(oldAbsDir, child.name),
      path.join(targetAbsDir, child.name)
    );
  }

  await fsp.rmdir(oldAbsDir);
}

// ────────────────────────────────────────────────────────
// Watcher management
// ────────────────────────────────────────────────────────

/** Active watchers: meetingDir (absolute) → { watcher, debounce timers } */
const activeWatchers = new Map<
  string,
  { watcher: fs.FSWatcher; debounceTimers: Map<string, NodeJS.Timeout> }
>();

function startWatching(pi: ExtensionAPI, meetingDir: string): void {
  const absDir = meetingDir;
  const entriesDir = path.join(absDir, "entries");

  // Ensure entries directory exists
  fs.mkdirSync(entriesDir, { recursive: true });
  assertDirectoryNoSymlink(absDir, "meeting directory");
  assertDirectoryNoSymlink(entriesDir, "entries directory");

  // Stop any existing watcher for this meeting
  stopWatching(absDir);

  const debounceTimers = new Map<string, NodeJS.Timeout>();

  const watcher = fs.watch(entriesDir, (_eventType, filename) => {
    if (!filename || !filename.endsWith(".md")) return;

    // Debounce: wait 300ms before processing to let the file be fully written
    const existing = debounceTimers.get(filename);
    if (existing) clearTimeout(existing);

    debounceTimers.set(
      filename,
      setTimeout(() => {
        debounceTimers.delete(filename);
        const entryPath = path.join(entriesDir, filename);
        try {
          if (!fs.existsSync(entryPath)) return;
          assertExistingFileNoSymlink(entryPath, "meeting entry");
          assertPathInside(
            fs.realpathSync(entriesDir),
            fs.realpathSync(entryPath),
            "meeting entry real path"
          );
          const parsed = parseEntryFilename(filename);
          if (!parsed) return;
          const summary = readEntrySummary(entryPath);

          pi.sendMessage(
            {
              customType: "meeting-entry",
              content: `${parsed.speaker} · ${parsed.phase}`,
              display: true,
              details: {
                path: entryPath,
                speaker: parsed.speaker,
                phase: parsed.phase,
                summary,
                meetingDir: absDir,
              },
            },
            { deliverAs: "steer" }
          );
        } catch {
          // Silently ignore watcher errors
        }
      }, 300)
    );
  });

  (watcher as any).on?.("error", () => {
    // Silently handle watcher errors (e.g., directory deleted)
  });

  activeWatchers.set(absDir, { watcher, debounceTimers });
}

function stopWatching(meetingDir: string): void {
  const entry = activeWatchers.get(meetingDir);
  if (!entry) return;
  for (const timer of entry.debounceTimers.values()) {
    clearTimeout(timer);
  }
  try {
    entry.watcher.close();
  } catch {
    // Ignore close errors
  }
  activeWatchers.delete(meetingDir);
}

// ────────────────────────────────────────────────────────
// Manifest helpers
// ────────────────────────────────────────────────────────

interface MeetingManifest {
  topic: string;
  title?: string;
  created: string;
  lastUpdate: string;
  entryCount: number;
}

async function readManifest(absDir: string): Promise<MeetingManifest | null> {
  const manifestPath = path.join(absDir, "manifest.json");
  try {
    assertWritableFilePath(manifestPath, absDir, "manifest");
    const raw = await fsp.readFile(manifestPath, "utf-8");
    return JSON.parse(raw) as MeetingManifest;
  } catch {
    return null;
  }
}

async function writeManifest(
  absDir: string,
  manifest: MeetingManifest
): Promise<void> {
  const manifestPath = path.join(absDir, "manifest.json");
  assertWritableFilePath(manifestPath, absDir, "manifest");
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
}

async function getEntryCount(absDir: string): Promise<number> {
  const indexJsonlPath = path.join(absDir, "index.jsonl");
  try {
    assertWritableFilePath(indexJsonlPath, absDir, "meeting index");
    const raw = await fsp.readFile(indexJsonlPath, "utf-8");
    if (!raw.trim()) return 0;
    return raw.split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

// ────────────────────────────────────────────────────────
// Session start (shared by all commands)
// ────────────────────────────────────────────────────────

type SessionKind = "brainstorm" | "debate" | "lab";

interface SessionFile {
  topic: string;
  participants: string[];
}

/** Strip a single pair of surrounding quotes from a CLI argument. */
function cleanArg(raw: string): string {
  let s = raw.trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1);
  }
  return s.trim();
}

/**
 * Load a session file (YAML) containing a topic and a list of participant
 * agent names. The path is resolved relative to cwd (absolute allowed).
 */
function loadSessionFile(cwd: string, fileArg: string): SessionFile {
  const resolved = path.resolve(cwd, fileArg);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Session file not found: ${resolved}`);
  }
  assertExistingFileNoSymlink(resolved, "session file");

  let parsed: any;
  try {
    parsed = YAML.parse(fs.readFileSync(resolved, "utf-8"));
  } catch (err: any) {
    throw new Error(`Failed to parse ${resolved}: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Session file ${resolved} must be a YAML mapping.`);
  }

  const topic = parsed.topic;
  if (typeof topic !== "string" || !topic.trim()) {
    throw new Error(
      `Session file ${resolved} must define a non-empty "topic".`
    );
  }

  const list = parsed.participants;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(
      `Session file ${resolved} must define a non-empty ` +
        `"participants" array.`
    );
  }

  const names: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(
        `Session file ${resolved} participant at index ${i} ` +
          `must be a non-empty string.`
      );
    }
    names.push(item.trim());
  }

  return { topic: topic.trim(), participants: names };
}

/**
 * Select the configured participants matching the given agent names,
 * preserving the order in which they were listed. Throws if any name is
 * unknown, so typos fail loudly instead of silently dropping a participant.
 */
function selectParticipants(
  all: ParticipantConfig[],
  agentNames: string[]
): ParticipantConfig[] {
  const byName = new Map(all.map((p) => [p.agentName, p]));
  const selected: ParticipantConfig[] = [];
  const seen = new Set<string>();
  const missing: string[] = [];

  for (const name of agentNames) {
    if (seen.has(name)) continue;
    seen.add(name);
    const match = byName.get(name);
    if (match) {
      selected.push(match);
    } else {
      missing.push(name);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Unknown participant agent name(s): ${missing.join(", ")}. ` +
        `Available: ${all.map((p) => p.agentName).join(", ")}`
    );
  }
  return selected;
}

/**
 * Resolve configured participants (optionally filtered to a subset), verify
 * the attached extension exists, and return the ready list plus config.
 * Notifies the user and returns null on any error.
 */
async function prepareParticipants(
  ctx: any,
  selector?: string[]
): Promise<{ participants: ParticipantConfig[]; config: BrainstormConfig } | null> {
  let config: BrainstormConfig;
  let all: ParticipantConfig[];
  try {
    config = loadConfig(ctx.cwd);
    all = validateParticipants(config.participants, "participants");
  } catch (err: any) {
    ctx.ui.notify(`pi-brainstorm config error: ${err.message}`, "error");
    return null;
  }

  let participants = all;
  if (selector) {
    try {
      participants = selectParticipants(all, selector);
    } catch (err: any) {
      ctx.ui.notify(`pi-brainstorm session error: ${err.message}`, "error");
      return null;
    }
  }

  const extPath = extensionAttachmentPath(config);
  if (!fs.existsSync(extPath)) {
    ctx.ui.notify(
      `pi-brainstorm cannot find its extension to attach to participants: ${extPath}`,
      "error"
    );
    return null;
  }

  if (config.ignoredTombstones?.length) {
    ctx.ui.notify(
      `pi-brainstorm: ${config.ignoredTombstones.length} participant(s) disabled by config: ${config.ignoredTombstones.join(", ")}`,
      "info"
    );
  }

  return { participants, config };
}

/**
 * Create the meeting folder, seed its files, start the watcher, and hand
 * the orchestration prompt to the main agent.
 */
async function startSession(
  pi: ExtensionAPI,
  ctx: any,
  kind: SessionKind,
  topic: string,
  participants: ParticipantConfig[],
  config: BrainstormConfig
): Promise<void> {
  // Lab sessions reuse the brainstorm folder-name prefix.
  const folderKind: "brainstorm" | "debate" =
    kind === "debate" ? "debate" : "brainstorm";

  let absDir: string;
  let meetingName: string;
  try {
    ({ absDir, meetingName } = await createUniqueMeetingDir(
      ctx.cwd,
      initialMeetingName(folderKind)
    ));
  } catch (err: any) {
    ctx.ui.notify(`Failed to create meeting folder: ${err.message}`, "error");
    return;
  }

  assertDirectoryNoSymlink(absDir, "meeting directory");
  assertDirectoryNoSymlink(path.join(absDir, "entries"), "entries directory");

  // Kind-specific seeding.
  let blackboardHeader: string[];
  let notifyText: string;
  let promptText: string;

  if (kind === "lab") {
    const viewsDir = path.join(absDir, "views");
    await fsp.mkdir(viewsDir, { recursive: true });
    assertDirectoryNoSymlink(viewsDir, "views directory");
    await seedLabMeeting(absDir, topic, participants);

    blackboardHeader = [
      `# Lab: ${topic}`,
      `> Mode: brainstorm-lab v2`,
      `> Created: ${new Date().toISOString()}`,
      `> Artifact tracking: enabled`,
      `> Edges: enabled`,
      `> State management: events + state.json`,
      "",
      "---",
      "",
    ];
    notifyText =
      `🧪 Brainstorm Lab: ${meetingName}\n` +
      `  Folder: .pi-meetings/${meetingName}\n` +
      `  Artifact tracking + edges + state management active`;
    promptText = buildBrainstormLabPrompt(topic, absDir, config, participants);
  } else {
    const isBrainstorm = kind === "brainstorm";
    blackboardHeader = [
      `# ${isBrainstorm ? "Meeting" : "Debate"}: ${topic}`,
      `> Created: ${new Date().toISOString()}`,
      `> Type: ${
        isBrainstorm
          ? "Brainstorming (3 rounds)"
          : "Open-ended debate (until convergence)"
      }`,
      "",
      "---",
      "",
    ];
    notifyText =
      `${
        isBrainstorm ? "🧠 Multi-agent brainstorm" : "⚔️ Multi-agent debate"
      }: ${meetingName}\n` +
      `  Folder: .pi-meetings/${meetingName}/\n` +
      `  Watcher active — entries will appear as cards` +
      (isBrainstorm
        ? ""
        : "\n  Open-ended — runs until convergence or you intervene");
    promptText = isBrainstorm
      ? buildBrainstormPrompt(topic, absDir, config, participants)
      : buildDebatePrompt(topic, absDir, config, participants);
  }

  // Seed manifest
  const manifest: MeetingManifest = {
    topic,
    created: new Date().toISOString(),
    lastUpdate: new Date().toISOString(),
    entryCount: 0,
  };
  await writeManifest(absDir, manifest);

  // Seed index.jsonl (empty)
  const indexJsonlPath = path.join(absDir, "index.jsonl");
  assertWritableFilePath(indexJsonlPath, absDir, "meeting index");
  if (!fs.existsSync(indexJsonlPath)) {
    await fsp.writeFile(indexJsonlPath, "", "utf-8");
  }

  // Seed blackboard.md header
  const blackboardPath = path.join(absDir, "blackboard.md");
  assertWritableFilePath(blackboardPath, absDir, "meeting blackboard");
  await fsp.writeFile(blackboardPath, blackboardHeader.join("\n"), "utf-8");

  // Start watcher
  startWatching(pi, absDir);

  // Remember the roster so the run tools know who the participants are
  activeSessions.set(absDir, { kind, topic, participants, config });

  ctx.ui.notify(notifyText, "info");

  // Send orchestration prompt to main agent
  pi.sendUserMessage([
    {
      type: "text" as const,
      text: promptText,
    },
  ]);
}

/**
 * Shared handler for the *-from-file commands: load the session file,
 * select the named participants, and start the requested session kind.
 */
async function runFromFile(
  pi: ExtensionAPI,
  ctx: any,
  kind: SessionKind,
  args: string | undefined,
  usage: string
): Promise<void> {
  const fileArg = cleanArg(args ?? "");
  if (!fileArg) {
    ctx.ui.notify(usage, "warning");
    return;
  }

  let session: SessionFile;
  try {
    session = loadSessionFile(ctx.cwd, fileArg);
  } catch (err: any) {
    ctx.ui.notify(`pi-brainstorm session error: ${err.message}`, "error");
    return;
  }

  const prepared = await prepareParticipants(ctx, session.participants);
  if (!prepared) return;

  await startSession(
    pi,
    ctx,
    kind,
    session.topic,
    prepared.participants,
    prepared.config
  );
}

// ────────────────────────────────────────────────────────
// Main Extension
// ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Tool: meeting_rename ─────────────────────────────

  pi.registerTool({
    name: "meeting_rename",
    label: "Meeting Rename",
    description:
      "Rename a meeting directory to a human-readable title. Facilitator-only. " +
      "Only works when the meeting has no entries yet (before Round 1 starts).",
    promptSnippet:
      "meeting_rename({ meetingDir, title }) — rename meeting to human-readable title",
    parameters: Type.Object({
      meetingDir: Type.String({
        description: "Absolute path to the current meeting directory",
      }),
      title: Type.String({
        description: "Human-readable meeting title (max ~80 chars)",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const oldAbsDir = validateMeetingDir(params.meetingDir, cwd);

      const manifestPath = path.join(oldAbsDir, "manifest.json");
      assertWritableFilePath(manifestPath, oldAbsDir, "manifest");

      return withFileMutationQueue(manifestPath, async () => {
        // Reject if meeting already has entries
        const hasEntries = await meetingHasEntries(oldAbsDir);
        if (hasEntries) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Cannot rename meeting: entries already exist. meeting_rename only works on empty meetings (before Round 1 starts).",
              },
            ],
            details: {},
            isError: true,
          };
        }

        // Sanitize title
        const sanitizedTitle = sanitizeHumanTitle(params.title);

        // Derive date prefix from old basename
        const oldBase = path.basename(oldAbsDir);
        const dateMatch = oldBase.match(/^\d{4}-\d{2}-\d{2}/);
        const datePrefix = dateMatch ? dateMatch[0] : todayStr();

        // Build target base name
        const titleSlug = sanitizeFilenamePart(sanitizedTitle).slice(0, 40);
        const baseTarget = `${datePrefix}-${titleSlug}`;

        // Find a non-existing suffix
        let targetMeetingName = baseTarget;
        let targetAbsDir = path.resolve(cwd, ".pi-meetings", targetMeetingName);

        if (fs.existsSync(targetAbsDir)) {
          let found = false;
          for (let suffix = 2; suffix <= 50; suffix++) {
            const candidate = `${baseTarget}-${suffix}`;
            const candidateAbsDir = path.resolve(cwd, ".pi-meetings", candidate);
            if (!fs.existsSync(candidateAbsDir)) {
              targetMeetingName = candidate;
              targetAbsDir = candidateAbsDir;
              found = true;
              break;
            }
          }
          if (!found) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Cannot rename meeting: no available target name under .pi-meetings/. Tried ${baseTarget} through ${baseTarget}-50.`,
                },
              ],
              details: {},
              isError: true,
            };
          }
        }

        // Validate target
        validateMeetingDir(targetAbsDir, cwd);

        // Stop watching old dir
        stopWatching(oldAbsDir);

        try {
          await moveMeetingDirectoryNoOverwrite(oldAbsDir, targetAbsDir);
        } catch (err: any) {
          // Restart watcher on old dir on failure
          startWatching(pi, oldAbsDir);
          throw err;
        }

        try {
          // Update manifest with new title
          const manifest = await readManifest(targetAbsDir);
          if (manifest) {
            manifest.title = sanitizedTitle;
            manifest.lastUpdate = new Date().toISOString();
            await writeManifest(targetAbsDir, manifest);
          }

          // Replace blackboard heading
          replaceBlackboardHeading(targetAbsDir, sanitizedTitle);
          // Update state.json.meetingDir for lab meetings
          await updateStateMeetingDir(targetAbsDir, targetAbsDir);
        } catch (err) {
          startWatching(pi, targetAbsDir);
          throw err;
        }

        // Start watching new dir
        startWatching(pi, targetAbsDir);

        // Re-key the session roster under the new directory
        const movedSession = activeSessions.get(oldAbsDir);
        if (movedSession) {
          activeSessions.delete(oldAbsDir);
          activeSessions.set(targetAbsDir, movedSession);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Meeting renamed. New meetingDir: ${targetAbsDir}`,
            },
          ],
          details: {
            oldMeetingDir: oldAbsDir,
            newMeetingDir: targetAbsDir,
            title: sanitizedTitle,
          },
        };
      });
    },
  });

  // ── Tool: meeting_append_entry ─────────────────────────

  pi.registerTool({
    name: "meeting_append_entry",
    label: "Meeting Append Entry",
    description:
      "Append a contribution to a meeting blackboard. Write your FULL brainstorm/debate response to disk. " +
      "This is append-only and concurrency-safe. After writing, reply ONLY with WROTE_ENTRY plus a one-sentence summary — do NOT paste the full content into chat.",
    promptSnippet:
      "meeting_append_entry({ meetingDir, speaker, phase, title?, summary, content }) — write full contribution to meeting blackboard",
    promptGuidelines: [
      "Use meeting_append_entry to write your FULL brainstorm/debate contribution to disk. Then reply ONLY with 'WROTE_ENTRY: <one-sentence summary>' — do NOT repeat the full content in chat.",
    ],
    parameters: Type.Object({
      meetingDir: Type.String({
        description:
          "Absolute path to the meeting directory (e.g., /path/to/.pi-meetings/2026-06-28-my-topic)",
      }),
      speaker: Type.String({
        description: "Speaker identifier (e.g., GPT-Progressive, GPT-Localist, GPT-Critic)",
      }),
      phase: Type.String({
        description: "Meeting phase (e.g., Round 1, Round 2, Final)",
      }),
      title: Type.Optional(
        Type.String({
          description: "Optional title for this entry",
        })
      ),
      summary: Type.String({
        description:
          "One-sentence summary of this contribution (shown in meeting index)",
      }),
      content: Type.String({
        description:
          "FULL contribution content in Markdown. This is the complete text that will be stored on disk.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const absDir = validateMeetingDir(params.meetingDir, cwd);

      // Sanitize filename parts
      const speakerSlug = sanitizeFilenamePart(params.speaker);
      const phaseSlug = sanitizeFilenamePart(params.phase);

      // Use withFileMutationQueue on the manifest to serialize writes for this meeting
      assertDirectoryNoSymlink(absDir, "meeting directory");
      const manifestPath = path.join(absDir, "manifest.json");
      assertWritableFilePath(manifestPath, absDir, "manifest");

      return withFileMutationQueue(manifestPath, async () => {
        // Ensure directories exist
        const entriesDir = path.join(absDir, "entries");
        await fsp.mkdir(entriesDir, { recursive: true });
        assertDirectoryNoSymlink(entriesDir, "entries directory");

        // Read or create manifest
        let manifest = await readManifest(absDir);
        if (!manifest) {
          manifest = {
            topic: path.basename(absDir),
            created: new Date().toISOString(),
            lastUpdate: new Date().toISOString(),
            entryCount: 0,
          };
          await writeManifest(absDir, manifest);
        }

        // Determine entry number from existing index
        const currentCount = await getEntryCount(absDir);
        const entryId = String(currentCount + 1).padStart(4, "0");
        const entryFilename = `${entryId}-${speakerSlug}-${phaseSlug}.md`;
        const entryRelPath = path.join("entries", entryFilename);
        const entryAbsPath = path.join(absDir, entryRelPath);
        assertWritableFilePath(entryAbsPath, absDir, "meeting entry");

        // Format the entry file content
        const heading = params.title
          ? `# ${params.speaker} (${params.phase}): ${params.title}\n\n`
          : `# ${params.speaker} (${params.phase}): ${params.summary}\n\n`;
        const entryContent = heading + params.content;

        // Write entry file. wx prevents overwriting pre-existing files or symlinks.
        await fsp.writeFile(entryAbsPath, entryContent, {
          encoding: "utf-8",
          flag: "wx",
        });

        // Append to index.jsonl
        const indexEntry = {
          id: entryId,
          speaker: params.speaker,
          phase: params.phase,
          title: params.title ?? null,
          summary: params.summary,
          path: entryRelPath,
          timestamp: new Date().toISOString(),
        };
        const indexJsonlPath = path.join(absDir, "index.jsonl");
        assertWritableFilePath(indexJsonlPath, absDir, "meeting index");
        await fsp.appendFile(
          indexJsonlPath,
          JSON.stringify(indexEntry) + "\n",
          "utf-8"
        );

        // Append to blackboard.md
        const blackboardPath = path.join(absDir, "blackboard.md");
        assertWritableFilePath(blackboardPath, absDir, "meeting blackboard");
        const blackboardEntry = [
          "",
          `## ${params.speaker} (${params.phase}): ${params.title ?? params.summary}`,
          "",
          params.content,
          "",
          "---",
          "",
        ].join("\n");
        await fsp.appendFile(blackboardPath, blackboardEntry, "utf-8");

        // Update manifest
        manifest.lastUpdate = new Date().toISOString();
        manifest.entryCount = currentCount + 1;
        await writeManifest(absDir, manifest);

        // Return only short reference — NOT full content
        return {
          content: [
            {
              type: "text" as const,
              text: `Entry ${entryId} written: ${entryRelPath} — ${params.summary}`,
            },
          ],
          details: {
            id: entryId,
            path: entryRelPath,
            summary: params.summary,
          },
        };
      });
    },
  });

  // ── Tool: meeting_read_index ──────────────────────────

  pi.registerTool({
    name: "meeting_read_index",
    label: "Meeting Read Index",
    description:
      "Read the index of all entries in a meeting blackboard. Returns the list of entries with id, speaker, phase, title, summary, and path.",
    promptSnippet:
      "meeting_read_index({ meetingDir, limit? }) — list meeting entries",
    parameters: Type.Object({
      meetingDir: Type.String({
        description:
          "Absolute path to the meeting directory (e.g., /path/to/.pi-meetings/2026-06-28-my-topic)",
      }),
      limit: Type.Optional(
        Type.Number({
          description:
            "Maximum number of entries to return (most recent first). Omit for all.",
        })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const absDir = validateMeetingDir(params.meetingDir, ctx.cwd);
      const indexJsonlPath = path.join(absDir, "index.jsonl");

      try {
        assertWritableFilePath(indexJsonlPath, absDir, "meeting index");
        const raw = await fsp.readFile(indexJsonlPath, "utf-8");
        const lines = raw
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l));

        const result = params.limit
          ? lines.slice(-params.limit).reverse()
          : [...lines].reverse();

        return {
          content: [
            {
              type: "text" as const,
              text:
                `Meeting index (${result.length} of ${lines.length} entries):\n` +
                result
                  .map(
                    (e) =>
                      `  [${e.id}] ${e.speaker} · ${e.phase} — ${e.summary}`
                  )
                  .join("\n"),
            },
          ],
          details: { entries: result },
        };
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: "Meeting index is empty or does not exist yet.",
            },
          ],
          details: { entries: [] },
        };
      }
    },
  });

  // ── Tool: meeting_read_entry ──────────────────────────

  pi.registerTool({
    name: "meeting_read_entry",
    label: "Meeting Read Entry",
    description:
      "Read the full content of a specific entry from a meeting blackboard. Use this to get the complete text of a participant's contribution.",
    promptSnippet:
      "meeting_read_entry({ meetingDir, entryPath }) — read full entry content",
    parameters: Type.Object({
      meetingDir: Type.String({
        description:
          "Absolute path to the meeting directory (e.g., /path/to/.pi-meetings/2026-06-28-my-topic)",
      }),
      entryPath: Type.String({
        description:
          "Relative path to the entry file within the meeting (e.g., entries/0001-gpt-round-1.md)",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const absDir = validateMeetingDir(params.meetingDir, ctx.cwd);
      const absEntryPath = path.resolve(absDir, params.entryPath);

      // Validate that entryPath doesn't escape the meeting directory
      const rel = path.relative(absDir, absEntryPath);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Invalid entryPath: ${params.entryPath} escapes meeting directory.`,
            },
          ],
          details: {},
          isError: true,
        };
      }

      try {
        assertExistingFileNoSymlink(absEntryPath, "meeting entry");
        assertPathInside(
          fs.realpathSync(absDir),
          fs.realpathSync(absEntryPath),
          "meeting entry real path"
        );
        const content = await fsp.readFile(absEntryPath, "utf-8");
        return {
          content: [
            {
              type: "text" as const,
              text: `Entry: ${rel}\n\n${content}`,
            },
          ],
          details: { path: rel, content },
        };
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: `Entry not found: ${params.entryPath}`,
            },
          ],
          details: {},
          isError: true,
        };
      }
    },
  });


  // ── Tool: meeting_run_round ───────────────────────────

  pi.registerTool({
    name: "meeting_run_round",
    label: "Run Brainstorm Round",
    description:
      "Run one brainstorming round. Every participant runs as a headless Pi child process, in " +
      "parallel, reads prior entries from the blackboard itself, and writes its full contribution " +
      "with meeting_append_entry. Failures are retried inside this tool. Returns one line per " +
      "participant with state ok | failed | timeout | unavailable. Do NOT write participant content yourself.",
    parameters: Type.Object({
      meetingDir: Type.String({
        description: "Meeting directory (relative to cwd or absolute)",
      }),
      round: Type.Number({
        description: `Round number (1-${MAX_BRAINSTORM_ROUNDS})`,
      }),
      mission: Type.Optional(
        Type.String({
          description: "Override the default mission text for this round",
        })
      ),
      participants: Type.Optional(
        Type.Array(Type.String(), {
          description: "Optional subset of participant agentNames",
        })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const absDir = validateMeetingDir(params.meetingDir, ctx.cwd);

      const round = Math.floor(params.round);
      if (!Number.isFinite(params.round) || round < 1 || round > MAX_BRAINSTORM_ROUNDS) {
        return toolError(`round must be an integer from 1 to ${MAX_BRAINSTORM_ROUNDS}.`);
      }

      const prepared = await resolveSessionParticipants(ctx, absDir, params.participants);
      if (!prepared.ok) return toolError(prepared.error);

      const phase = `Round ${round}`;
      const mission =
        params.mission?.trim() ||
        defaultMission(
          "brainstorm",
          "round",
          round,
          prepared.topic,
          round === MAX_BRAINSTORM_ROUNDS
        );

      const outcomes = await runParticipantsParallel(
        prepared.participants,
        resolveMaxParallel(prepared.config),
        (participant) =>
          runParticipant({
            ctx,
            config: prepared.config,
            participant,
            mode: "brainstorm",
            absDir,
            topic: prepared.topic,
            phase,
            mission,
            priorContext: round <= 1 ? "none" : "read",
          })
      );

      return {
        content: [
          {
            type: "text" as const,
            text: formatOutcomes(outcomes, "round", round),
          },
        ],
        details: { round, phase, participants: outcomes },
      };
    },
  });

  // ── Tool: meeting_run_cycle ───────────────────────────

  pi.registerTool({
    name: "meeting_run_cycle",
    label: "Run Debate Turn",
    description:
      "Run ONE debater as a headless Pi child process and wait for it. Debate is a chain: call this " +
      "once per debater per cycle so each debater reads every prior entry from the blackboard before " +
      "writing. Failures are retried inside this tool. Do NOT write debater content yourself.",
    parameters: Type.Object({
      meetingDir: Type.String({
        description: "Meeting directory (relative to cwd or absolute)",
      }),
      cycle: Type.Number({
        description: "Cycle number (1 or higher)",
      }),
      agentName: Type.String({
        description: "agentName of the debater to run now",
      }),
      mission: Type.Optional(
        Type.String({
          description: "Override the default mission text for this turn",
        })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const absDir = validateMeetingDir(params.meetingDir, ctx.cwd);

      const cycle = Math.floor(params.cycle);
      if (!Number.isFinite(params.cycle) || cycle < 1) {
        return toolError("cycle must be an integer of 1 or higher.");
      }

      const prepared = await resolveSessionParticipants(ctx, absDir, [params.agentName]);
      if (!prepared.ok) return toolError(prepared.error);

      const phase = `Cycle ${cycle}`;
      const mission =
        params.mission?.trim() ||
        defaultMission("debate", "cycle", cycle, prepared.topic, false);
      const priorEntries = await readIndexEntries(absDir);
      const hasPriorEntries = priorEntries.length > 0;

      const outcomes = await runParticipantsParallel(
        prepared.participants,
        1,
        (participant) =>
          runParticipant({
            ctx,
            config: prepared.config,
            participant,
            mode: "debate",
            absDir,
            topic: prepared.topic,
            phase,
            mission,
            priorContext: hasPriorEntries ? "read" : "none",
          })
      );

      return {
        content: [
          {
            type: "text" as const,
            text: formatOutcomes(outcomes, "cycle", cycle),
          },
        ],
        details: { cycle, phase, participants: outcomes },
      };
    },
  });

  // ── Tool: meeting_append_artifact ─────────────────────

  pi.registerTool({
    name: "meeting_append_artifact",
    label: "Meeting Append Artifact",
    description:
      "Append a structured artifact (Claim, Question, Risk, Evidence, Decision, Action) " +
      "derived from a meeting entry. Every artifact MUST include sourceEntryId and sourceQuote. " +
      "High-confidence claims without evidence are marked as evidence debt.",
    promptSnippet:
      "meeting_append_artifact({ meetingDir, artifact: { type, content, sourceEntryId, sourceEntryPath, sourceQuote, ... } }) — extract structured artifact",
    parameters: Type.Object({
      meetingDir: Type.String({ description: "Absolute path to meeting directory" }),
      artifact: Type.Object({
        type: Type.String({ description: "claim | question | risk | evidence | decision | action" }),
        content: Type.String({ description: "The artifact body text" }),
        sourceEntryId: Type.String({ description: "Source entry ID, e.g. '0001'" }),
        sourceEntryPath: Type.String({ description: "Relative path to source entry, e.g. entries/0001-gpt-round_1.md" }),
        sourceQuote: Type.String({ description: "Verbatim quote from source entry" }),
        confidence: Type.Optional(Type.String({ description: "For claims: high | medium | low" })),
        evidenceLevel: Type.Optional(Type.String({ description: "strong | moderate | weak | none" })),
        severity: Type.Optional(Type.String({ description: "For risks: critical | high | medium | low" })),
        likelihood: Type.Optional(Type.String({ description: "For risks: certain | likely | possible | unlikely" })),
        strength: Type.Optional(Type.String({ description: "For evidence: strong | moderate | weak | none" })),
        rationale: Type.Optional(Type.String({ description: "For decisions: why this decision was made" })),
        raisedBy: Type.Optional(Type.String({ description: "For questions: who raised it (displayName)" })),
        blockedBy: Type.Optional(Type.Array(Type.String(), { description: "For decisions: artifact IDs that block this" })),
        dependsOn: Type.Optional(Type.Array(Type.String(), { description: "For decisions: artifact IDs this depends on" })),
        supports: Type.Optional(Type.Array(Type.String(), { description: "Artifact IDs this evidence supports" })),
        opposes: Type.Optional(Type.Array(Type.String(), { description: "Artifact IDs this evidence opposes" })),
        assignee: Type.Optional(Type.String({ description: "For actions: who is responsible" })),
        priority: Type.Optional(Type.String({ description: "For actions: must | should | could" })),
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const absDir = validateMeetingDir(params.meetingDir, ctx.cwd);

      // Reject if sourceQuote is empty
      if (!params.artifact.sourceQuote || !params.artifact.sourceQuote.trim()) {
        return {
          content: [{ type: "text" as const, text: "REJECTED: sourceQuote must be a non-empty verbatim quote from the source entry." }],
          details: {},
          isError: true,
        };
      }
      if (!params.artifact.sourceEntryId || !params.artifact.sourceEntryId.trim()) {
        return {
          content: [{ type: "text" as const, text: "REJECTED: sourceEntryId must be non-empty." }],
          details: {},
          isError: true,
        };
      }

      const manifestPath = path.join(absDir, "manifest.json");
      assertWritableFilePath(manifestPath, absDir, "manifest");

      return withFileMutationQueue(manifestPath, async () => {
        const artifactsPath = path.join(absDir, "artifacts.jsonl");
        assertWritableFilePath(artifactsPath, absDir, "meeting artifacts");

        // Determine next artifact ID
        let nextNum = 1;
        try {
          const raw = await fsp.readFile(artifactsPath, "utf-8");
          const fileLines = raw.split("\n").filter((l: string) => l.trim());
          nextNum = fileLines.length + 1;
        } catch {
          // File doesn't exist or is empty — start at 1
        }

        const artId = `${params.artifact.type}-${String(nextNum).padStart(3, "0")}`;
        const now = new Date().toISOString();

        const source: ArtifactSourceRef = {
          entryId: params.artifact.sourceEntryId,
          entryPath: params.artifact.sourceEntryPath,
          sourceQuote: params.artifact.sourceQuote,
        };

        let artifact: Artifact;

        switch (params.artifact.type) {
          case "claim": {
            const confidence = (params.artifact.confidence || "medium") as "high" | "medium" | "low";
            const evidenceLevel = (params.artifact.evidenceLevel || "none") as EvidenceLevel;
            const evidenceDebt = confidence === "high" && evidenceLevel === "none";
            artifact = {
              type: "claim",
              id: artId,
              timestamp: now,
              source,
              status: "active",
              content: params.artifact.content,
              confidence,
              evidenceLevel,
              evidenceDebt,
              acceptedBy: [],
              challengedBy: [],
            };
            break;
          }
          case "question": {
            artifact = {
              type: "question",
              id: artId,
              timestamp: now,
              source,
              status: "active",
              content: params.artifact.content,
              raisedBy: params.artifact.raisedBy || "Facilitator",
              addressedBy: [],
            };
            break;
          }
          case "risk": {
            artifact = {
              type: "risk",
              id: artId,
              timestamp: now,
              source,
              status: "active",
              content: params.artifact.content,
              severity: (params.artifact.severity || "medium") as "critical" | "high" | "medium" | "low",
              likelihood: (params.artifact.likelihood || "possible") as "certain" | "likely" | "possible" | "unlikely",
              mitigation: undefined,
            };
            break;
          }
          case "evidence": {
            artifact = {
              type: "evidence",
              id: artId,
              timestamp: now,
              source,
              status: "active",
              content: params.artifact.content,
              strength: (params.artifact.strength || "moderate") as EvidenceLevel,
              supports: params.artifact.supports || [],
              opposes: params.artifact.opposes || [],
            };
            break;
          }
          case "decision": {
            const blockedBy = params.artifact.blockedBy || [];
            artifact = {
              type: "decision",
              id: artId,
              timestamp: now,
              source,
              status: "active",
              content: params.artifact.content,
              rationale: params.artifact.rationale || "",
              blockedBy,
              dependsOn: params.artifact.dependsOn || [],
              consensus: blockedBy.length === 0,
            };
            break;
          }
          case "action": {
            artifact = {
              type: "action",
              id: artId,
              timestamp: now,
              source,
              status: "active",
              content: params.artifact.content,
              assignee: params.artifact.assignee || "Unassigned",
              priority: (params.artifact.priority || "should") as "must" | "should" | "could",
            };
            break;
          }
          default:
            return {
              content: [{ type: "text" as const, text: `Unknown artifact type: ${params.artifact.type}. Must be one of: claim, question, risk, evidence, decision, action.` }],
              details: {},
              isError: true,
            };
        }

        // Write artifact
        await fsp.appendFile(artifactsPath, JSON.stringify(artifact) + "\n", "utf-8");

        // Auto-generate edges from supports/opposes lists
        const edgesPath = path.join(absDir, "edges.jsonl");
        assertWritableFilePath(edgesPath, absDir, "meeting edges");

        const autoEdges: Edge[] = [];
        if ("supports" in artifact && (artifact as EvidenceArtifact).supports.length > 0) {
          for (const targetId of (artifact as EvidenceArtifact).supports) {
            autoEdges.push({
              id: "",
              from: artId,
              to: targetId,
              type: "supports",
              creator: "Facilitator",
              basis: `Evidence ${artId} supports ${targetId}`,
              status: "active",
              timestamp: now,
            });
          }
        }
        if ("opposes" in artifact && (artifact as EvidenceArtifact).opposes.length > 0) {
          for (const targetId of (artifact as EvidenceArtifact).opposes) {
            autoEdges.push({
              id: "",
              from: artId,
              to: targetId,
              type: "opposes",
              creator: "Facilitator",
              basis: `Evidence ${artId} opposes ${targetId}`,
              status: "active",
              timestamp: now,
            });
          }
        }

        for (const e of autoEdges) {
          let nextEdgeNum = 1;
          try {
            const raw = await fsp.readFile(edgesPath, "utf-8");
            nextEdgeNum = raw.split("\n").filter((l: string) => l.trim()).length + 1;
          } catch { /* empty */ }
          e.id = `edge-${String(nextEdgeNum).padStart(3, "0")}`;
          await fsp.appendFile(edgesPath, JSON.stringify(e) + "\n", "utf-8");
        }

        return {
          content: [{ type: "text" as const, text: `Artifact ${artId} (${artifact.type}) written — source: ${params.artifact.sourceEntryId}` }],
          details: { id: artId, type: artifact.type },
        };
      });
    },
  });

  // ── Tool: meeting_append_edge ─────────────────────────

  pi.registerTool({
    name: "meeting_append_edge",
    label: "Meeting Append Edge",
    description:
      "Create a relationship edge between two artifacts (supports, opposes, duplicates, blocks, resolves, supersedes). " +
      "Every edge records creator, basis, and status.",
    promptSnippet:
      "meeting_append_edge({ meetingDir, from, to, type, creator, basis }) — define artifact relationship",
    parameters: Type.Object({
      meetingDir: Type.String({ description: "Absolute path to meeting directory" }),
      from: Type.String({ description: "Source artifact ID" }),
      to: Type.String({ description: "Target artifact ID" }),
      type: Type.String({ description: "supports | opposes | duplicates | blocks | resolves | supersedes" }),
      creator: Type.String({ description: "Who is creating this edge (displayName or 'Facilitator')" }),
      basis: Type.String({ description: "Reasoning for this relationship" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const absDir = validateMeetingDir(params.meetingDir, ctx.cwd);
      const manifestPath = path.join(absDir, "manifest.json");
      assertWritableFilePath(manifestPath, absDir, "manifest");

      const validTypes: EdgeType[] = ["supports", "opposes", "duplicates", "blocks", "resolves", "supersedes"];
      if (!validTypes.includes(params.type as EdgeType)) {
        return {
          content: [{ type: "text" as const, text: `Invalid edge type: ${params.type}. Must be one of: ${validTypes.join(", ")}` }],
          details: {},
          isError: true,
        };
      }

      return withFileMutationQueue(manifestPath, async () => {
        const edgesPath = path.join(absDir, "edges.jsonl");
        assertWritableFilePath(edgesPath, absDir, "meeting edges");

        let nextNum = 1;
        try {
          const raw = await fsp.readFile(edgesPath, "utf-8");
          nextNum = raw.split("\n").filter((l: string) => l.trim()).length + 1;
        } catch { /* empty */ }

        const edgeId = `edge-${String(nextNum).padStart(3, "0")}`;
        const now = new Date().toISOString();

        const edge: Edge = {
          id: edgeId,
          from: params.from,
          to: params.to,
          type: params.type as EdgeType,
          creator: params.creator,
          basis: params.basis,
          status: "active",
          timestamp: now,
        };

        await fsp.appendFile(edgesPath, JSON.stringify(edge) + "\n", "utf-8");

        return {
          content: [{ type: "text" as const, text: `Edge ${edgeId} (${edge.type}) written: ${edge.from} → ${edge.to}` }],
          details: { id: edgeId, type: edge.type },
        };
      });
    },
  });

  // ── Tool: meeting_read_artifacts ──────────────────────

  pi.registerTool({
    name: "meeting_read_artifacts",
    label: "Meeting Read Artifacts",
    description:
      "Query artifacts from a lab meeting. Filter by type, status, or source entry. " +
      "Always returns sourceEntryId and sourceQuote alongside each artifact.",
    promptSnippet:
      "meeting_read_artifacts({ meetingDir, type?, status?, sourceEntryId?, limit? }) — query structured artifacts",
    parameters: Type.Object({
      meetingDir: Type.String({ description: "Absolute path to meeting directory" }),
      type: Type.Optional(Type.String({ description: "Filter: claim, question, risk, evidence, decision, action" })),
      status: Type.Optional(Type.String({ description: "Filter: active, resolved, superseded, invalidated" })),
      sourceEntryId: Type.Optional(Type.String({ description: "Filter by source entry ID" })),
      limit: Type.Optional(Type.Number({ description: "Max entries (default 50)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const absDir = validateMeetingDir(params.meetingDir, ctx.cwd);
      const artifactsPath = path.join(absDir, "artifacts.jsonl");

      let artifacts: Artifact[] = [];
      try {
        assertWritableFilePath(artifactsPath, absDir, "meeting artifacts");
        const raw = await fsp.readFile(artifactsPath, "utf-8");
        artifacts = raw
          .split("\n")
          .filter((l: string) => l.trim())
          .map((l: string) => JSON.parse(l) as Artifact);
      } catch {
        return {
          content: [{ type: "text" as const, text: "No artifacts recorded yet." }],
          details: { artifacts: [] },
        };
      }

      if (params.type) {
        artifacts = artifacts.filter((a: Artifact) => a.type === params.type);
      }
      if (params.status) {
        artifacts = artifacts.filter((a: Artifact) => a.status === params.status);
      }
      if (params.sourceEntryId) {
        artifacts = artifacts.filter((a: Artifact) => a.source.entryId === params.sourceEntryId);
      }

      artifacts.sort((a: Artifact, b: Artifact) => b.timestamp.localeCompare(a.timestamp));

      const limit = params.limit || 50;
      const sliced = artifacts.slice(0, limit);

      const summary = sliced
        .map((a: Artifact) => {
          const quote = a.source.sourceQuote.length > 80
            ? a.source.sourceQuote.slice(0, 80) + "..."
            : a.source.sourceQuote;
          const debt = (a.type === "claim" && (a as ClaimArtifact).evidenceDebt)
            ? " [EVIDENCE_DEBT]"
            : "";
          const blocked = (a.type === "decision" && !(a as DecisionArtifact).consensus)
            ? " [BLOCKED]"
            : "";
          return `  [${a.id}] ${a.type} (${a.status})${debt}${blocked} — src: ${a.source.entryId}\n    "${quote}"`;
        })
        .join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `Artifacts (${sliced.length} of ${artifacts.length}):\n${summary || "  (none matching)"}`,
          },
        ],
        details: { artifacts: sliced, total: artifacts.length },
      };
    },
  });

  // ── Tool: meeting_get_state ───────────────────────────

  pi.registerTool({
    name: "meeting_get_state",
    label: "Meeting Get State",
    description:
      "Read the current meeting state: phase, open questions, active conflicts, accepted decisions, pending actions, and next step. " +
      "Derived fields (openQuestions, activeConflicts, acceptedDecisions, pendingActions) are always rebuilt from artifacts and edges.",
    promptSnippet:
      "meeting_get_state({ meetingDir }) — read meeting state",
    parameters: Type.Object({
      meetingDir: Type.String({ description: "Absolute path to meeting directory" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const absDir = validateMeetingDir(params.meetingDir, ctx.cwd);
      const statePath = path.join(absDir, "state.json");

      // Load base state from state.json (phase, round, nextStep, controllerReasoning)
      let baseState: MeetingState;
      try {
        assertWritableFilePath(statePath, absDir, "meeting state");
        const raw = await fsp.readFile(statePath, "utf-8");
        baseState = JSON.parse(raw) as MeetingState;
      } catch {
        baseState = {
          meetingDir: absDir,
          topic: path.basename(absDir),
          phase: "briefing",
          round: 0,
          participants: [],
          openQuestions: [],
          activeConflicts: [],
          acceptedDecisions: [],
          pendingActions: [],
          nextStep: "State rebuilt from artifacts. Proceed with caution.",
          lastUpdated: new Date().toISOString(),
        };
      }

      // Always rebuild derived fields from artifacts + edges
      const artifactsPath = path.join(absDir, "artifacts.jsonl");
      const edgesPath = path.join(absDir, "edges.jsonl");
      const openQuestions: string[] = [];
      const activeConflicts: string[] = [];
      const acceptedDecisions: string[] = [];
      const pendingActions: string[] = [];

      try {
        assertWritableFilePath(artifactsPath, absDir, "meeting artifacts");
        const artRaw = await fsp.readFile(artifactsPath, "utf-8");
        const allArtifacts: Artifact[] = artRaw
          .split("\n").filter((l: string) => l.trim())
          .map((l: string) => JSON.parse(l) as Artifact);

        for (const a of allArtifacts) {
          if (a.type === "question" && a.status === "active") openQuestions.push(a.id);
          if (a.type === "decision" && a.status === "active" && (a as DecisionArtifact).blockedBy.length === 0 && (a as DecisionArtifact).consensus)
            acceptedDecisions.push(a.id);
          if (a.type === "action" && a.status === "active") pendingActions.push(a.id);
        }
      } catch { /* ignore — no artifacts yet */ }

      try {
        assertWritableFilePath(edgesPath, absDir, "meeting edges");
        const edgeRaw = await fsp.readFile(edgesPath, "utf-8");
        const edges: Edge[] = edgeRaw
          .split("\n").filter((l: string) => l.trim())
          .map((l: string) => JSON.parse(l) as Edge);
        const conflictIds = new Set<string>();
        for (const e of edges) {
          if (e.type === "opposes" && e.status === "active") {
            conflictIds.add(e.from);
            conflictIds.add(e.to);
          }
        }
        activeConflicts.push(...conflictIds);
      } catch { /* ignore — no edges yet */ }

      // Overlay derived fields onto base state
      const state: MeetingState = {
        ...baseState,
        openQuestions,
        activeConflicts,
        acceptedDecisions,
        pendingActions,
      };

      const summary = [
        `Phase: ${state.phase} | Round: ${state.round}`,
        `Open Questions: ${state.openQuestions.length} [${state.openQuestions.join(", ") || "none"}]`,
        `Active Conflicts: ${state.activeConflicts.length} [${state.activeConflicts.join(", ") || "none"}]`,
        `Accepted Decisions: ${state.acceptedDecisions.length} [${state.acceptedDecisions.join(", ") || "none"}]`,
        `Pending Actions: ${state.pendingActions.length} [${state.pendingActions.join(", ") || "none"}]`,
        `Next Step: ${state.nextStep}`,
        state.controllerReasoning ? `Controller Reasoning: ${state.controllerReasoning}` : "",
      ].filter(Boolean).join("\n");

      return {
        content: [{ type: "text" as const, text: summary }],
        details: { state },
      };
    },
  });

  // ── Tool: meeting_update_state ────────────────────────

  const VALID_PHASES: SessionPhase[] = [
    "briefing", "diverge", "challenge", "evidence_check", "converge", "conclusion", "archived",
  ];

  pi.registerTool({
    name: "meeting_update_state",
    label: "Meeting Update State",
    description:
      "Update the meeting phase, round, next step, and controller reasoning. " +
      "State transitions are logged as events. Phase is validated against allowed values.",
    promptSnippet:
      "meeting_update_state({ meetingDir, phase?, round?, nextStep?, controllerReasoning? }) — update meeting state",
    parameters: Type.Object({
      meetingDir: Type.String({ description: "Absolute path to meeting directory" }),
      phase: Type.Optional(Type.String({ description: "New phase: briefing, diverge, challenge, evidence_check, converge, conclusion, archived" })),
      round: Type.Optional(Type.Number({ description: "Current round number (0, 1, 2, 3)" })),
      nextStep: Type.Optional(Type.String({ description: "Human-readable suggestion for what to do next" })),
      controllerReasoning: Type.Optional(Type.String({ description: "Why the facilitator made this decision" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const absDir = validateMeetingDir(params.meetingDir, ctx.cwd);
      const manifestPath = path.join(absDir, "manifest.json");
      assertWritableFilePath(manifestPath, absDir, "manifest");

      // Validate phase if provided
      if (params.phase && !VALID_PHASES.includes(params.phase as SessionPhase)) {
        return {
          content: [{ type: "text" as const, text: `Invalid phase: "${params.phase}". Must be one of: ${VALID_PHASES.join(", ")}` }],
          details: {},
          isError: true,
        };
      }

      return withFileMutationQueue(manifestPath, async () => {
        const statePath = path.join(absDir, "state.json");
        assertWritableFilePath(statePath, absDir, "meeting state");

        let oldState: MeetingState;
        try {
          const raw = await fsp.readFile(statePath, "utf-8");
          oldState = JSON.parse(raw) as MeetingState;
        } catch {
          oldState = {
            meetingDir: absDir,
            topic: path.basename(absDir),
            phase: "briefing",
            round: 0,
            participants: [],
            openQuestions: [],
            activeConflicts: [],
            acceptedDecisions: [],
            pendingActions: [],
            nextStep: "",
            lastUpdated: new Date().toISOString(),
          };
        }

        const now = new Date().toISOString();
        const phaseChanged = params.phase && params.phase !== oldState.phase;

        const newState: MeetingState = {
          ...oldState,
          phase: (params.phase as SessionPhase) || oldState.phase,
          round: params.round !== undefined ? params.round : oldState.round,
          nextStep: params.nextStep ?? oldState.nextStep,
          controllerReasoning: params.controllerReasoning ?? oldState.controllerReasoning,
          lastUpdated: now,
        };

        await fsp.writeFile(statePath, JSON.stringify(newState, null, 2), "utf-8");

        // Log state transition if phase changed
        if (phaseChanged) {
          const eventsPath = path.join(absDir, "events.jsonl");
          assertWritableFilePath(eventsPath, absDir, "meeting events");
          let nextEventNum = 1;
          try {
            const raw = await fsp.readFile(eventsPath, "utf-8");
            nextEventNum = raw.split("\n").filter((l: string) => l.trim()).length + 1;
          } catch { /* empty */ }
          const event: MeetingEvent = {
            id: `evt-${String(nextEventNum).padStart(3, "0")}`,
            type: "state_transition",
            timestamp: now,
            agent: "Facilitator",
            summary: `Phase changed: ${oldState.phase} → ${newState.phase}`,
            details: { oldPhase: oldState.phase, newPhase: newState.phase, reasoning: params.controllerReasoning || "" },
          };
          await fsp.appendFile(eventsPath, JSON.stringify(event) + "\n", "utf-8");
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `State updated. Phase: ${oldState.phase} → ${newState.phase}. Round: ${newState.round}. Next step: ${newState.nextStep}`,
            },
          ],
          details: { oldState, newState },
        };
      });
    },
  });

  // ── Tool: meeting_log_event ───────────────────────────

  pi.registerTool({
    name: "meeting_log_event",
    label: "Meeting Log Event",
    description:
      "Record a meeting event (facilitator_decision, user_feedback, error, retry, digest_generated) " +
      "for auditability and recovery.",
    promptSnippet:
      "meeting_log_event({ meetingDir, type, summary, details? }) — log meeting event",
    parameters: Type.Object({
      meetingDir: Type.String({ description: "Absolute path to meeting directory" }),
      type: Type.String({ description: "facilitator_decision | user_feedback | error | retry | digest_generated" }),
      summary: Type.String({ description: "One-line summary of the event" }),
      details: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Arbitrary context data" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const absDir = validateMeetingDir(params.meetingDir, ctx.cwd);
      const manifestPath = path.join(absDir, "manifest.json");
      assertWritableFilePath(manifestPath, absDir, "manifest");

      return withFileMutationQueue(manifestPath, async () => {
        const eventsPath = path.join(absDir, "events.jsonl");
        assertWritableFilePath(eventsPath, absDir, "meeting events");

        let nextNum = 1;
        try {
          const raw = await fsp.readFile(eventsPath, "utf-8");
          nextNum = raw.split("\n").filter((l: string) => l.trim()).length + 1;
        } catch { /* empty */ }

        const event: MeetingEvent = {
          id: `evt-${String(nextNum).padStart(3, "0")}`,
          type: params.type as EventType,
          timestamp: new Date().toISOString(),
          agent: "Facilitator",
          summary: params.summary,
          details: params.details || {},
        };

        await fsp.appendFile(eventsPath, JSON.stringify(event) + "\n", "utf-8");

        return {
          content: [{ type: "text" as const, text: `Event ${event.id} (${event.type}) logged.` }],
          details: { id: event.id },
        };
      });
    },
  });

  // ── Message Renderer: meeting-entry ───────────────────

  pi.registerMessageRenderer(
    "meeting-entry",
    (message, { expanded }, theme) => {
      const details = message.details as
        | {
            path?: string;
            speaker?: string;
            phase?: string;
            summary?: string;
            meetingDir?: string;
          }
        | undefined;

      const contentStr: string =
        typeof message.content === "string"
          ? message.content
          : (message.content as Array<{ type: string; text?: string }>)
              .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
              .join("");

      const speaker = details?.speaker ?? "Unknown";
      const phase = details?.phase ?? "";
      const summary = details?.summary ?? contentStr;

      // Compact view: speaker · phase — summary
      let text = theme.fg("accent", `▸ ${speaker}`);
      if (phase) text += theme.fg("dim", ` · ${phase}`);
      text += `\n${theme.fg("muted", summary)}`;

      // Expanded view: read full content from disk
      if (expanded && details?.path) {
        try {
          assertExistingFileNoSymlink(details.path, "meeting entry");
          if (details.meetingDir) {
            assertPathInside(
              fs.realpathSync(details.meetingDir),
              fs.realpathSync(details.path),
              "meeting entry real path"
            );
          }
          const fullContent = fs.readFileSync(details.path, "utf-8");
          text += `\n\n${theme.fg("dim", fullContent)}`;
        } catch {
          text += `\n\n${theme.fg("error", "(entry file not found)")}`;
        }
      }

      const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
      box.addChild(new Text(text, 0, 0));
      return box;
    }
  );

  // ── Command: /brainstorm ─────────────────────────────

  pi.registerCommand("brainstorm", {
    description: "Start a multi-agent brainstorming session on a topic",
    handler: async (args, ctx) => {
      const topic = cleanArg(args ?? "");
      if (!topic) {
        ctx.ui.notify("Usage: /brainstorm <topic>", "warning");
        return;
      }
      const prepared = await prepareParticipants(ctx);
      if (!prepared) return;
      await startSession(
        pi,
        ctx,
        "brainstorm",
        topic,
        prepared.participants,
        prepared.config
      );
    },
  });

  // ── Command: /brainstorm-from-file ───────────────────

  pi.registerCommand("brainstorm-from-file", {
    description:
      "Start a brainstorming session from a YAML file " +
      "(topic + participant agent names)",
    handler: async (args, ctx) => {
      await runFromFile(
        pi,
        ctx,
        "brainstorm",
        args,
        "Usage: /brainstorm-from-file <session.yaml>"
      );
    },
  });

  // ── Command: /debate ─────────────────────────────────

  pi.registerCommand("debate", {
    description: "Start a multi-agent debate battle — runs until convergence",
    handler: async (args, ctx) => {
      const topic = cleanArg(args ?? "");
      if (!topic) {
        ctx.ui.notify("Usage: /debate <topic>", "warning");
        return;
      }
      const prepared = await prepareParticipants(ctx);
      if (!prepared) return;
      await startSession(
        pi,
        ctx,
        "debate",
        topic,
        prepared.participants,
        prepared.config
      );
    },
  });

  // ── Command: /debate-from-file ───────────────────────

  pi.registerCommand("debate-from-file", {
    description:
      "Start a debate from a YAML file " +
      "(topic + participant agent names)",
    handler: async (args, ctx) => {
      await runFromFile(
        pi,
        ctx,
        "debate",
        args,
        "Usage: /debate-from-file <session.yaml>"
      );
    },
  });


  // ── Command: /brainstorm-lab ─────────────────────────

  pi.registerCommand("brainstorm-lab", {
    description:
      "Start a v2 lab brainstorming session with artifact tracking, " +
      "edges, state, and context packs",
    handler: async (args, ctx) => {
      const topic = cleanArg(args ?? "");
      if (!topic) {
        ctx.ui.notify("Usage: /brainstorm-lab <topic>", "warning");
        return;
      }
      const prepared = await prepareParticipants(ctx);
      if (!prepared) return;
      await startSession(
        pi,
        ctx,
        "lab",
        topic,
        prepared.participants,
        prepared.config
      );
    },
  });


  // ── Cleanup on session shutdown ───────────────────────

  pi.on("session_shutdown", () => {
    for (const dir of activeWatchers.keys()) {
      stopWatching(dir);
    }
    for (const child of activeChildren) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    }
    activeChildren.clear();
    activeSessions.clear();
  });
}
