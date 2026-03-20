use futures::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};

use super::{ChatMessage, LlmClient, TokenStream};

pub struct AnthropicClient {
    pub api_key: String,
    pub model: String,
    pub http: Client,
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
            let mut buf = String::new();
            while let Some(chunk) = byte_stream.next().await {
                match chunk {
                    Err(e) => { yield Err(e.to_string()); break; }
                    Ok(bytes) => {
                        buf.push_str(&String::from_utf8_lossy(&bytes));
                        // Parse complete SSE lines
                        while let Some(pos) = buf.find('\n') {
                            let line = buf[..pos].trim().to_string();
                            buf = buf[pos + 1..].to_string();
                            if let Some(data) = line.strip_prefix("data: ") {
                                if data == "[DONE]" { return; }
                                if let Ok(v) = serde_json::from_str::<Value>(data) {
                                    // Anthropic delta event
                                    if v["type"] == "content_block_delta" {
                                        if let Some(text) = v["delta"]["text"].as_str() {
                                            yield Ok(text.to_string());
                                        }
                                    }
                                    if v["type"] == "message_stop" { return; }
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
