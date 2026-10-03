// OpenAI client for Codex's Mochi — the counterpart of claude.rs: multi-turn
// chat with web search through the Responses API, and files sent as
// file/image/text inputs.
//
// The key never leaves the credential store and file bytes never cross the IPC
// boundary. `store: false` keeps conversations off OpenAI's servers: the
// history lives here and is sent again with every turn.

use serde_json::{json, Value};

use crate::claude::{self, Chat, ChatContext, ChatError, ChatReply};
use crate::secrets;

const ENDPOINT: &str = "https://api.openai.com/v1/responses";
const MODELS_ENDPOINT: &str = "https://api.openai.com/v1/models/";
/// Reasoning tokens count against this budget too, so it is larger than the
/// Anthropic `max_tokens`.
const MAX_OUTPUT_TOKENS: u32 = 16_384;

pub const DEFAULT_MODEL: &str = "gpt-6.1-sol";

/// Billing problems arrive as HTTP 429, like rate limits; only the code tells
/// them apart. `insufficient_quota` can also be the error type.
const BILLING_CODES: &[&str] = &[
    "insufficient_quota",
    "credit_balance_exhausted",
    "organization_spend_limit_exceeded",
    "project_spend_limit_exceeded",
    "organization_usage_limit_exceeded",
];

fn api_key() -> Result<String, ChatError> {
    secrets::read("openai-api-key")
        .map_err(|message| ChatError::new("credential_store", message, true))?
        .ok_or_else(|| ChatError::new(
            "missing_key",
            "Codex's Mochi needs an OpenAI API key. Add one in Codex's Mochi settings. Your Codex or ChatGPT sign-in does not set up this chat.",
            true,
        ))
}

/// Validate the saved key and selected model without generating a message.
pub async fn test_connection(model: &str) -> Result<(), ChatError> {
    let key = api_key()?;
    if model.is_empty() {
        return Err(ChatError::new("model", "Choose a model in Codex's Mochi settings.", true));
    }
    let mut url = reqwest::Url::parse(MODELS_ENDPOINT).unwrap();
    url.path_segments_mut().unwrap().pop_if_empty().push(model);
    let body = request(claude::client(20)?.get(url).bearer_auth(key)).await?;
    if body.get("object").and_then(Value::as_str) != Some("model") {
        return Err(ChatError::new("response", "OpenAI returned an unexpected model response. Try again.", false));
    }
    Ok(())
}

