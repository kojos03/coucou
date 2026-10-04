// Claude Code hook events → island state.
// Port of HookServer.processEvent / processPermissionRequest from the macOS app.
// Difference from macOS: no terminal filter. On Windows the hook fires from any
// terminal (Windows Terminal, VS Code, PowerShell…) and all of them are handled.

import { Bridge, onEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, type AgentTask } from "../core/state";
import type { Island } from "./island";
import { CodexSessions, type CodexSession } from "./codex-sessions";

const CLAUDE_ID = "integration_claude";
const CODEX_ID = "agent_codex";

/** Codex's chats; the pill shows the one CodexSessions selects. */
let sessions = new CodexSessions();

/** Clears the approval card if no decision was made before the hook gave up. */
let pendingTimeout: number | null = null;

export interface HookPayload {
  hook_event_name?: string;
  request_id?: string;
  session_id?: string;
  turn_id?: string;
  cwd?: string;
  message?: string;
  /** Final assistant reply supplied by Codex Stop events. */
  last_assistant_message?: string | null;
  /** UserPromptSubmit carries `prompt`; `message` belongs to Notification/Stop. */
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** Optional agent tag: lowercase, digits and hyphens, ≤ 24 chars. */
  coucou_agent?: string;
}

/** Same rule as HookServer.validateAgent on macOS. "claude" is reserved. */
function validateAgent(raw: string | undefined): string | null {
  if (!raw || raw.length > 24 || raw === "claude") return null;
  if (!/^[a-z0-9-]+$/.test(raw)) return null;
  return raw;
}

const FALLBACK_COLORS = ["#22C55E", "#EAB308", "#60A5FA", "#E879F9"];

function agentColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  }
  return FALLBACK_COLORS[Math.abs(h) % FALLBACK_COLORS.length];
}

const PROJECT_ALIASES: Record<string, string> = {
  "notch-buddy": "Notch Buddy",
  notchbuddy: "Notch Buddy",
  notch_buddy: "Notch Buddy",
};

function aliasProjectName(name: string): string {
  return PROJECT_ALIASES[name.toLowerCase()] ?? name;
}

function lastPathComponent(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/** frenchStep() — same labels as the macOS app. */
const TOOL_LABELS: Record<string, string> = {
  Bash: "Exécute",
  Read: "Lit",
  Write: "Écrit",
  Edit: "Modifie",
  Glob: "Cherche",
  Grep: "Recherche",
  WebSearch: "Recherche web",
  WebFetch: "Récupère",
  TodoWrite: "Tâches",
  Task: "Agent",
  LS: "Liste",
  MultiEdit: "Modifie",
  NotebookEdit: "Notebook",
  PowerShell: "Exécute",
  // Codex tools
  apply_patch: "Modifie",
  update_plan: "Tâches",
  spawn_agent: "Agent",
};

/** Tools whose `command` is a shell command line. */
const SHELL_TOOLS = new Set(["Bash", "PowerShell", "shell", "shell_command", "exec_command", "local_shell"]);

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A command as one string; some agents send it as a list of arguments. */
function commandOf(input: Record<string, unknown>): string | null {
  const cmd = input.command;
  if (typeof cmd === "string") return cmd;
  if (Array.isArray(cmd) && cmd.length > 0 && cmd.every((part) => typeof part === "string")) return cmd.join(" ");
  return null;
}

/** bashVerb() from the macOS app, plus the PowerShell spellings. */
function shellVerb(command: string): string {
  const first = (command.trim().split(/\s+/)[0] ?? "").toLowerCase();
  if (["cat", "bat", "head", "tail", "less", "more", "nl", "type", "get-content", "gc"].includes(first)) return "Lit";
  if (["rg", "grep", "find", "fd", "ls", "tree", "wc", "dir", "get-childitem", "gci", "select-string", "sls"].includes(first)) {
    return "Cherche";
  }
  const runners = ["pytest", "vitest", "jest", "npm test", "npm run test", "cargo test", "go test",
    "swift test", "make test", "xcodebuild test", "unittest"];
  if (runners.some((runner) => command.includes(runner))) return "Teste";
  return "Exécute";
}

/** The files a Codex apply_patch touches, by name. */
function patchFiles(patch: string): string[] {
  const files: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const match = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/.exec(line.trim());
    if (match) files.push(lastPathComponent(match[1].trim()));
  }
  return files;
}

