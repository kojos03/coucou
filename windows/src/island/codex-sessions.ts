import type { BotStateName } from "../core/layout";
import type { HookPayload } from "./hooks";

export interface CodexSession {
  turnId: string | undefined;
  state: BotStateName;
  steps: string[];
  cwd: string;
  order: number;
  ended: boolean;
  promptSeen: boolean;
  retiredTurns: Set<string>;
}

const isActive = (session: CodexSession) =>
  !session.ended && !["idle", "finished", "error"].includes(session.state);

/** Many Codex chats share one pill. Prefer the newest active turn, then a result,
 * then the last settled chat's steps (as Claude Code's ticker keeps its last
 * session on screen). Keep ended sessions/retired turn IDs as tombstones so late
 * async hooks cannot revive them. SessionStart is informational: only a prompt
 * starts a new turn.
 */
export class CodexSessions {
  private sessions = new Map<string, CodexSession>();
  private sequence = 0;

  /** True once any event of this chat has been seen. */
  knows(sessionId: string | undefined): boolean {
    return this.sessions.has(sessionId ?? "");
  }

  /** The chat the pill shows. */
  current(): CodexSession | null {
    const open = [...this.sessions.values()].filter((entry) => !entry.ended);
    const active = open.filter(isActive);
    const results = open.filter((entry) => entry.state !== "idle");
    const pool = active.length ? active : results.length ? results : open.filter((entry) => entry.steps.length > 0);
    return pool.sort((a, b) => b.order - a.order)[0] ?? null;
  }

  /**
   * A few seconds after a turn finishes, its result goes quiet like Claude
   * Code's: the pill returns to idle and keeps the steps on screen. Only the turn
   * that finished, and only if nothing newer happened to it.
   */
  settle(sessionId: string | undefined, turnId: string | undefined): boolean {
    const session = this.sessions.get(sessionId ?? "");
    if (!session || session.ended || session.turnId !== turnId || session.state !== "finished") return false;
    session.state = "idle";
    return true;
  }

  apply(payload: HookPayload, step: string): {
    current: CodexSession | null;
    alert: "finished" | "error" | null;
    /** The chat just hit a rate limit. */
    rateLimited: boolean;
  } | null {
    const name = payload.hook_event_name;
    if (!name || ![
      "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
      "Stop", "StopFailure", "SessionEnd", "Notification",
      "SubagentStart", "SubagentStop", "Interrupt",
    ].includes(name)) return null;

    // Legacy payloads can operate alone, but cannot overwrite identified chats.
    if (!payload.session_id && [...this.sessions.keys()].some((id) => id !== "")) return null;
    const id = payload.session_id ?? "";
    let session = this.sessions.get(id);
    const isPrompt = name === "UserPromptSubmit";
    if (session && name !== "SessionEnd") {
      if (payload.turn_id && session.retiredTurns.has(payload.turn_id)) return null;
      if (isPrompt) {
        if (payload.turn_id === session.turnId && payload.turn_id) {
          if (session.ended || !isActive(session) || session.promptSeen) return null;
        } else if (payload.turn_id || !session.turnId) {
          if (session.turnId) session.retiredTurns.add(session.turnId);
          session = this.newTurn(payload, session.retiredTurns);
          this.sessions.set(id, session);
        } else return null;
      } else if (session.ended || !isActive(session) || payload.turn_id !== session.turnId) {
        return null;
      }
    }
    if (!session) {
      // Also recover when Coucou starts halfway through a turn.
      session = this.newTurn(payload, new Set());
      this.sessions.set(id, session);
    }
    if (payload.cwd) session.cwd = payload.cwd;
    let rateLimited = false;
    const append = (text: string) => {
      if (!text) return;
      session.steps.push(text.slice(0, 60));
      if (session.steps.length > 20) session.steps.shift();
    };
    switch (name) {
      case "UserPromptSubmit":
        session.promptSeen = true;
        // A delayed prompt must not replace an already observed tool's activity.
        if (session.state === "thinking") append(payload.prompt ?? payload.message ?? "");
        break;
      case "PreToolUse":
        session.state = "working";
        append(step);
        break;
      case "PostToolUse":
        session.state = "working";
        break;
      case "PostToolUseFailure":
        session.state = "working";
        append("⚠ failed");
        break;
      case "Stop":
        session.state = "finished";
        session.order = ++this.sequence;
        append(payload.last_assistant_message ?? payload.message ?? "Session finished");
        break;
      case "StopFailure":
        session.state = "error";
        session.order = ++this.sequence;
        append(payload.message ?? "Session failed");
        break;
      case "SessionEnd":
        session.ended = true;
        session.steps = [];
        break;
      case "Interrupt":
        session.state = "idle";
        session.steps = [];
        break;
      case "Notification": {
        const message = payload.message ?? "";
        const lower = message.toLowerCase();
        if (lower.includes("rate limit") || lower.includes("limite d")) {
          rateLimited = session.state !== "ratelimit";
          session.state = "ratelimit";
        } else if (message.endsWith("?")) {
          session.state = "question";
          append(message);
        }
        break;
      }
      case "SubagentStart": append("+ subagent"); break;
      case "SubagentStop": append("• subagent done"); break;
    }
    const current = this.current();
    const alert = current === session && (name === "Stop" || name === "StopFailure")
      ? name === "Stop" ? "finished" : "error"
      : null;
    return { current, alert, rateLimited };
  }

  private newTurn(payload: HookPayload, retiredTurns: Set<string>): CodexSession {
    return {
      turnId: payload.turn_id, state: "thinking", steps: [], cwd: payload.cwd ?? "",
      order: ++this.sequence, ended: false, promptSeen: false, retiredTurns,
    };
  }
}
