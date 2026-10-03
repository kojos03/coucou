// Settings window — the place where anything that writes to disk is confirmed.
// Stage 2 covers the Claude Code hooks and the general preferences; API keys and
// integrations land here too in a later stage.

import "./settings.css";
import { Bridge, chatFailure, onEvent, type HookStatus, type SettingsSection } from "../core/bridge";
import { DEFAULT_SETTINGS, type ChatProvider, type Settings } from "../core/state";
import { h, clear } from "../views/dom";

let settings: Settings = { ...DEFAULT_SETTINGS };
let version = "";

const root = document.getElementById("settings-root")!;

async function save() {
  await Bridge.saveSettings(settings);
}

// ── Reusable bits ─────────────────────────────────────────────────────────────

function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    onChange(next);
  });
  return el;
}

function statusDot(ok: boolean): HTMLElement {
  return h("i", { class: "dot", style: `background:${ok ? "#22c55e" : "#f4505e"}` });
}

function renderDiff(text: string): HTMLElement {
  const box = h("div", { class: "diff" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    box.append(h("div", { class: cls, text: line }));
  }
  return box;
}

// ── Claude Code section ───────────────────────────────────────────────────────

function claudeSection(status: HookStatus): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const section = h(
    "section",
    {},
    h("h2", {}, statusDot(status.installed), h("span", { text: "Claude Code" })),
    body,
  );

  const rebuild = async () => {
    const fresh = await Bridge.hooksStatus();
    if (fresh) Object.assign(status, fresh);
    clear(body);
    draw();
    const head = section.querySelector("h2")!;
    clear(head);
    head.append(statusDot(status.installed), h("span", { text: "Claude Code" }));
  };

  function draw() {
    body.append(
      h("div", {
        class: "hint",
        text: status.installed
          ? "Coucou is hooked into your Claude Code sessions. Tool calls, questions and permission requests show up in the island, and you can answer them there."
          : "Install the hooks to see your Claude Code sessions in the island and approve permissions without leaving what you are doing.",
      }),
      h("div", { class: "row" },
        h("label", { text: "settings.json" }),
        h("span", { class: "path", text: status.settingsPath }),
      ),
      h("div", { class: "row" },
        h("label", { text: "Relay" }),
        h("span", { class: "path", text: status.hookPath }),
        statusDot(status.hookReady),
      ),
    );

    if (!status.hookReady) {
      body.append(h("div", {
        class: "notice warn",
        text: "coucou-hook.exe is not in place yet. Restart Coucou; if it still fails, build it with `cargo build -p coucou-hook`.",
      }));
    }

    const actions = h("div", { class: "row" });
    const install = h("button", {
      class: "primary",
      text: status.installed ? "Reinstall hooks…" : "Install hooks…",
      onclick: () => showPreview(true),
    });
    // Writing hook commands that point at a relay which isn't there would give
    // every Claude Code session a broken hook and nothing to show for it.
    if (!status.hookReady) {
      install.disabled = true;
      install.title = "The relay isn't installed yet.";
    }
    actions.append(install);
    if (status.installed) {
      actions.append(h("button", {
        class: "danger",
        text: "Uninstall hooks…",
        onclick: () => showPreview(false),
      }));
    }
    body.append(actions);
  }

  async function showPreview(install: boolean) {
    let preview;
    try {
      preview = await Bridge.hooksPreview(install);
    } catch (err) {
      // An unreadable or invalid settings.json stops here rather than being
      // treated as empty and written over.
      clear(body);
      body.append(
        h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }),
        h("div", { class: "row" }, h("button", {
          text: "Back",
          onclick: () => { clear(body); draw(); },
        })),
      );
      return;
    }
    if (!preview) return;
    clear(body);
    body.append(
      h("div", {
        class: "hint",
        text: install
          ? "This is exactly what will change in your settings.json. Your own hooks are left untouched."
          : "This removes Coucou's entries only. Your own hooks are left untouched.",
      }),
      renderDiff(preview.diff),
      h("div", { class: "row" },
        h("span", { class: "path", text: `Backup → ${preview.backup}` }),
      ),
    );
    const confirm = h("button", {
      class: install ? "primary" : "danger",
      text: install ? "Back up and write" : "Back up and remove",
    });
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      try {
        const backup = await Bridge.hooksApply(install, preview.fingerprint);
        clear(body);
        body.append(h("div", {
          class: "notice ok",
          text: `Done. Previous settings saved as ${backup}. Open a new Claude Code session to pick the hooks up.`,
        }));
        window.setTimeout(() => void rebuild(), 2600);
      } catch (err) {
        confirm.disabled = false;
        body.append(h("div", { class: "notice err", text: `Could not write: ${String(err)}` }));
      }
    });
    body.append(h("div", { class: "row" }, confirm, h("button", {
      text: "Cancel",
      onclick: () => { clear(body); draw(); },
    })));
  }

  draw();
  return section;
}