function stepLabel(tool: string, input: Record<string, unknown>): string {
  let label = TOOL_LABELS[tool] ?? tool;
  // MCP tools arrive as mcp__server__tool: show "server · tool".
  if (tool.startsWith("mcp__")) {
    const parts = tool.slice(5).split("__");
    label = parts.length >= 2 ? `${parts[0]} · ${parts.slice(1).join("__")}` : tool.slice(5);
  }
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  const cmd = commandOf(input);
  if (tool === "apply_patch") {
    const files = patchFiles(cmd ?? "");
    return files.length ? `${label} · ${files[0]}` : label;
  }
  if (cmd) return `${SHELL_TOOLS.has(tool) ? shellVerb(cmd) : label} · ${oneLine(cmd).slice(0, 40)}`;
  const path = str("path");
  if (path) return `${label} · ${lastPathComponent(path)}`;
  const file = str("file_path");
  if (file) return `${label} · ${lastPathComponent(file)}`;
  const query = str("query");
  if (query) return `${label} · ${oneLine(query).slice(0, 40)}`;
  return label;
}

/**
 * What the Allow button actually authorises. Approving "Write" tells you nothing
 * — approving `Write · C:\…\.env` tells you everything, and the difference is
 * the whole point of approving from the island rather than blind.
 *
 * Ordered by how specific the field is, so an unfamiliar tool still shows
 * whatever identifying string it carries instead of falling back to its name.
 */
const APPROVAL_FIELDS = [
  "command", // Bash, PowerShell
  "file_path", // Write, Edit, MultiEdit, NotebookEdit
  "path", // Read, LS
  "url", // WebFetch
  "query", // WebSearch
  "pattern", // Glob, Grep
  "prompt", // Task
] as const;

function approvalTarget(tool: string, input: Record<string, unknown>): string {
  const cmd = commandOf(input);
  // A Codex patch is a whole diff: name the files it changes instead.
  if (tool === "apply_patch" && cmd) {
    const files = patchFiles(cmd);
    if (files.length) return `${tool} · ${files.join(", ")}`;
  }
  if (cmd?.trim()) return `${tool} · ${cmd.trim()}`;
  for (const field of APPROVAL_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) {
      return `${tool} · ${value.trim()}`;
    }
  }
  return tool;
}

function upsert(projectName: string, cwd: string) {
  const t = State.tasks.find((x) => x.id === CLAUDE_ID);
  if (!t) return;
  t.name = projectName;
  if (cwd) t.sessionCwd = cwd;
}

function clearSession() {
  const t = State.tasks.find((x) => x.id === CLAUDE_ID);
  if (!t) return;
  t.steps = [];
  t.stepIndex = 0;
  t.name = "Claude Code";
  t.pillBadge = null;
}

/** Puts the selected Codex chat on the Codex pill: its steps, state, badge and
 * folder (for Open terminal). The pill and its Mochi keep the name Codex. */
function showCodex(task: AgentTask, current: CodexSession | null, focused: boolean) {
  task.state = current?.state ?? "idle";
  task.steps = [...(current?.steps ?? [])];
  task.stepIndex = Math.max(0, task.steps.length - 1);
  task.sessionCwd = current?.cwd ?? null;
  task.sessionId = current?.id || null;
  const asking = State.pendingApproval?.pillId === CODEX_ID;
  if (asking) task.state = "approval";
  task.pillBadge = focused ? null
    : asking ? "approval"
    : task.state === "finished" || task.state === "error" ? task.state : null;
}

function refreshCodex() {
  const task = State.tasks.find((entry) => entry.id === CODEX_ID);
  if (!task) return;
  showCodex(task, sessions.current(), State.focusId === CODEX_ID);
  State.notify();
}

const agentOf = (pillId: string) => (pillId === CODEX_ID ? "Codex" : "Claude Code");

/**
 * The approval card is done with, answered or not: its pill goes back to work.
 * The island's Allow / Deny buttons call this after sending the decision.
 */
export function approvalAnswered() {
  const pending = State.pendingApproval;
  if (!pending) return;
  if (pendingTimeout != null) {
    window.clearTimeout(pendingTimeout);
    pendingTimeout = null;
  }
  State.pendingApproval = null;
  State.isPinned = false;
  if (pending.pillId === CODEX_ID) {
    refreshCodex();
  } else {
    State.updateTask(CLAUDE_ID, "working");
    State.setPillBadge(CLAUDE_ID, null);
  }
}

/** Takes the card down without a decision; the agent asks on its own. */
function releaseApproval(island: Island, note: string | null) {
  if (!State.pendingApproval) return;
  const onScreen = State.mode === "expanded" && State.view === "approval";
  approvalAnswered();
  island.dropPin();
  if (State.view === "approval") {
    if (note && onScreen) {
      State.noteMessage = note;
      island.setView("note");
    } else {
      island.setView(State.defaultView());
    }
  }
  State.notify();
}

/** Events after which a pending request of the same session no longer matters. */
const RESOLVING = ["Stop", "StopFailure", "UserPromptSubmit", "SessionEnd", "Interrupt"];

