/**
 * pi-brainstorm — Multi-agent brainstorm/debate extension for Pi
 *
 * Runs brainstorm and debate sessions across multiple subagents configured
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
 * - Managed agent file generation from config
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
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

interface ParticipantConfig {
  displayName: string;
  agentName: string;
  description?: string;
  model: string;
  roleTitle?: string;
  rolePrompt: string;
  whatYouDo?: string[];
  debatePersona?: DebatePersona;
  brainstormRole?: string;
  tools?: string[];
}

interface BrainstormConfig {
  participants: ParticipantConfig[];
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

const MANAGED_MARKER = "<!-- managed-by: pi-brainstorm -->";
const MEETING_TOOLS = [
  "meeting_append_entry",
  "meeting_read_index",
  "meeting_read_entry",
];
const DEFAULT_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  ...MEETING_TOOLS,
];

// ────────────────────────────────────────────────────────
// Config helpers
// ────────────────────────────────────────────────────────

/**
 * Deep-merge two values. Arrays are replaced entirely; objects are
 * shallow-merged recursively; scalars use the overlay value.
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
    const result: Record<string, any> = { ...base };
    for (const key of Object.keys(overlay)) {
      result[key] =
        key in result
          ? deepMerge(result[key], overlay[key])
          : overlay[key];
    }
    return result;
  }

  return overlay;
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
 */
function hasProjectConfig(cwd: string): boolean {
  if (!cwd) return false;
  return [
    path.join(cwd, ".pi-brainstorm.yaml"),
    path.join(cwd, ".pi", "pi-brainstorm.yaml"),
  ].some((candidate) => fs.existsSync(candidate));
}

function loadConfig(cwd: string): BrainstormConfig {
  const extensionDir = getExtensionDir();
  const packageRoot = path.dirname(extensionDir);

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
          merged = deepMerge(merged, parsed);
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
        merged = deepMerge(merged, parsed);
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
          merged = deepMerge(merged, parsed);
        }
      } catch (err: any) {
        throw new Error(
          `Failed to parse project config ${candidate}: ${err.message}`
        );
      }
    }
  }

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
    "model",
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
    if (typeof p.model !== "string" || !p.model.trim()) {
      throw new Error(
        `Participant at ${configKey}[${i}] has invalid model.`
      );
    }
    if (typeof p.rolePrompt !== "string" || !p.rolePrompt.trim()) {
      throw new Error(
        `Participant at ${configKey}[${i}] has invalid rolePrompt.`
      );
    }
  }

  return participants;
}

function resolveParticipants(cwd: string): ParticipantConfig[] {
  const config = loadConfig(cwd);
  return validateParticipants(config.participants, "participants");
}


// ────────────────────────────────────────────────────────
// Agent file generation
// ────────────────────────────────────────────────────────

/**
 * Generate the content of a managed agent markdown file from a participant config.
 */
function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function generateAgentFile(participant: ParticipantConfig): string {
  const baseTools = participant.tools && participant.tools.length > 0
    ? participant.tools
    : DEFAULT_TOOLS;
  // Always include meeting tools even when participant overrides defaults
  const toolsSet = new Set(baseTools);
  for (const mt of MEETING_TOOLS) {
    toolsSet.add(mt);
  }
  const tools = [...toolsSet];
  const toolsStr = tools.join(", ");

  const description =
    participant.description ||
    `${participant.displayName} brainstorming consultant.`;

  const roleTitle = participant.roleTitle
    ? ` - ${participant.roleTitle}`
    : "";

  const whatYouDoLines = (participant.whatYouDo && participant.whatYouDo.length > 0)
    ? participant.whatYouDo.map((item) => `- ${item}`).join("\n")
    : `- Join the multi-model discussion and provide a ${participant.displayName} perspective`;

  return [
    "---",
    `name: ${yamlScalar(participant.agentName)}`,
    `description: ${yamlScalar(description)}`,
    `tools: ${toolsStr}`,
    `model: ${yamlScalar(participant.model)}`,
    "---",
    "",
    MANAGED_MARKER,
    "",
    `# ${participant.displayName} Brainstormer${roleTitle}`,
    "",
    participant.rolePrompt,
    "",
    "## What You Do",
    whatYouDoLines,
    "",
    "## What You Do Not Do",
    "- Never write code or modify project files; you only read them",
    "- Never delegate to other agents",
    "- Never paste long analyses into chat; when told to use " +
      "meeting_append_entry, write your FULL contribution to the meeting " +
      "blackboard and reply only with WROTE_ENTRY plus a one-sentence summary",
    "",
    "## Worker Preamble",
    "You are a terminal worker. Work directly with tools. Do NOT spawn sub-agents.",
    "",
  ].join("\n");
}