// ── Chat sections: Claude's Mochi (Anthropic) and Codex's Mochi (OpenAI) ──────

interface ChatSectionConfig {
  id: string;
  /** What `open_settings_window` sends to scroll here. */
  target: SettingsSection;
  provider: ChatProvider;
  vendor: string;
  keyName: string;
  title: string;
  about: string;
  missing: string;
  placeholder: string;
  models: [string, string][];
  setting: "model" | "openaiModel";
  console: [string, string];
}

const CLAUDE_CHAT: ChatSectionConfig = {
  id: "claude-api",
  target: "claude",
  provider: "anthropic",
  vendor: "Anthropic",
  keyName: "anthropic-api-key",
  title: "Claude's Mochi · Anthropic",
  about: "Answers when you chat while the Claude Code pill, or any pill other than Codex, is focused. It uses a separate Anthropic API key: signing into Claude Code or Codex does not configure it. Keys are stored in the operating system's credential store.",
  missing: "Add an Anthropic API key to chat with Claude's Mochi.",
  placeholder: "sk-ant-...",
  models: [
    ["claude-opus-5", "Claude Opus 5"],
    ["claude-sonnet-5", "Claude Sonnet 5"],
    ["claude-haiku-4-5", "Claude Haiku 4.5"],
  ],
  setting: "model",
  console: ["Anthropic Console", "https://console.anthropic.com/"],
};

const CODEX_CHAT: ChatSectionConfig = {
  id: "openai-api",
  target: "openai",
  provider: "openai",
  vendor: "OpenAI",
  keyName: "openai-api-key",
  title: "Codex's Mochi · OpenAI",
  about: "Answers when you chat while the Codex pill is focused. It uses a separate OpenAI API key: signing into Codex or ChatGPT does not configure it. Keys are stored in the operating system's credential store.",
  missing: "Add an OpenAI API key to chat with Codex's Mochi.",
  placeholder: "sk-...",
  models: [
    ["gpt-6.1-sol", "GPT-6.1 Sol"],
    ["gpt-6-astra", "GPT-6 Astra"],
    ["gpt-6-luna", "GPT-6 Luna"],
  ],
  setting: "openaiModel",
  console: ["OpenAI dashboard", "https://platform.openai.com/api-keys"],
};

