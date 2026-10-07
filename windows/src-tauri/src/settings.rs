// Preferences, stored as plain JSON in settings.json under platform::config_dir().
// No secret ever lands here — API keys live in the OS keychain (see secrets.rs).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub sound_enabled: bool,
    pub sound_volume: f64,
    pub auto_close_interval: f64,
    pub absence_interval: f64,
    pub active_integrations: Vec<String>,
    /// "primary" = the main display, "cursor" = whichever display the mouse is on.
    pub screen: String,
    pub autostart: bool,
    pub hooks_installed: bool,
    /// Claude model used by the chat. Changeable in the settings window.
    /// Defaulted explicitly so a settings.json written by an older build still loads.
    #[serde(default = "default_model")]
    pub model: String,
    /// OpenAI model used by Codex's Mochi (the chat while the Codex pill is focused).
    #[serde(default = "default_openai_model")]
    pub openai_model: String,
    /// How Codex's Mochi signs in: "codex" (the Codex CLI's own sign-in, so a
    /// ChatGPT plan) or "apiKey" (an OpenAI API key in the credential store).
    #[serde(default = "default_openai_auth")]
    pub openai_auth: String,
    /// How Claude's Mochi signs in: "claudeCode" (Claude Code's own sign-in, so
    /// a Claude plan) or "apiKey" (an Anthropic API key in the credential store).
    #[serde(default = "default_anthropic_auth")]
    pub anthropic_auth: String,
    /// Mochi's outfit, picked in the island's wardrobe: an outfit name, or
    /// "auto" to follow the seasons.
    #[serde(default = "default_mochi_outfit")]
    pub mochi_outfit: String,
    /// Keep the local history the weekly recap is made from.
    #[serde(default = "default_true")]
    pub recap_enabled: bool,
    /// Leave project names out of the recap's share image.
    #[serde(default)]
    pub recap_hide_projects: bool,
}

fn default_true() -> bool {
    true
}

fn default_model() -> String {
    crate::claude::DEFAULT_MODEL.to_string()
}

fn default_openai_model() -> String {
    crate::openai::DEFAULT_MODEL.to_string()
}

fn default_openai_auth() -> String {
    "codex".to_string()
}

fn default_anthropic_auth() -> String {
    "claudeCode".to_string()
}

fn default_mochi_outfit() -> String {
    "auto".to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            sound_enabled: true,
            sound_volume: 0.12,
            auto_close_interval: 15.0,
            absence_interval: 180.0,
            active_integrations: vec![
                "integration_resend".into(),
                "integration_n8n".into(),
                "integration_vercel".into(),
                "integration_github".into(),
            ],
            screen: "primary".into(),
            autostart: false,
            hooks_installed: false,
            model: default_model(),
            openai_model: default_openai_model(),
            openai_auth: default_openai_auth(),
            anthropic_auth: default_anthropic_auth(),
            mochi_outfit: default_mochi_outfit(),
            recap_enabled: true,
            recap_hide_projects: false,
        }
    }
}

pub use crate::platform::{config_dir, local_dir};

pub fn hook_exe_path() -> PathBuf {
    local_dir().join("bin").join(crate::platform::HOOK_EXE)
}

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

pub fn load() -> Settings {
    match std::fs::read(settings_path()) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

pub fn save(settings: &Settings) -> std::io::Result<()> {
    let dir = config_dir();
    crate::platform::ensure_private_dir(&dir)?;
    let json = serde_json::to_vec_pretty(settings)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(settings_path(), json)
}