/**
 * Ensure agent files exist for all configured participants.
 * - Files with the managed marker are overwritten from current config.
 * - Files without the marker are never touched.
 * - Missing files are created after user confirmation.
 *
 * Returns true if all participants have existing agent files (managed or not).
 */
async function safeWriteAgentFile(targetPath: string, content: string, mode: "create" | "update"): Promise<void> {
  const dir = path.dirname(targetPath);
  assertDirectoryNoSymlink(dir, "agents directory");
  assertPathInside(fs.realpathSync(dir), path.resolve(targetPath), "agent file");

  if (mode === "create") {
    await fsp.writeFile(targetPath, content, { encoding: "utf-8", flag: "wx" });
    return;
  }

  assertExistingFileNoSymlink(targetPath, "agent file");
  const tempPath = path.join(
    dir,
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`
  );
  await fsp.writeFile(tempPath, content, { encoding: "utf-8", flag: "wx" });
  try {
    await fsp.rename(tempPath, targetPath);
  } catch (err) {
    try {
      await fsp.unlink(tempPath);
    } catch {
      // Ignore cleanup errors.
    }
    throw err;
  }
}

async function ensureAgentsFromConfig(
  ctx: any,
  participants: ParticipantConfig[],
  options: { allowGlobalWrites: boolean }
): Promise<boolean> {
  const agentsDir = path.join(getAgentDir(), "agents");

  const planned: { filename: string; action: "create" | "update" }[] = [];
  const protectedFiles: string[] = [];

  for (const p of participants) {
    const filename = `${p.agentName}.md`;
    const targetPath = path.resolve(agentsDir, filename);
    assertPathInside(agentsDir, targetPath, "agent file");

    if (fs.existsSync(targetPath)) {
      assertExistingFileNoSymlink(targetPath, "agent file");
      const content = fs.readFileSync(targetPath, "utf-8");
      if (content.includes(MANAGED_MARKER)) {
        planned.push({ filename, action: "update" });
      } else {
        protectedFiles.push(filename);
      }
    } else {
      planned.push({ filename, action: "create" });
    }
  }

  // If nothing to create or update, we're done
  if (planned.length === 0) {
    return true;
  }

  if (!options.allowGlobalWrites) {
    ctx.ui?.notify?.(
      "Project-level pi-brainstorm config is active. For safety, this command will not create or update global agent files. Create the listed agents manually or move the config to ~/.pi/agent/pi-brainstorm.yaml.",
      "warning"
    );
    return false;
  }

  // Non-interactive mode
  if (!ctx.hasUI) {
    // Update managed files silently
    await fsp.mkdir(agentsDir, { recursive: true });
    assertDirectoryNoSymlink(agentsDir, "agents directory");
    for (const plan of planned) {
      if (plan.action === "update") {
        const p = participants.find(
          (p) => `${p.agentName}.md` === plan.filename
        )!;
        const targetPath = path.resolve(agentsDir, plan.filename);
        assertPathInside(agentsDir, targetPath, "agent file");
        await safeWriteAgentFile(
          targetPath,
          generateAgentFile(p),
          "update"
        );
      }
    }
    // Report missing
    const missing = planned.filter((p) => p.action === "create");
    if (missing.length > 0) {
      ctx.ui?.notify?.(
        `Missing meeting agents: ${missing.map((m) => m.filename).join(", ")}. Install them under ${agentsDir}.`,
        "warning"
      );
      return false;
    }
    return true;
  }

  // Interactive mode: ask user
  let message = "";
  if (planned.length > 0) {
    const actionWord = planned.some((p) => p.action === "update")
      ? "created/updated"
      : "created";
    message += `The following agent files will be ${actionWord}:\n`;
    for (const p of planned) {
      message += `  - ${p.filename} (${p.action})\n`;
    }
  }
  if (protectedFiles.length > 0) {
    message += `\nThe following existing files are NOT managed by pi-brainstorm and will be left untouched:\n`;
    for (const f of protectedFiles) {
      message += `  - ${f}\n`;
    }
  }

  const title = planned.some((p) => p.action === "update")
    ? "Update brainstorm agents?"
    : "Install brainstorm agents?";

  const ok = await ctx.ui.confirm(
    title,
    message + `\nFiles will be written to ${agentsDir}.`
  );
  if (!ok) return false;

  await fsp.mkdir(agentsDir, { recursive: true });
  assertDirectoryNoSymlink(agentsDir, "agents directory");
  for (const plan of planned) {
    const p = participants.find(
      (p) => `${p.agentName}.md` === plan.filename
    )!;
    const targetPath = path.resolve(agentsDir, plan.filename);
    assertPathInside(agentsDir, targetPath, "agent file");
    await safeWriteAgentFile(targetPath, generateAgentFile(p), plan.action);
  }

  ctx.ui.notify(`Updated ${planned.length} agent file(s).`, "info");
  return true;
}

// ────────────────────────────────────────────────────────
// Prompt builders
// ────────────────────────────────────────────────────────

/**
 * Build the facilitator prompt for /brainstorm.
 */
function buildBrainstormPrompt(
  topic: string,
  absDir: string,
  participants: ParticipantConfig[]
): string {
  const consultantLines = participants
    .map(
      (p) =>
        `- **${p.displayName}**: use the ${p.agentName} subagent. ${p.brainstormRole || p.roleTitle || "Consultant"}.`
    )
    .join("\n");

  const agentTaskLines = participants
    .map(
      (p) =>
        `   - speaker: "${p.displayName}"`
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
    "## PRE-ROUND STEP — Assign a Human-Readable Title",
    "",
    `Before Round 1, choose a concise human-readable meeting title for "${topic}" and call:`,
    `  meeting_rename({ meetingDir: "${absDir}", title: "<your concise title>" })`,
    "",
    "Use the returned `newMeetingDir` for ALL subsequent meeting tools and subagent tasks. If rename fails, continue with the original meetingDir.",
    "",
    "## CRITICAL INSTRUCTIONS",
    "",
    "### Blackboard-first — do NOT paste prior participant text into subagent tasks",
    "",
    "The meeting blackboard is the single source of truth. Subagent tasks must direct participants to READ from the blackboard, not receive pasted history.",
    "",
    "- Round 1: subagents write initial analysis. No prior entries to read.",
    "- Round 2: tell subagents to call meeting_read_index and meeting_read_entry on the current meetingDir to read Round 1 entries before responding.",
    "- Round 3: tell subagents to call meeting_read_index and meeting_read_entry to read ALL prior round entries AND any User feedback entries from the blackboard.",
    "- User feedback: if the user provides feedback that exists only in chat, APPEND it to the blackboard as `speaker: \"User\", phase: \"Feedback after Round N\"`, then tell participants to read it from the blackboard.",
    "",
    "### For subagents (include in EVERY task):",
    "1. When the task asks for prior context, read it from the blackboard using meeting_read_index and meeting_read_entry. Round 1 has no prior entries to read.",
    "2. Write your FULL contribution using the meeting_append_entry tool with:",
    `   - meetingDir: the current meetingDir (use the one returned by meeting_rename if rename succeeded)`,
    "   - speaker: your display name, e.g.:",
    agentTaskLines,
    '   - phase: "Round 1", "Round 2", or "Round 3"',
    "   - summary: a ONE-SENTENCE summary of your contribution",
    "   - content: your FULL analysis (in the user's language, default English)",
    "   - content must contain only the participant's analysis. Do not include wrapper tags, hidden thinking markers, tool-call text, or WROTE_ENTRY text inside content.",
    "3. After writing, your FINAL ANSWER must be ONLY:",
    "   `WROTE_ENTRY: <your one-sentence summary>`",
    "4. DO NOT paste your full analysis into the chat. The main agent and user will read it from the blackboard.",
    "",
    "### For you, the facilitator:",
    "- Do NOT paste participant full text into chat. They are on the blackboard.",
    "- Do NOT paste prior round content into subagent tasks. Tell subagents to read the blackboard.",
    "- After each round, read the index with meeting_read_index and present a structural overview.",
    "- Optionally read full entries with meeting_read_entry when needed.",
    "- Present each consultant's summary + your structural overview (conflict matrix, consensus table).",
    "- When the user gives feedback, append it to the blackboard as a User entry, then tell participants to read it.",
    "",
    "## Protocol",
    "Round 1: Each consultant gives initial analysis on the topic. Run all in parallel. Subagents do not need to read prior entries.",
    "After Round 1: read the index, present summaries plus a structural overview, then STOP. Ask the user for feedback or permission to continue. Do NOT start Round 2 in the same assistant turn.",
    "Round 2: only after the user replies, tell each subagent to call meeting_read_index and meeting_read_entry to read Round 1 entries, then challenge the others and propose improvements. If user feedback exists, append it to the blackboard first.",
    "After Round 2: read the index, present summaries plus an updated structural overview, then STOP. Ask the user for feedback or permission to continue. Do NOT start Round 3 in the same assistant turn.",
    "Round 3: only after the user replies, tell each subagent to read ALL prior round entries AND user feedback entries from the blackboard (via meeting_read_index and meeting_read_entry). Each gives FINAL recommendation, synthesizing the best ideas.",
    "",
    "After Round 3, present the complete structural overview and ask whether to write the final conclusion. Only write conclusion.md after the user confirms.",
    "",
    "## FAILURE HANDLING",
    "Subagent calls can fail (timeout, API error, model unavailable, crash). You MUST detect and handle failures:",
    "",
    "### Detecting failure",
    "A subagent call has FAILED if:",
    "- The tool result contains error text (\"error\", \"failed\", \"timeout\", \"unavailable\", \"connection\", etc.)",
    "- The subagent returns no output or empty output",
    "- The subagent output does NOT contain \"WROTE_ENTRY:\" (the expected success marker)",
    "- The subagent produced no meeting_append_entry call (check with meeting_read_index after the parallel batch)",
    "",
    "### Retry strategy",
    "When you detect a failure:",
    "1. Wait 5-10 seconds before retrying (API rate limits may have triggered the failure)",
    "2. Retry the SAME consultant with the SAME task up to 2 more times (3 attempts total)",
    "3. On retry, add to the task: \"PREVIOUS ATTEMPT FAILED. This is retry N of 2. Focus only on completing your contribution and writing WROTE_ENTRY.\"",
    "4. If the consultant succeeds on retry, proceed normally",
    "5. If ALL retries are exhausted, treat this consultant as UNAVAILABLE for this round",
    "",
    "### When a consultant is UNAVAILABLE",
    "- Do NOT wait indefinitely or freeze the session",
    "- Proceed with the remaining consultants who succeeded",
    "- In your structural overview, clearly mark the failed participant as: " +
      "\"[displayName] ([agentName]): did not respond\"",
    "- Continue to the next round normally — do NOT skip the consultant in future rounds (they may recover)",
    "- If the same consultant fails in 2 consecutive rounds, warn the user " +
      "with the real display name, e.g.: \"GPT-Critic failed in 2 " +
      "consecutive rounds; check whether that model is available\"",
    "",
    "### NEVER do this",
    "- Do NOT fabricate or simulate a consultant's response",
    "- Do NOT impose an extra manual timeout beyond the subagent tool's timeout; if the tool reports timeout, treat that attempt as failed",
    "- Do NOT abort the entire session because one consultant failed",
    "",
    "## IMPORTANT",
    "- Respond in the language the user uses; default to English.",
    "- Save transcript.md and (after user confirms) conclusion.md per the MEETING OUTPUT PROTOCOL.",
    "- The user can intervene at any time to steer the discussion.",
  ].join("\n");
}