function chatSection(cfg: ChatSectionConfig): { el: HTMLElement; reveal(): void } {
  const dot = statusDot(false);
  const state = h("span", { class: "hint", text: "Checking the credential store…" });
  const field = h("input", {
    type: "password", placeholder: cfg.placeholder, "aria-label": `${cfg.vendor} API key`,
    style: "flex:1 1 auto;min-width:0", autocomplete: "off", spellcheck: "false",
  });
  const saveBtn = h("button", { class: "primary", text: "Save key" });
  const clearBtn = h("button", { class: "danger", text: "Remove", hidden: true });
  const testBtn = h("button", { text: "Test connection", disabled: true });
  const feedback = h("div", { role: "status", "aria-live": "polite" });
  const model = h("select", { "aria-label": `${cfg.vendor} chat model` });
  let busy = false;
  let present = false;

  function setBusy(value: boolean) {
    busy = value;
    saveBtn.disabled = clearBtn.disabled = field.disabled = model.disabled = value;
    testBtn.disabled = value || !present;
  }

  function notice(text: string, ok = false) {
    clear(feedback);
    feedback.append(h("div", { class: ok ? "notice ok" : "notice err", text }));
  }

  async function refresh() {
    try {
      present = await Bridge.secretPresent(cfg.keyName);
      dot.style.background = present ? "#22c55e" : "#f4505e";
      state.textContent = present ? "API key saved securely." : cfg.missing;
      field.placeholder = present ? "••••••••••••  (stored)" : cfg.placeholder;
      clearBtn.hidden = !present;
      testBtn.disabled = busy || !present;
      return true;
    } catch (error) {
      present = false;
      dot.style.background = "#f5a524";
      state.textContent = "Could not check the credential store.";
      notice(chatFailure(error).message);
      testBtn.disabled = true;
      return false;
    }
  }

  saveBtn.addEventListener("click", async () => {
    if (busy) return;
    const value = field.value.trim();
    if (!value) { notice(`Paste an ${cfg.vendor} API key before saving.`); return; }
    clear(feedback);
    setBusy(true);
    try {
      await Bridge.secretSet(cfg.keyName, value);
      if (await refresh()) notice("Key saved securely. You can now test the connection.", true);
    } catch (error) {
      notice(chatFailure(error).message);
    } finally {
      field.value = "";
      setBusy(false);
    }
  });

  clearBtn.addEventListener("click", async () => {
    if (busy) return;
    setBusy(true);
    clear(feedback);
    try {
      await Bridge.secretClear(cfg.keyName);
      field.value = "";
      if (await refresh()) notice("Key removed.", true);
    } catch (error) {
      notice(chatFailure(error).message);
    } finally {
      setBusy(false);
    }
  });

  testBtn.addEventListener("click", async () => {
    if (busy) return;
    if (field.value.trim()) { notice("Save the new key before testing it."); return; }
    setBusy(true);
    testBtn.textContent = "Testing…";
    clear(feedback);
    try {
      await Bridge.chatTestConnection(cfg.provider, model.value);
      notice("Connected. The saved key can access this model. No chat message was sent; billing and message generation are not tested.", true);
    } catch (error) {
      notice(chatFailure(error).message);
    } finally {
      testBtn.textContent = "Test connection";
      setBusy(false);
    }
  });

  for (const [id, label] of cfg.models) model.append(h("option", { value: id, text: label }));
  if (!cfg.models.some(([id]) => id === settings[cfg.setting])) {
    model.append(h("option", { value: settings[cfg.setting], text: settings[cfg.setting] }));
  }
  model.value = settings[cfg.setting];
  model.addEventListener("change", () => {
    settings[cfg.setting] = model.value;
    clear(feedback);
    void save();
  });

  const el = h(
    "section", { id: cfg.id },
    h("h2", {}, dot, h("span", { text: cfg.title })),
    h("div", { class: "hint", text: cfg.about }),
    state,
    h("div", { class: "row" }, h("label", { text: "API key" }), field, saveBtn, clearBtn),
    h("div", { class: "row" }, h("label", { text: "Model" }), model),
    h("div", { class: "row" }, testBtn, h("button", {
      text: cfg.console[0], onclick: () => void Bridge.openUrl(cfg.console[1]),
    })),
    h("div", { class: "hint", text: "Test connection checks the saved key and selected model without sending a chat message." }),
    feedback,
  );
  void refresh();
  return {
    el,
    reveal() {
      el.scrollIntoView({ block: "start" });
      field.focus({ preventScroll: true });
      void refresh();
    },
  };
}

