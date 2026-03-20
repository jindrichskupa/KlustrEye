use futures::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};

use super::{ChatMessage, LlmClient, TokenStream};

pub struct AnthropicClient {
    api_key: String,
    model: String,
    http: Client,
}

impl AnthropicClient {
    pub fn new(api_key: String, model: String) -> Self {
        Self {
            api_key,
            model,
            http: Client::new(),
        }
    }
}

impl LlmClient for AnthropicClient {
    async fn chat_stream(
        &self,
        messages: Vec<ChatMessage>,
        system: String,
    ) -> Result<TokenStream, String> {
        let api_messages: Vec<Value> = messages
            .iter()
            .map(|m| json!({ "role": m.role, "content": m.content }))
            .collect();

        let resp = self
            .http
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&json!({
                "model": self.model,
                "max_tokens": 4096,
                "system": system,
                "messages": api_messages,
                "stream": true,
            }))
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Anthropic error {status}: {body}"));
        }

        let byte_stream = resp.bytes_stream();
        let stream = async_stream::stream! {
            let mut byte_stream = byte_stream;
            // Fix #1: use a Vec<u8> byte buffer to avoid splitting mid-UTF-8 codepoints
            let mut buf: Vec<u8> = Vec::new();
            // Fix #3: track the current SSE event type for error handling
            let mut current_event: Option<String> = None;
            while let Some(chunk) = byte_stream.next().await {
                match chunk {
                    Err(e) => { yield Err(e.to_string()); break; }
                    Ok(bytes) => {
                        buf.extend_from_slice(&bytes);
                        // Parse complete SSE lines from the byte buffer
                        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                            // Convert only a complete line — safe, no mid-codepoint splits
                            let line = String::from_utf8_lossy(&buf[..pos]).trim().to_string();
                            // Fix #5: drain instead of reallocating
                            buf.drain(..pos + 1);

                            // Fix #3: track event type
                            if let Some(event_type) = line.strip_prefix("event: ") {
                                current_event = Some(event_type.to_string());
                                continue;
                            }

                            if let Some(data) = line.strip_prefix("data: ") {
                                // Fix #3: handle Anthropic mid-stream error events
                                if current_event.as_deref() == Some("error") {
                                    yield Err(data.to_string());
                                    return;
                                }
                                current_event = None;

                                // Fix #2: removed OpenAI-only "[DONE]" sentinel

                                // Fix #4: log malformed JSON instead of silently dropping
                                match serde_json::from_str::<Value>(data) {
                                    Ok(v) => {
                                        // Anthropic delta event
                                        if v["type"] == "content_block_delta" {
                                            if let Some(text) = v["delta"]["text"].as_str() {
                                                yield Ok(text.to_string());
                                            }
                                        }
                                        if v["type"] == "message_stop" { return; }
                                    }
                                    Err(e) => {
                                        tracing::warn!(
                                            "Anthropic SSE: failed to parse JSON: {e} (data={data:?})"
                                        );
                                    }
                                }
                            } else {
                                // Non-data, non-event line (blank lines, comments) — reset event
                                if line.is_empty() {
                                    current_event = None;
                                }
                            }
                        }
                    }
                }
            }
        };

        Ok(Box::pin(stream))
    }
}