/// One chat turn with Codex's Mochi.
pub async fn send(
    chat: &Chat,
    model: &str,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, ChatError> {
    let key = api_key()?;

    let mut content: Vec<Value> = Vec::new();
    // Context rides along with the first message only, as in claude.rs.
    if chat.is_empty() {
        match &context {
            Some(ChatContext::File { name, path }) => {
                if let Some(part) = file_part(name, path) {
                    content.push(part);
                }
                content.push(json!({ "type": "input_text", "text": format!("File: {name}") }));
            }
            Some(ChatContext::Window { app_name, title, url }) => {
                let mut text = format!("Context — App: {app_name}, Window: {title}");
                if let Some(url) = url {
                    text.push_str(&format!(", URL: {url}"));
                }
                content.push(json!({ "type": "input_text", "text": text }));
            }
            None => {}
        }
    }
    content.push(json!({ "type": "input_text", "text": query }));

    let (generation, input) = chat.begin(json!({ "role": "user", "content": content }));
    let result = match call(&key, &request_body(model, input)).await {
        Ok(response) => reply_text(&response),
        Err(err) => Err(err),
    };
    match result {
        Ok(text) => {
            chat.finish(generation, Some(json!({ "role": "assistant", "content": text })));
            Ok(ChatReply { text })
        }
        Err(err) => {
            chat.finish(generation, None); // keep the history consistent with what the model saw
            Err(err)
        }
    }
}

fn request_body(model: &str, input: Vec<Value>) -> Value {
    json!({
        "model": model,
        "instructions": claude::SYSTEM_PROMPT,
        "input": input,
        "tools": [{ "type": "web_search" }],
        "max_output_tokens": MAX_OUTPUT_TOKENS,
        "store": false,
    })
}

/// The reply's text, or a specific reason why there is none.
fn reply_text(response: &Value) -> Result<String, ChatError> {
    let mut parts: Vec<&str> = Vec::new();
    let mut refused = false;
    for item in response.get("output").and_then(Value::as_array).into_iter().flatten() {
        if item.get("type").and_then(Value::as_str) != Some("message") {
            continue; // web_search_call, reasoning…
        }
        for part in item.get("content").and_then(Value::as_array).into_iter().flatten() {
            match part.get("type").and_then(Value::as_str) {
                Some("output_text") => parts.extend(part.get("text").and_then(Value::as_str)),
                Some("refusal") => refused = true,
                _ => {}
            }
        }
    }
    let text = parts.join("\n").trim().to_string();
    if !text.is_empty() {
        return Ok(text);
    }
    let reason = response["incomplete_details"]["reason"].as_str();
    if refused || reason == Some("content_filter") {
        return Err(ChatError::new("refusal", "OpenAI declined this request. Try rephrasing it.", false));
    }
    if reason == Some("max_output_tokens") {
        return Err(ChatError::new("response", "OpenAI used its whole output budget before replying. Try a narrower question.", false));
    }
    if response.get("status").and_then(Value::as_str) == Some("failed") {
        return Err(ChatError::new("service", "OpenAI could not finish this reply. Try again.", false));
    }
    if response.get("output").and_then(Value::as_array).is_none() {
        return Err(ChatError::new("response", "OpenAI returned an unexpected response. Try again.", false));
    }
    Err(ChatError::new("response", "OpenAI returned no text. Try again.", false))
}

async fn call(key: &str, body: &Value) -> Result<Value, ChatError> {
    // Reasoning plus web search can take longer than a plain Claude turn.
    request(claude::client(120)?.post(ENDPOINT).bearer_auth(key).json(body)).await
}

fn network_error(error: reqwest::Error) -> ChatError {
    if error.is_timeout() {
        ChatError::new("timeout", "OpenAI did not respond in time. Try again.", false)
    } else {
        ChatError::new("network", "Could not reach OpenAI. Check your connection, proxy, or firewall and try again.", false)
    }
}

/// Never forward arbitrary response bodies or credential values to the UI/log.
fn api_error(status: u16, body: &str) -> ChatError {
    let value: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let code = value["error"]["code"].as_str().unwrap_or("");
    let kind = value["error"]["type"].as_str().unwrap_or("");
    let billing = BILLING_CODES.contains(&code) || kind == "insufficient_quota";
    match status {
        401 => ChatError::new("authentication", "OpenAI rejected the saved API key. Replace it in Codex's Mochi settings.", true),
        403 => ChatError::new("permission", "This OpenAI API key cannot use this model or service from here. Check the project's permissions and supported regions.", true),
        404 => ChatError::new("model", "The selected OpenAI model is unavailable for this API key. Choose another model in Codex's Mochi settings.", true),
        400 if code == "model_not_found" =>
            ChatError::new("model", "The selected OpenAI model is unavailable for this API key. Choose another model in Codex's Mochi settings.", true),
        429 if billing =>
            ChatError::new("billing", "The OpenAI account needs credits or a higher spend limit. Check billing in the OpenAI dashboard.", true),
        400 => ChatError::new("request", "OpenAI could not accept this request. Check the selected model or try a shorter message.", true),
        413 => ChatError::new("request_size", "This request is too large. Try a smaller file or start a shorter conversation.", false),
        429 => ChatError::new("rate_limit", "OpenAI's rate limit was reached. Wait a moment and try again.", false),
        500..=599 => ChatError::new("service", "OpenAI is temporarily unavailable. Try again later.", false),
        _ => ChatError::new("api", format!("OpenAI returned HTTP {status}. Try again or check Codex's Mochi settings."), true),
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
        .map_err(|_| ChatError::new("response", "OpenAI returned unreadable data. Try again.", false))
}

/// PDF → file input, image → image input, text/code → inline text: the same
/// split as claude.rs, in the Responses API's shapes.
fn file_part(name: &str, path: &str) -> Option<Value> {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let image = match ext.as_str() {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    };
    if let Some(media) = image {
        let bytes = std::fs::read(path).ok()?;
        return Some(json!({
            "type": "input_image",
            "image_url": format!("data:{media};base64,{}", claude::base64_for(&bytes)),
            "detail": "auto",
        }));
    }
    if ext == "pdf" {
        let bytes = std::fs::read(path).ok()?;
        return Some(json!({
            "type": "input_file",
            "filename": name,
            "file_data": format!("data:application/pdf;base64,{}", claude::base64_for(&bytes)),
        }));
    }

    let len = std::fs::metadata(path).ok()?.len();
    if len > claude::MAX_INLINE_TEXT {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    Some(json!({ "type": "input_text", "text": format!("File contents:\n{text}") }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_errors_are_actionable_and_do_not_echo_response_bodies() {
        let body = |code: &str, kind: &str| {
            format!(r#"{{"error":{{"message":"sensitive-sentinel","code":"{code}","type":"{kind}"}}}}"#)
        };
        for (status, code, kind, expected, settings) in [
            (401, "invalid_api_key", "invalid_request_error", "authentication", true),
            (403, "unsupported_country_region_territory", "request_forbidden", "permission", true),
            (404, "model_not_found", "invalid_request_error", "model", true),
            (400, "model_not_found", "invalid_request_error", "model", true),
            (400, "invalid_value", "invalid_request_error", "request", true),
            (413, "", "", "request_size", false),
            (429, "rate_limit_exceeded", "requests", "rate_limit", false),
            (429, "slow_down", "rate_limit_error", "rate_limit", false),
            (429, "credit_balance_exhausted", "insufficient_quota", "billing", true),
            (429, "project_spend_limit_exceeded", "insufficient_quota", "billing", true),
            (429, "insufficient_quota", "insufficient_quota", "billing", true),
            (500, "", "server_error", "service", false),
            (503, "server_is_overloaded", "service_unavailable", "service", false),
        ] {
            let error = api_error(status, &body(code, kind));
            assert_eq!(error.code, expected, "{status} {code}");
            assert_eq!(error.settings, settings, "{status} {code}");
            assert!(!serde_json::to_string(&error).unwrap().contains("sensitive-sentinel"));
        }
        assert_eq!(api_error(502, "<html>sensitive-sentinel</html>").code, "service");
    }

    #[test]
    fn requests_keep_history_local_and_enable_web_search() {
        let body = request_body("gpt-test", vec![json!({ "role": "user", "content": "hi" })]);
        assert_eq!(body["model"], "gpt-test");
        assert_eq!(body["store"], false);
        assert_eq!(body["tools"], json!([{ "type": "web_search" }]));
        assert_eq!(body["instructions"], claude::SYSTEM_PROMPT);
        assert_eq!(body["input"][0]["content"], "hi");
    }

    #[test]
    fn replies_skip_tool_items_and_explain_missing_text() {
        let reply = json!({ "status": "completed", "output": [
            { "type": "web_search_call", "status": "completed" },
            { "type": "message", "role": "assistant", "content": [
                { "type": "output_text", "text": "First part", "annotations": [] },
                { "type": "output_text", "text": "second part." },
            ] },
        ] });
        assert_eq!(reply_text(&reply).unwrap(), "First part\nsecond part.");

        let refusal = json!({ "status": "completed", "output": [
            { "type": "message", "content": [{ "type": "refusal", "refusal": "no" }] },
        ] });
        assert_eq!(reply_text(&refusal).unwrap_err().code, "refusal");

        let truncated = json!({ "status": "incomplete",
            "incomplete_details": { "reason": "max_output_tokens" }, "output": [{ "type": "reasoning" }] });
        assert_eq!(reply_text(&truncated).unwrap_err().code, "response");

        let partial = json!({ "status": "incomplete", "incomplete_details": { "reason": "max_output_tokens" },
            "output": [{ "type": "message", "content": [{ "type": "output_text", "text": "Partial" }] }] });
        assert_eq!(reply_text(&partial).unwrap(), "Partial");

        let failed = json!({ "status": "failed", "error": { "message": "x" }, "output": [] });
        assert_eq!(reply_text(&failed).unwrap_err().code, "service");
        assert_eq!(reply_text(&json!({ "unexpected": true })).unwrap_err().code, "response");
    }

    #[test]
    fn files_use_the_responses_input_shapes() {
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("coucou-openai-{unique}"));
        std::fs::create_dir(&dir).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
        }
        let _cleanup = Cleanup(dir.clone());
        let write = |name: &str, bytes: &[u8]| {
            let path = dir.join(name);
            std::fs::write(&path, bytes).unwrap();
            path.to_string_lossy().to_string()
        };

        let pdf = file_part("Report.pdf", &write("report.pdf", b"%PDF-1.4")).unwrap();
        assert_eq!(pdf["type"], "input_file");
        assert_eq!(pdf["filename"], "Report.pdf");
        assert_eq!(pdf["file_data"], "data:application/pdf;base64,JVBERi0xLjQ=");

        let png = file_part("shot.png", &write("shot.PNG", b"png")).unwrap();
        assert_eq!(png["type"], "input_image");
        assert_eq!(png["image_url"], "data:image/png;base64,cG5n");

        let text = file_part("notes.md", &write("notes.md", b"hello")).unwrap();
        assert_eq!(text, json!({ "type": "input_text", "text": "File contents:\nhello" }));

        let large = vec![b'a'; claude::MAX_INLINE_TEXT as usize + 1];
        assert!(file_part("large.txt", &write("large.txt", &large)).is_none());
        assert!(file_part("missing.pdf", &dir.join("missing.pdf").to_string_lossy()).is_none());
    }

    #[test]
    fn http_errors_and_invalid_success_bodies_use_the_same_safe_path() {
        use std::io::{Read, Write};
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        for (status, body, expected) in [
            ("401 Unauthorized", r#"{"error":{"message":"sensitive-sentinel","code":"invalid_api_key"}}"#, "authentication"),
            ("429 Too Many Requests", r#"{"error":{"message":"sensitive-sentinel","code":"credit_balance_exhausted","type":"insufficient_quota"}}"#, "billing"),
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
            let error = runtime.block_on(request(claude::client(5).unwrap().get(url).bearer_auth("test"))).unwrap_err();
            server.join().unwrap();
            assert_eq!(error.code, expected);
            assert!(!error.message.contains("sensitive-sentinel"));
        }
    }
}