/**
 * Build the facilitator prompt for /debate.
 */
function buildDebatePrompt(
  topic: string,
  absDir: string,
  participants: ParticipantConfig[]
): string {
  const debaterLines = participants
    .map((p) => {
      const dp = p.debatePersona;
      if (dp) {
        return `- **${p.displayName}** (${p.agentName}): ${dp.label} — Attack other positions, find flaws, expose assumptions.`;
      }
      return `- **${p.displayName}** (${p.agentName})`;
    })
    .join("\n");

  // Build per-agent debate task prefixes for the facilitator to include
  const taskPrefixLines = participants
    .map((p) => {
      const dp = p.debatePersona;
      if (dp && dp.prompt) {
        return `**${p.displayName}** (${p.agentName}):\n${dp.prompt}`;
      }
      return `**${p.displayName}** (${p.agentName}): Debate participant.`;
    })
    .join("\n\n");

  const agentTaskLines = participants
    .map(
      (p) =>
        `   - speaker: "${p.displayName}"`
    )
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
    "## DEBATE PERSONAS (include in each subagent task)",
    taskPrefixLines,
    "",
    "## PRE-ROUND STEP — Assign a Human-Readable Title",
    "",
    `Before Cycle 1, choose a concise human-readable meeting title for "${topic}" and call:`,
    `  meeting_rename({ meetingDir: "${absDir}", title: "<your concise title>" })`,
    "",
    "Use the returned `newMeetingDir` for ALL subsequent meeting tools and subagent tasks. If rename fails, continue with the original meetingDir.",
    "",
    "## CRITICAL INSTRUCTIONS",
    "",
    "### Blackboard-first — do NOT paste prior participant text into subagent tasks",
    "",
    "The meeting blackboard is the single source of truth. Subagent tasks must direct participants to READ from the blackboard, not receive pasted history.",
    "",
    "- Each subagent must call meeting_read_index and meeting_read_entry on the current meetingDir to read the complete debate history before writing.",
    "- NEVER summarize or truncate the debate record when passing to subagents — tell them to read it from the blackboard.",
    "- If the user provides feedback in chat, APPEND it to the blackboard as `speaker: \"User\", phase: \"Feedback\"`, then tell debaters to read it.",
    "",
    "### For subagents (include in EVERY task):",
    "1. First, read the complete debate history from the blackboard using meeting_read_index and meeting_read_entry.",
    "2. Write your FULL contribution using the meeting_append_entry tool with:",
    `   - meetingDir: the current meetingDir (use the one returned by meeting_rename if rename succeeded)`,
    "   - speaker: your display name, e.g.:",
    agentTaskLines,
    '   - phase: "Cycle 1", "Cycle 2", etc.',
    "   - summary: a ONE-SENTENCE summary of your argument",
    "   - content: your FULL argument (in the user's language, default English)",
    "3. After writing, your FINAL ANSWER must be ONLY:",
    "   `WROTE_ENTRY: <your one-sentence summary>`",
    "4. DO NOT paste your full argument into the chat.",
    "",
    "### For you, the facilitator:",
    "- Do NOT paste participant full text into chat. They are on the blackboard.",
    "- Do NOT paste prior debate history into subagent tasks. Tell subagents to read the blackboard.",
    "- Cycle through debaters in sequence (chain mode) so each sees all prior entries.",
    "- Read the index with meeting_read_index frequently.",
    "- Read full entries with meeting_read_entry when synthesizing.",
    "- After EACH full cycle (all debaters spoke once), check for CONVERGENCE:",
    "  * Do 2+ agents agree on a specific conclusion?",
    "  * Did the last cycle introduce any NEW arguments?",
    "  * Did anyone explicitly concede?",
    "- If NOT converged: run another cycle. Keep going.",
    "- If converged: present synthesis to me.",
    "",
    "## FAILURE HANDLING",
    "Subagent calls can fail (timeout, API error, model unavailable, crash). You MUST detect and handle failures:",
    "",
    "### Detecting failure",
    "A subagent call has FAILED if:",
    "- The tool result contains error text (\"error\", \"failed\", \"timeout\", \"unavailable\", \"connection\", etc.)",
    "- The subagent returns no output or empty output",
    "- The subagent output does NOT contain \"WROTE_ENTRY:\" (the expected success marker)",
    "- The subagent produced no meeting_append_entry call (check with meeting_read_index after the chain step)",
    "",
    "### Retry strategy",
    "When you detect a failure in a chain step:",
    "1. Wait 5-10 seconds before retrying (API rate limits may have triggered the failure)",
    "2. Retry the SAME debater with the SAME task up to 2 more times (3 attempts total)",
    "3. On retry, add to the task: \"PREVIOUS ATTEMPT FAILED. This is retry N of 2. Focus only on completing your argument and writing WROTE_ENTRY.\"",
    "4. If the debater succeeds on retry, proceed to the next debater in the chain",
    "5. If ALL retries are exhausted, SKIP this debater for this cycle and move to the next debater",
    "",
    "### When a debater is UNAVAILABLE",
    "- Do NOT wait indefinitely or freeze the session",
    "- Skip to the next debater in the cycle",
    "- In your structural overview, clearly mark the failed participant as: " +
      "\"[displayName] ([agentName]): did not respond\"",
    "- Continue the debate with remaining debaters — do NOT abort the whole debate",
    "- If the same debater fails in 2 consecutive cycles, warn the user " +
      "with the real display name, e.g.: \"GPT-Critic failed in 2 " +
      "consecutive cycles; check whether that model is available\"",
    "",
    "### NEVER do this",
    "- Do NOT fabricate or simulate a debater's argument",
    "- Do NOT impose an extra manual timeout beyond the subagent tool's timeout; if the tool reports timeout, treat that attempt as failed",
    "- Do NOT abort the entire debate because one debater failed",
    "- Do NOT get stuck in an infinite retry loop — 3 attempts max per debater per cycle",
    "",
    "## Rules",
    "- NEVER stop at a predetermined count. Only convergence or user intervention ends this debate.",
    "- Respond in the language the user uses; default to English.",
    "- After convergence, save transcript.md immediately and (after user confirms) conclusion.md per the MEETING OUTPUT PROTOCOL.",
    "- Present: (1) the debate arc, (2) who conceded what, (3) final synthesis.",
  ].join("\n");
}


