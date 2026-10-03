// Claude API client — the same integration as ClaudeService.swift: multi-turn
// chat with web search, and files sent as document/image/text blocks.
//
// Everything happens here rather than in the island: the API key never leaves
// the Credential Manager, and file bytes never cross the IPC boundary.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::secrets;

const ENDPOINT: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Server-side fallback: on a policy decline the API retries the same request on
/// a fallback model inside the same call, so the island never shows a dead end.
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
const MAX_TOKENS: u32 = 4096;
/// Text and code files are inlined; anything larger is skipped, as on macOS.
const MAX_INLINE_TEXT: u64 = 200_000;

pub const DEFAULT_MODEL: &str = "claude-opus-5";

const SYSTEM_PROMPT: &str = "You are Mochi, a personal AI assistant living at the top of the user's screen. \
You have web search access and can help with absolutely anything — research, coding, finding places, recommendations, tasks, questions. \
Respond in the user's language. Be thorough and complete — use as much detail as the task requires. \
No markdown formatting (no **, no ##, no bullet dashes). Use plain text with line breaks.";

#[derive(Default)]
pub struct Chat {
    /// Full multi-turn history, including tool_use / tool_result blocks.
    messages: Mutex<Vec<Value>>,
}

impl Chat {
    pub fn reset(&self) {
        self.messages.lock().unwrap().clear();
    }

    fn is_empty(&self) -> bool {
        self.messages.lock().unwrap().is_empty()
    }

    fn push(&self, message: Value) {
        self.messages.lock().unwrap().push(message);
    }

    fn pop(&self) {
        self.messages.lock().unwrap().pop();
    }

    fn snapshot(&self) -> Vec<Value> {
        self.messages.lock().unwrap().clone()
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChatContext {
    File { name: String, path: String },
    Window { app_name: String, title: String, url: Option<String> },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReply {
    pub text: String,
}

/// Stable error categories let the UI offer setup without inspecting error prose.
#[derive(Debug, Serialize)]
pub struct ChatError {
    pub code: &'static str,
    pub message: String,
    pub settings: bool,
}

impl ChatError {
    fn new(code: &'static str, message: impl Into<String>, settings: bool) -> Self {
        Self { code, message: message.into(), settings }
    }
}

fn api_key() -> Result<String, ChatError> {
    secrets::read("anthropic-api-key")
        .map_err(|message| ChatError::new("credential_store", message, true))?
        .ok_or_else(|| ChatError::new(
            "missing_key",
            "Mochi chat needs an Anthropic API key. Add one in Chat settings. Your Codex sign-in does not set up this separate chat.",
            true,
        ))
}

/// Validate the saved key and selected model without generating a message.
pub async fn test_connection(model: &str) -> Result<(), ChatError> {
    let key = api_key()?;
    if model.is_empty() {
        return Err(ChatError::new("model", "Choose a model in Chat settings.", true));
    }
    let mut url = reqwest::Url::parse("https://api.anthropic.com/v1/models/").unwrap();
    url.path_segments_mut().unwrap().pop_if_empty().push(model);
    let body = request(client(20)?.get(url)
        .header("x-api-key", key)
        .header("anthropic-version", ANTHROPIC_VERSION)).await?;
    if body.get("type").and_then(Value::as_str) != Some("model") {
        return Err(ChatError::new("response", "Anthropic returned an unexpected model response. Try again.", false));
    }
    Ok(())
}

/// One chat turn. Returns the assistant's text, or a message the island shows
/// in the note view.
pub async fn send(
    chat: &Chat,
    model: &str,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, ChatError> {
    let key = api_key()?;

    let mut content: Vec<Value> = Vec::new();

    // File / window context rides along with the first message only, exactly
    // like ClaudeService.chat().
    if chat.is_empty() {
        match &context {
            Some(ChatContext::File { name, path }) => {
                if let Some(block) = file_block(path) {
                    content.push(block);
                }
                content.push(json!({ "type": "text", "text": format!("File: {name}") }));
            }
            Some(ChatContext::Window { app_name, title, url }) => {
                let mut text = format!("Context — App: {app_name}, Window: {title}");
                if let Some(url) = url {
                    text.push_str(&format!(", URL: {url}"));
                }
                content.push(json!({ "type": "text", "text": text }));
            }
            None => {}
        }
    }
    content.push(json!({ "type": "text", "text": query }));

    chat.push(json!({ "role": "user", "content": content }));

    let body = json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "system": SYSTEM_PROMPT,
        "tools": [{ "type": "web_search_20260209", "name": "web_search", "max_uses": 5 }],
        "fallbacks": "default",
        "messages": chat.snapshot(),
    });

    let response = match call(&key, &body).await {
        Ok(v) => v,
        Err(err) => {
            chat.pop(); // keep the history consistent with what the model saw
            return Err(err);
        }
    };

    // A policy decline comes back as HTTP 200 with stop_reason "refusal".
    if response.get("stop_reason").and_then(Value::as_str) == Some("refusal") {
        chat.pop();
        return Err(ChatError::new("refusal", "Claude declined this request. Try rephrasing it.", false));
    }

    let Some(blocks) = response.get("content").and_then(Value::as_array).cloned() else {
        chat.pop();
        return Err(ChatError::new("response", "Anthropic returned an unexpected response. Try again.", false));
    };

    let text = blocks
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();

    if text.is_empty() {
        chat.pop();
        return Err(ChatError::new("response", "Claude returned no text. Try again.", false));
    }
    // Commit a successful turn only after there is text to show in the UI.
    chat.push(json!({ "role": "assistant", "content": blocks }));
    Ok(ChatReply { text })
}

fn client(timeout: u64) -> Result<reqwest::Client, ChatError> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| ChatError::new("network", "Could not initialize the secure connection. Restart Coucou and try again.", false))
}

