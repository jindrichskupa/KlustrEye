use futures::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};

use super::{ChatMessage, LlmClient, TokenStream};

pub struct OllamaClient {
    base_url: String,
    model: String,
    http: Client,
}

impl OllamaClient {
    pub fn new(base_url: String, model: String) -> Self {
        Self {
            base_url,
            model,
            http: Client::new(),
        }
    }

    pub fn chat_url(&self) -> String {
        format!("{}/api/chat", self.base_url.trim_end_matches('/'))
    }
}

impl LlmClient for OllamaClient {
    async fn chat_stream(
        &self,
        messages: Vec<ChatMessage>,
        system: String,
    ) -> Result<TokenStream, String> {
        let mut api_messages: Vec<Value> = Vec::with_capacity(messages.len() + 1);
        api_messages.push(json!({ "role": "system", "content": system }));
        for m in &messages {
            api_messages.push(json!({ "role": m.role, "content": m.content }));
        }

        let resp = self
            .http
            .post(self.chat_url())
            .header("Content-Type", "application/json")
            .json(&json!({
                "model": self.model,
                "stream": true,
                "messages": api_messages,
            }))
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Ollama error {status}: {body}"));
        }

        let byte_stream = resp.bytes_stream();
        let stream = async_stream::stream! {
            let mut byte_stream = byte_stream;
            // Ollama uses newline-delimited JSON (not SSE), but we still use a byte
            // buffer for UTF-8 safety — same pattern as the Anthropic client.
            let mut buf: Vec<u8> = Vec::new();
            while let Some(chunk) = byte_stream.next().await {
                match chunk {
                    Err(e) => { yield Err(e.to_string()); break; }
                    Ok(bytes) => {
                        buf.extend_from_slice(&bytes);
                        // Each complete JSON object is terminated by a newline.
                        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                            let line = String::from_utf8_lossy(&buf[..pos]).trim().to_string();
                            buf.drain(..pos + 1);

                            if line.is_empty() {
                                continue;
                            }

                            match serde_json::from_str::<Value>(&line) {
                                Ok(v) => {
                                    if let Some(text) = v["message"]["content"].as_str() {
                                        if !text.is_empty() {
                                            yield Ok(text.to_string());
                                        }
                                    }
                                    // done == true signals end of stream
                                    if v["done"].as_bool().unwrap_or(false) {
                                        return;
                                    }
                                }
                                Err(e) => {
                                    tracing::warn!(
                                        "Ollama NDJSON: failed to parse JSON: {e} (line={line:?})"
                                    );
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ollama_url_construction() {
        let client = OllamaClient::new("http://localhost:11434".into(), "llama3".into());
        assert_eq!(client.chat_url(), "http://localhost:11434/api/chat");
    }

    #[test]
    fn test_ollama_url_trailing_slash() {
        let client = OllamaClient::new("http://localhost:11434/".into(), "llama3".into());
        assert_eq!(client.chat_url(), "http://localhost:11434/api/chat");
    }

    #[test]
    fn test_ollama_url_custom_host() {
        let client = OllamaClient::new("http://192.168.1.100:11434".into(), "mistral".into());
        assert_eq!(client.chat_url(), "http://192.168.1.100:11434/api/chat");
    }
}