/**
 * Build the facilitator prompt for /brainstorm-lab (v2).
 */
function buildBrainstormLabPrompt(
  topic: string,
  absDir: string,
  participants: ParticipantConfig[]
): string {
  const consultantLines = participants
    .map(
      (p) =>
        `- **${p.displayName}**: use the ${p.agentName} subagent. ${p.brainstormRole || p.roleTitle || "Consultant"}.`
    )
    .join("\n");

  const agentTaskLines = participants
    .map((p) => `   - speaker: "${p.displayName}"`)
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
    "## PRE-ROUND STEP — Assign a Human-Readable Title",
    "",
    `Before Round 1, choose a concise human-readable meeting title for "${topic}" and call:`,
    `  meeting_rename({ meetingDir: "${absDir}", title: "<your concise title>" })`,
    "",
    "Use the returned `newMeetingDir` for ALL subsequent meeting tools and subagent tasks. If rename fails, continue with the original meetingDir.",
    "",
    "## V2 LAB TOOLS (in addition to meeting_append_entry/meeting_read_*)",
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
    "## CRITICAL INSTRUCTIONS",
    "",
    "### Blackboard-first — do NOT paste prior participant text into subagent tasks",
    "",
    "The meeting blackboard is the single source of truth. Subagent tasks must direct participants to READ from the blackboard.",
    "",
    "- Round 1: subagents write initial analysis. No prior entries to read.",
    "- Round 2: tell subagents to call meeting_read_index and meeting_read_entry to read Round 1 entries.",
    "- Round 3: tell subagents to read ALL prior round entries AND any User feedback entries.",
    "- User feedback: append to blackboard as speaker: \"User\", phase: \"Feedback after Round N\".",
    "",
    "### For subagents (include in EVERY task):",
    "1. Read prior context from the blackboard using meeting_read_index and meeting_read_entry.",
    "2. Write your FULL contribution using meeting_append_entry with speaker, phase, summary, and content.",
    "3. After writing, reply ONLY with: `WROTE_ENTRY: <your one-sentence summary>`",
    "4. DO NOT paste your full analysis into the chat.",
    "",
    "### ARTIFACT EXTRACTION (after each round):",
    "",
    "After each round completes, YOU (the facilitator) MUST extract structured artifacts from every entry:",
    "",
    "1. Read each entry with meeting_read_entry.",
    "2. For each Claim found: call meeting_append_artifact with type: \"claim\", the claim content, sourceEntryId, sourceEntryPath, sourceQuote (verbatim), confidence (high/medium/low), and evidenceLevel (strong/moderate/weak/none).",
    "3. For each Question found: call meeting_append_artifact with type: \"question\", the question content, and raisedBy.",
    "4. For each Risk identified: call with type: \"risk\", severity, and likelihood.",
    "5. For each Evidence cited: call with type: \"evidence\", strength, and supports/opposes artifact IDs.",
    "6. For each Decision proposed: call with type: \"decision\", rationale, blockedBy, and dependsOn.",
    "7. For each Action item: call with type: \"action\", assignee, and priority.",
    "",
    "**Hard rules for artifacts:**",
    "- sourceQuote MUST be a non-empty verbatim quote from the source entry.",
    "- High-confidence claims with evidenceLevel=\"none\" are auto-marked as evidenceDebt.",
    "- Decisions with non-empty blockedBy are auto-marked as non-consensus.",
    "",
    "### EDGE CREATION (after artifact extraction):",
    "",
    "After extracting artifacts, define relationships:",
    "- If artifact A supports B: meeting_append_edge with type: \"supports\"",
    "- If A opposes B: meeting_append_edge with type: \"opposes\"",
    "- If A blocks B: meeting_append_edge with type: \"blocks\"",
    "- If A resolves B: meeting_append_edge with type: \"resolves\"",
    "- Every edge must record creator, basis, and status.",
    "",
    "### STATE MANAGEMENT:",
    "",
    "- After each round, call meeting_update_state to advance the phase and round:",
    "  * After Round 1: phase=\"challenge\", round=1, nextStep=\"Round 2 — challenge and refine\"",
    "  * After Round 2: phase=\"evidence_check\", round=2, nextStep=\"Round 3 — final synthesis\"",
    "  * After Round 3: phase=\"converge\", round=3, nextStep=\"Generate conclusion\"",
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
    "- In each subagent's task, include a brief summary of: unresolved questions, active conflicts (who vs whom), accepted decisions, and any unaddressed risks.",
    "- ALSO instruct subagents to read the blackboard themselves — the context pack is a navigation aid, not a replacement.",
    "",
    "### HARD RULES FOR FINAL CONCLUSION:",
    "",
    "1. Every assertion in conclusion must reference an artifact ID, entry ID, AND source quote.",
    "2. High-confidence claims with evidenceLevel=\"none\" → downgrade in conclusion, mark as evidence debt.",
    "3. A decision blocked by unresolved risks/conflicts must NOT be written as consensus.",
    "4. Every edge in the conclusion trail must have creator, basis, and status documented.",
    "5. User feedback must be logged as an event, reflected in state, and may create new artifacts.",
    "",
    "## Protocol (same as legacy /brainstorm)",
    "",
    "Round 1: Each consultant gives initial analysis. Run in parallel.",
    "Stop after Round 1. Present your structural overview, then ASK for user feedback or permission to continue.",
    "Round 2: only after user replies. Tell subagents to read Round 1 entries + context pack, then challenge others and improve.",
    "Stop after Round 2. Present updated overview, then ASK for permission.",
    "Round 3: only after user replies. Tell subagents to read ALL entries. Each gives FINAL recommendation, synthesizing the best ideas.",
    "",
    "After Round 3, present the complete structural overview and ask whether to write the final conclusion. Only write conclusion.md after the user confirms.",
    "",
    "## FAILURE HANDLING (same as legacy)",
    "",
    "Detect failures: error text, empty output, no WROTE_ENTRY, no meeting_append_entry call.",
    "Retry: wait 5-10s, retry up to 2 more times (3 total). On retry: \"PREVIOUS ATTEMPT FAILED. This is retry N of 2.\"",
    "If unavailable: mark as \"[displayName] ([agentName]): " +
      "did not respond\", continue with remaining participants.",
    "If same participant fails 2 consecutive rounds, warn user.",
    "NEVER fabricate responses. NEVER abort session for one failure.",
    "",
    "## IMPORTANT",
    "- Respond in the language the user uses; default to English.",
    "- Save transcript.md and (after user confirms) conclusion.md per the MEETING OUTPUT PROTOCOL.",
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
  const meetingsRoot = path.resolve(cwd, ".pi-meetings");

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
 * Resolve configured participants (optionally filtered to a subset),
 * ensure their agent files exist, and return the ready list.
 * Notifies the user and returns null on any error.
 */
async function prepareParticipants(
  ctx: any,
  selector?: string[]
): Promise<ParticipantConfig[] | null> {
  let all: ParticipantConfig[];
  try {
    all = resolveParticipants(ctx.cwd);
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

  const agentsReady = await ensureAgentsFromConfig(ctx, participants, {
    allowGlobalWrites: !hasProjectConfig(ctx.cwd),
  });
  if (!agentsReady) return null;

  return participants;
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
  participants: ParticipantConfig[]
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
    promptText = buildBrainstormLabPrompt(topic, absDir, participants);
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
      ? buildBrainstormPrompt(topic, absDir, participants)
      : buildDebatePrompt(topic, absDir, participants);
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

  const participants = await prepareParticipants(ctx, session.participants);
  if (!participants) return;

  await startSession(pi, ctx, kind, session.topic, participants);
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
      const participants = await prepareParticipants(ctx);
      if (!participants) return;
      await startSession(pi, ctx, "brainstorm", topic, participants);
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
      const participants = await prepareParticipants(ctx);
      if (!participants) return;
      await startSession(pi, ctx, "debate", topic, participants);
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
      const participants = await prepareParticipants(ctx);
      if (!participants) return;
      await startSession(pi, ctx, "lab", topic, participants);
    },
  });


  // ── Cleanup on session shutdown ───────────────────────

  pi.on("session_shutdown", () => {
    for (const dir of activeWatchers.keys()) {
      stopWatching(dir);
    }
  });
}