async fn call(key: &str, body: &Value) -> Result<Value, ChatError> {
    request(client(90)?
        .post(ENDPOINT)
        .header("x-api-key", key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("anthropic-beta", FALLBACK_BETA)
        .header("content-type", "application/json")
        .json(body)).await
}

fn network_error(error: reqwest::Error) -> ChatError {
    if error.is_timeout() {
        ChatError::new("timeout", "Anthropic did not respond in time. Try again.", false)
    } else {
        ChatError::new("network", "Could not reach Anthropic. Check your connection, proxy, or firewall and try again.", false)
    }
}

/// Never forward arbitrary response bodies or credential values to the UI/log.
fn api_error(status: u16, body: &str) -> ChatError {
    let value: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let detail = value["error"]["message"].as_str().unwrap_or("").to_lowercase();
    match status {
        401 => ChatError::new("authentication", "Anthropic rejected the saved API key. Replace it in Chat settings.", true),
        403 => ChatError::new("permission", "This API key does not have access to the requested resource. Check its workspace and permissions.", true),
        404 => ChatError::new("model", "The selected model is unavailable for this API key. Choose another model in Chat settings.", true),
        400 | 402 if detail.contains("credit") || detail.contains("billing") || status == 402 =>
            ChatError::new("billing", "The Anthropic account needs API credits or a billing update. Check billing in the Anthropic Console.", true),
        400 => ChatError::new("request", "Anthropic could not accept this request. Check the selected model or try a shorter message.", true),
        413 => ChatError::new("request_size", "This request is too large. Try a smaller file or start a shorter conversation.", false),
        429 => ChatError::new("rate_limit", "Anthropic's rate limit was reached. Wait a moment and try again.", false),
        500..=599 => ChatError::new("service", "Anthropic is temporarily unavailable. Try again later.", false),
        _ => ChatError::new("api", format!("Anthropic returned HTTP {status}. Try again or check Chat settings."), true),
    }
}

async fn request(builder: reqwest::RequestBuilder) -> Result<Value, ChatError> {
    let response = builder.send().await.map_err(network_error)?;
    let status = response.status();
    let text = response.text().await.map_err(network_error)?;
    if !status.is_success() {
        return Err(api_error(status.as_u16(), &text));
    }
    serde_json::from_str(&text)
        .map_err(|_| ChatError::new("response", "Anthropic returned unreadable data. Try again.", false))
}

/// PDF → document block, image → image block, text/code → inline text.
/// Mirrors readFileAsBlock() in ClaudeService.swift.
fn file_block(path: &str) -> Option<Value> {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let media_type = match ext.as_str() {
        "pdf" => Some(("document", "application/pdf")),
        "jpg" | "jpeg" => Some(("image", "image/jpeg")),
        "png" => Some(("image", "image/png")),
        "gif" => Some(("image", "image/gif")),
        "webp" => Some(("image", "image/webp")),
        _ => None,
    };

    if let Some((block_type, media)) = media_type {
        let bytes = std::fs::read(path).ok()?;
        return Some(json!({
            "type": block_type,
            "source": { "type": "base64", "media_type": media, "data": base64(&bytes) },
        }));
    }

    let len = std::fs::metadata(path).ok()?.len();
    if len > MAX_INLINE_TEXT {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    Some(json!({ "type": "text", "text": format!("File contents:\n{text}") }))
}

/// Small standalone base64 encoder — not worth another dependency.
/// Also used for Stripe's basic auth.
pub(crate) fn base64_for(bytes: &[u8]) -> String {
    base64(bytes)
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_errors_are_actionable_and_do_not_echo_response_bodies() {
        for (status, code, settings) in [
            (401, "authentication", true), (403, "permission", true),
            (404, "model", true), (400, "request", true),
            (413, "request_size", false), (429, "rate_limit", false),
            (500, "service", false), (529, "service", false),
        ] {
            let error = api_error(status, r#"{"error":{"message":"sensitive-sentinel"}}"#);
            assert_eq!(error.code, code);
            assert_eq!(error.settings, settings);
            assert!(!serde_json::to_string(&error).unwrap().contains("sensitive-sentinel"));
        }
        assert_eq!(api_error(400, r#"{"error":{"message":"Your credit balance is too low"}}"#).code, "billing");
        assert_eq!(api_error(502, "<html>sensitive-sentinel</html>").code, "service");
    }

    #[test]
    fn http_errors_and_invalid_success_bodies_use_the_same_safe_path() {
        use std::io::{Read, Write};
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        for (status, body, expected) in [
            ("401 Unauthorized", r#"{"error":{"message":"sensitive-sentinel"}}"#, "authentication"),
            ("200 OK", "not json", "response"),
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buffer = [0; 4096];
                let _ = stream.read(&mut buffer).unwrap();
                write!(stream, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            });
            let error = runtime.block_on(request(client(5).unwrap().get(url))).unwrap_err();
            server.join().unwrap();
            assert_eq!(error.code, expected);
            assert!(!error.message.contains("sensitive-sentinel"));
        }
    }

    #[test]
    fn base64_matches_rfc4648_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }
}