// ── Integrations section ──────────────────────────────────────────────────────

interface IntegrationDef {
  id: string;
  name: string;
  color: string;
  /** Credential Manager keys, in the order they are shown. */
  fields: { key: string; label: string; placeholder: string; secret: boolean }[];
}

const INTEGRATIONS: IntegrationDef[] = [
  { id: "integration_stripe", name: "Stripe", color: "#0570DE",
    fields: [{ key: "stripe-api-key", label: "Secret key", placeholder: "sk_live_…", secret: true }] },
  { id: "integration_github", name: "GitHub", color: "#F4505E",
    fields: [{ key: "github-token", label: "Token", placeholder: "ghp_…", secret: true }] },
  { id: "integration_vercel", name: "Vercel", color: "#7C5CFF",
    fields: [{ key: "vercel-token", label: "Token", placeholder: "…", secret: true }] },
  { id: "integration_n8n", name: "n8n", color: "#F29B38",
    fields: [
      { key: "n8n-url", label: "Instance URL", placeholder: "https://n8n.example.com", secret: false },
      { key: "n8n-api-key", label: "API key", placeholder: "…", secret: true },
    ] },
  { id: "integration_resend", name: "Resend", color: "#22C55E",
    fields: [{ key: "resend-api-key", label: "API key", placeholder: "re_…", secret: true }] },
  { id: "integration_notion", name: "Notion", color: "#8C8C8C",
    fields: [{ key: "notion-api-key", label: "Integration token", placeholder: "ntn_…", secret: true }] },
  { id: "integration_calcom", name: "Cal.com", color: "#C9956A",
    fields: [{ key: "calcom-api-key", label: "API key", placeholder: "cal_…", secret: true }] },
];

const MAX_ACTIVE = 4;

function integrationsSection(present: Record<string, boolean>): HTMLElement {
  const note = h("div", { class: "hint" });
  const list = h("div", { style: "display:flex;flex-direction:column;gap:14px" });

  function updateNote() {
    const used = settings.activeIntegrations.length;
    note.textContent = `Pick up to ${MAX_ACTIVE} pills to show next to Mochi — ${used}/${MAX_ACTIVE} in use. Keys are stored in the Windows Credential Manager, never on disk.`;
  }

  for (const def of INTEGRATIONS) {
    const active = settings.activeIntegrations.includes(def.id);
    const sw = h("button", { class: active ? "switch on" : "switch" });
    sw.addEventListener("click", () => {
      const on = settings.activeIntegrations.includes(def.id);
      if (on) {
        settings.activeIntegrations = settings.activeIntegrations.filter((x) => x !== def.id);
      } else {
        if (settings.activeIntegrations.length >= MAX_ACTIVE) return;
        settings.activeIntegrations = [...settings.activeIntegrations, def.id];
      }
      sw.classList.toggle("on", !on);
      updateNote();
      void save();
    });

    const rows = h("div", { style: "display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-width:0" });
    for (const field of def.fields) {
      const input = h("input", {
        type: field.secret ? "password" : "text",
        placeholder: present[field.key] ? "••••••••  (stored)" : field.placeholder,
        autocomplete: "off",
        spellcheck: "false",
        style: "flex:1 1 auto;min-width:0",
      }) as HTMLInputElement;
      const saveBtn = h("button", { text: "Save" });
      const dotEl = statusDot(present[field.key] ?? false);
      saveBtn.addEventListener("click", async () => {
        const value = input.value.trim();
        try {
          await Bridge.secretSet(field.key, value);
          present[field.key] = value.length > 0;
          input.value = "";
          input.placeholder = value ? "••••••••  (stored)" : field.placeholder;
          dotEl.style.background = value ? "#22c55e" : "#f4505e";
        } catch {
          dotEl.style.background = "#f5a524";
        }
      });
      rows.append(
        h("div", { class: "row" },
          h("label", { style: "min-width:104px", text: field.label }),
          input, saveBtn, dotEl,
        ),
      );
    }

    list.append(
      h("div", { style: "display:flex;gap:12px;align-items:flex-start" },
        h("div", { style: "display:flex;align-items:center;gap:8px;min-width:132px;padding-top:4px" },
          sw,
          h("i", { class: "dot", style: `background:${def.color}` }),
          h("span", { style: "font-size:12.5px", text: def.name }),
        ),
        rows,
      ),
    );
  }

  updateNote();
  return h("section", {}, h("h2", {}, h("span", { text: "Integrations" })), note, list);
}

