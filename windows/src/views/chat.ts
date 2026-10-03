// Chat view — DOM port of PromptView / ChatBubble / TypingDotsView from
// IslandViewContent.swift.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { Bridge, chatFailure, settingsSectionFor, type ChatContext } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, type ChatMessage, type ChatProvider } from "../core/state";
import type { ViewHost } from "./views";

let nextId = 1;

function bubble(message: ChatMessage): HTMLElement {
  if (message.role === "user") {
    return h(
      "div",
      { class: "chat-row user" },
      h("div", { class: "bubble", text: message.content }),
    );
  }
  return h("div", { class: "chat-row" }, h("div", { class: "reply", text: message.content }));
}

function typingDots(): HTMLElement {
  return h(
    "div",
    { class: "chat-row" },
    h("div", { class: "typing" }, h("i"), h("i"), h("i")),
  );
}

/** The coloured chip showing what the question is about (a dropped file). */
function contextChip(label: string): HTMLElement {
  const chip = h("div", { class: "chip" }, h("i", { class: "chip-dot" }), h("span", { text: label }));
  requestAnimationFrame(() => chip.classList.add("settled"));
  return chip;
}

export function buildPrompt(onHeightChange: () => void): ViewHost {
  const chipRow = h("div", { class: "chip-row" });
  const log = h("div", { class: "chat-log" });
  const errorBox = h("div", { class: "chat-error", role: "alert", hidden: true });
  const input = h("input", {
    type: "text",
    class: "chat-input",
    placeholder: "Ask me anything…",
    spellcheck: "false",
  }) as HTMLInputElement;
  const send = h("button", { class: "send-btn", title: "Send" }, svg(ICONS.arrowUp, 11));
  const bar = h("div", { class: "chat-bar" }, input, send);

  const el = h(
    "div",
    { class: "view" },
    h("div", { class: "card wash chat-card" }, h("div", { class: "chat-body" }, chipRow, log, errorBox, bar)),
  );
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(99,102,241,0.5)");

  let sending = false;
  /** The pending reply and the error on show each belong to one Mochi. */
  let pendingFor: ChatProvider | null = null;
  let errorFor: ChatProvider | null = null;
  let renderedKey = "";

  function showError(provider: ChatProvider, err: unknown, question: string) {
    const failure = chatFailure(err);
    const actions = h("div", { class: "actions" });
    // Claude's Mochi cannot use a Claude plan itself; Claude Code can.
    if (provider === "anthropic" && failure.code === "missing_key") {
      actions.append(h("button", {
        class: "btn secondary", text: "Ask in Claude Code",
        onclick: () => void handOff(question),
      }));
    }
    if (failure.settings) {
      actions.append(h("button", {
        class: "btn secondary", text: "Chat settings",
        onclick: () => void Bridge.openSettingsWindow(settingsSectionFor(provider)),
      }));
    }
    actions.append(h("button", { class: "btn secondary", text: "Retry", onclick: () => void submit() }));
    clear(errorBox);
    errorBox.append(h("div", { text: failure.message }), actions);
    errorFor = provider;
  }

  async function handOff(question: string) {
    let note = "Your question is open in Claude Code, which uses your Claude sign-in.";
    try {
      await Bridge.openClaudeCode(question);
      if (input.value.trim() === question) input.value = "";
    } catch (err) {
      note = chatFailure(err).message;
    }
    clear(errorBox);
    errorBox.append(h("div", { text: note }));
    errorFor = "anthropic";
    State.notify();
  }

  async function submit() {
    const query = input.value.trim();
    if (!query || sending) return;
    // The Mochi on screen answers: Codex's through OpenAI, the others through Anthropic.
    const provider = State.chatProvider;
    const history = State.chatHistories[provider];
    input.value = "";
    errorFor = null;
    clear(errorBox);
    sending = true;
    pendingFor = provider;
    Sound.play("send");

    const message: ChatMessage = { id: nextId++, role: "user", content: query };
    history.push(message);
    State.stateOverride = "thinking";
    State.notify();
    onHeightChange();

    const file = State.droppedFile;
    const context: ChatContext | null =
      history.length === 1 && file ? { kind: "file", name: file.name, path: file.path } : null;
    // A file dropped meanwhile starts new conversations; this turn's reply or
    // error then belongs to one that no longer exists.
    const current = () => State.chatHistories[provider] === history;

    try {
      const reply = await Bridge.chatSend(provider, query, context);
      State.stateOverride = null;
      if (current()) {
        history.push({ id: nextId++, role: "assistant", content: reply.text });
        Sound.play("finish");
      }
    } catch (err) {
      State.stateOverride = null;
      if (current()) {
        // The backend rolls back failed turns too. Preserve the draft and first-file
        // context so a setup error does not lose the user's question or attachment.
        const index = history.indexOf(message);
        if (index >= 0) history.splice(index, 1);
        input.value = query;
        showError(provider, err, query);
        Sound.play("error");
      }
    } finally {
      sending = false;
      pendingFor = null;
      State.notify();
      onHeightChange();
      input.focus();
    }
  }

  send.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") {
      e.preventDefault();
      void submit();
    }
    e.stopPropagation(); // Escape closes the island, not the chat
  });

  return {
    el,
    sync() {
      const file = State.droppedFile;
      const wantChip = file?.name ?? "";
      if (chipRow.dataset.label !== wantChip) {
        chipRow.dataset.label = wantChip;
        clear(chipRow);
        if (wantChip) chipRow.append(contextChip(wantChip));
      }

      // Switching pills swaps the conversation along with the Mochi.
      const provider = State.chatProvider;
      const history = State.chatHistories[provider];
      const thinking = pendingFor === provider;
      const key = `${provider}:${history.length}:${thinking}`;
      if (key !== renderedKey) {
        renderedKey = key;
        clear(log);
        for (const m of history) log.append(bubble(m));
        if (thinking) log.append(typingDots());
        log.scrollTop = log.scrollHeight;
      }
      errorBox.hidden = errorFor !== provider;

      // Codex's Mochi names the service that answers; Claude's keeps its wording.
      const service = provider === "openai" ? " (OpenAI)" : "";
      input.placeholder = (history.length === 0 ? "Ask me anything…" : "Continue…") + service;
      input.disabled = sending;
      send.disabled = sending;
    },
    focus() {
      input.focus();
      input.select();
    },
  };
}