/** The turn moved on without a click: free the relay and take the card down. */
function resolveApprovalFor(island: Island, pillId: string, name: string, sessionId: string | undefined) {
  const pending = State.pendingApproval;
  if (!pending || pending.pillId !== pillId || !RESOLVING.includes(name)) return;
  if (!pending.sessionId || pending.sessionId !== (sessionId ?? "")) return;
  void Bridge.approvalDecline(pending.requestId);
  releaseApproval(island, `Handled in ${agentOf(pillId)}.`);
}

export function registerHookHandlers(island: Island) {
  sessions = new CodexSessions();
  void onEvent<HookPayload>("hook", (payload) => handleHook(island, payload));
  // The agent stopped waiting before anyone clicked (its own timeout, an
  // interrupted turn): take the card down rather than offer a dead button.
  void onEvent<{ requestId: string }>("approval-gone", ({ requestId }) => {
    const pending = State.pendingApproval;
    if (!pending || pending.requestId !== requestId) return;
    releaseApproval(island, `Handled in ${agentOf(pending.pillId)}.`);
  });
}

function handleHook(island: Island, payload: HookPayload) {
  if (State.paused) {
    // Silence here used to cost Claude Code nearly two minutes: the relay waited
    // for a decision from an island that had already decided not to look. Say so,
    // and the terminal takes the question immediately.
    if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
    return;
  }

  const name = payload.hook_event_name ?? "";
  const cwd = payload.cwd ?? "";
  const raw = lastPathComponent(cwd);
  const projectName = aliasProjectName(raw || "Session");

  // Route to the right pill. Valid coucou_agent → dynamic "agent_<name>" pill.
  // "claude" is reserved; absent or invalid → Claude Code pill unchanged.
  const validAgent = validateAgent(payload.coucou_agent);
  const agentId = validAgent ? `agent_${validAgent}` : CLAUDE_ID;
  const isExternalAgent = validAgent !== null;
  const focused = State.focusId === agentId;

  /** Alerts force the island open; work events only reveal the compact island. */
  const surface = (view: Parameters<Island["alert"]>[0], isAlert: boolean) => {
    if (State.mode === "expanded") {
      if (isAlert) island.setView(view);
    } else if (isAlert) {
      island.alert(view);
    } else if (State.mode === "hidden") {
      island.reveal();
    }
  };

  /** Ensure the agent pill exists (no-op for Claude Code). */
const ensurePill = () => {
  if (isExternalAgent) {
    const displayName =
      validAgent!.charAt(0).toUpperCase() + validAgent!.slice(1);

    State.upsertExternalAgent(
      agentId,
      displayName,
      agentColor(validAgent!),
    );
    // Terminal and VS Code actions open the focused pill's folder. Codex
    // replaces it with the selected session's folder below.
    const task = State.tasks.find((entry) => entry.id === agentId);
    if (task && cwd) task.sessionCwd = cwd;
  } else {
    upsert(projectName, cwd);
  }
};

  if (validAgent === "codex" && name === "SessionStart") {
    // Informational for the pill, but the same cue as Claude Code's: a new chat
    // gets the work sound and a peek at the island.
    if (!sessions.knows(payload.session_id)) {
      Sound.play("work");
      surface("overview", false);
    }
    return;
  }

  if (validAgent === "codex" && name !== "PermissionRequest") {
    resolveApprovalFor(island, CODEX_ID, name, payload.session_id);
    const result = sessions.apply(payload, stepLabel(payload.tool_name ?? "Tool", payload.tool_input ?? {}));
    if (!result) return;
    ensurePill();
    const task = State.tasks.find((entry) => entry.id === agentId)!;
    showCodex(task, result.current, focused);
    if (name === "UserPromptSubmit") State.setFocus(agentId);
    if (result.rateLimited) Sound.play("rate");
    if (result.alert) {
      Sound.play(result.alert === "finished" ? "finish" : "error");
      if (State.focusId === agentId) surface(result.alert, true);
      if (result.alert === "finished") {
        // As Claude Code's pill does 5.2 s after Stop: back to idle, steps kept.
        const { session_id: sessionId, turn_id: turnId } = payload;
        window.setTimeout(() => {
          if (sessions.settle(sessionId, turnId)) refreshCodex();
        }, 5200);
      }
    } else if (State.focusId === agentId) {
      // A new turn or a return to another active chat dismisses the old result.
      // Preserve Settings, chat, and other views the user opened deliberately.
      if (State.mode === "expanded" && (State.view === "finished" || State.view === "error") &&
          task.state !== "finished" && task.state !== "error") {
        island.setView("overview");
      }
      if (result.current) surface("overview", false);
    }
    State.notify();
    return;
  }

  if (agentId === CLAUDE_ID) resolveApprovalFor(island, CLAUDE_ID, name, payload.session_id);

  switch (name) {
    case "SessionStart":
      ensurePill();
      surface("overview", false);
      Sound.play("work");
      break;

    case "UserPromptSubmit": {
  ensurePill();
  State.setFocus(agentId);

  State.updateTask(agentId, "thinking");

  // The field is `prompt`; reading `message` meant this step was always blank.
  const asked = payload.prompt ?? payload.message;
  if (asked) State.appendStep(agentId, asked.slice(0, 60));

  surface("overview", false);
  break;
}

    case "PreToolUse": {
      ensurePill();
      State.updateTask(agentId, "working");
      const tool = payload.tool_name ?? "Tool";
      State.appendStep(agentId, stepLabel(tool, payload.tool_input ?? {}));
      surface("overview", false);
      break;
    }

    case "PostToolUse":
      State.updateTask(agentId, "working");
      break;

    case "PostToolUseFailure":
      State.updateTask(agentId, "working");
      State.appendStep(agentId, "⚠ failed");
      break;

    case "Notification": {
      const message = payload.message ?? "";
      const lower = message.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("limite d")) {
        State.updateTask(agentId, "ratelimit");
        Sound.play("rate");
      } else if (message.endsWith("?")) {
        State.updateTask(agentId, "question");
        State.appendStep(agentId, message);
      }
      break;
    }

    case "Stop": {
  State.updateTask(agentId, "finished");

  const completed = payload.last_assistant_message ?? payload.message;
  if (completed) {
    State.appendStep(agentId, completed.slice(0, 60));
  }

  Sound.play("finish");

  if (focused) {
    surface("finished", true);
  } else {
    State.setPillBadge(agentId, "finished");
  }

  window.setTimeout(() => {
    if (isExternalAgent && agentId !== "agent_codex") {
      State.removeTask(agentId);
    } else if (!isExternalAgent) {
      State.updateTask(agentId, "idle");
      State.setPillBadge(agentId, null);
    }
  }, 5200);

  break;
}

    case "StopFailure":
      State.updateTask(agentId, "error");
      Sound.play("error");
      if (focused) surface("error", true);
      else State.setPillBadge(agentId, "error");
      break;

    case "SessionEnd":
  if (isExternalAgent) {
    State.removeTask(agentId);
  } else {
    State.updateTask(agentId, "idle");
    clearSession();
  }
  break;

    case "SubagentStart":
      State.appendStep(agentId, "+ subagent");
      break;

    case "SubagentStop":
      State.appendStep(agentId, "• subagent done");
      break;

    case "PermissionRequest": {
      // Claude Code and Codex get the card. Other external agents do not —
      // showing one would look like a Claude Code or Codex request. Decline
      // immediately so the agent asks in its own terminal.
      if (isExternalAgent && agentId !== CODEX_ID) {
        if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
        break;
      }

      const requestId = payload.request_id ?? "";
      // One card, one request. A second one must never quietly replace the first
      // — that would leave a human staring at request B while request A waits for
      // a decision nobody can give. Hand it straight back to the terminal.
      if (State.pendingApproval && State.pendingApproval.requestId !== requestId) {
        if (requestId) void Bridge.approvalDecline(requestId);
        break;
      }
      if (agentId === CLAUDE_ID) upsert(projectName, cwd);
      if (pendingTimeout != null) window.clearTimeout(pendingTimeout);
      const tool = payload.tool_name ?? "Tool";
      const input = payload.tool_input ?? {};
      State.pendingApproval = {
        requestId,
        sessionId: payload.session_id ?? "",
        tool,
        command: approvalTarget(tool, input),
        pillId: agentId,
      };
      // The relay's short ack window closes in 800 ms; everything below this
      // line is synchronous, so the card really is up by the time it lands.
      if (requestId) void Bridge.approvalAck(requestId);
      if (agentId === CODEX_ID) refreshCodex();
      else State.updateTask(CLAUDE_ID, "approval");
      State.isPinned = true;
      Sound.play("approval");
      if (focused) {
        island.alert("approval");
      } else {
        // Another agent holds the view, so the card would yank it away. The badge
        // is the signal instead — but it has to be on screen for that to mean
        // anything, hence the reveal. We just told the relay a human can act.
        State.setPillBadge(agentId, "approval");
        island.reveal();
      }
      // Coucou answers within 108 s or not at all; after that the terminal has
      // taken over and the card would be lying.
      pendingTimeout = window.setTimeout(() => {
        pendingTimeout = null;
        if (State.pendingApproval?.requestId !== requestId) return;
        releaseApproval(island, null);
      }, 110_000);
      break;
    }

    default:
      break;
  }
  State.notify();
}