// ── General section ───────────────────────────────────────────────────────────

function generalSection(): HTMLElement {
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    value: String(settings.soundVolume),
  }) as HTMLInputElement;
  volume.addEventListener("input", () => {
    settings.soundVolume = Number(volume.value);
    void save();
  });

  const autoClose = h("input", {
    type: "number", min: "5", max: "120", step: "1",
    value: String(Math.round(settings.autoCloseInterval)),
    style: "width:72px",
  }) as HTMLInputElement;
  autoClose.addEventListener("change", () => {
    settings.autoCloseInterval = Math.max(5, Math.min(120, Number(autoClose.value) || 15));
    autoClose.value = String(settings.autoCloseInterval);
    void save();
  });

  const screen = h("select", {}) as HTMLSelectElement;
  screen.append(
    h("option", { value: "primary", text: "Main display" }),
    h("option", { value: "cursor", text: "Display under the cursor" }),
  );
  screen.value = settings.screen;
  screen.addEventListener("change", () => {
    settings.screen = screen.value as Settings["screen"];
    void save();
  });

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "General" })),
    h("div", { class: "row" },
      h("label", { text: "Sound" }),
      toggle(settings.soundEnabled, (v) => { settings.soundEnabled = v; void save(); }),
      volume,
    ),
    h("div", { class: "row" },
      h("label", { text: "Auto-close" }),
      autoClose,
      h("span", { class: "hint", text: "seconds after you leave the island" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Island lives on" }),
      screen,
    ),
    h("div", { class: "row" },
      h("label", { text: "Launch at startup" }),
      toggle(settings.autostart, (v) => { settings.autostart = v; void save(); }),
    ),
  );
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  const boot = await Bridge.boot();
  if (boot) {
    settings = { ...settings, ...boot.settings };
    version = boot.version;
  }
  const status = (await Bridge.hooksStatus()) ?? {
    installed: false, settingsPath: "", hookPath: "", hookReady: false,
  };

  const keys = [
    "stripe-api-key", "github-token", "vercel-token",
    "n8n-url", "n8n-api-key", "resend-api-key", "notion-api-key", "calcom-api-key",
  ];
  const present: Record<string, boolean> = {};
  for (const k of keys) present[k] = await Bridge.secretPresent(k).catch(() => false);

  const chats = [chatSection(CLAUDE_CHAT), chatSection(CODEX_CHAT)];
  clear(root);
  root.append(
    h("h1", {}, h("span", { text: "Coucou" }), h("span", { class: "version", text: version })),
    claudeSection(status),
    ...chats.map((chat) => chat.el),
    integrationsSection(present),
    generalSection(),
    h("div", {
      class: "hint",
      text: "No telemetry. Network requests only go to the services you configure yourself.",
    }),
  );

  // "Chat settings" in the island scrolls to the section of the Mochi that failed.
  const targets = [CLAUDE_CHAT, CODEX_CHAT];
  void onEvent<SettingsSection>("settings-section", (target) => {
    chats[targets.findIndex((cfg) => cfg.target === target)]?.reveal();
  });

  void onEvent<Settings>("settings-changed", (s) => {
    settings = { ...settings, ...s };
  });
}

void main();
