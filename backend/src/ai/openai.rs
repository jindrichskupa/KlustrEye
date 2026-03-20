use futures::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};

use super::{ChatMessage, LlmClient, TokenStream};

pub struct OpenAiClient {
    api_key: String,
    model: String,
    http: Client,
}

impl OpenAiClient {
    pub fn new(api_key: String, model: String) -> Self {
        Self {
            api_key,
            model,
            http: Client::new(),
        }
    }

    pub fn build_body(&self, messages: &[ChatMessage], system: &str) -> Value {
        let mut api_messages: Vec<Value> = Vec::with_capacity(messages.len() + 1);
        // OpenAI system prompt is the first message with role "system"
        api_messages.push(json!({ "role": "system", "content": system }));
        for m in messages {
            api_messages.push(json!({ "role": m.role, "content": m.content }));
        }
        json!({
            "model": self.model,
            "stream": true,
            "messages": api_messages,
        })
    }
}

impl LlmClient for OpenAiClient {
    async fn chat_stream(
        &self,
        messages: Vec<ChatMessage>,
        system: String,
    ) -> Result<TokenStream, String> {
        let body = self.build_body(&messages, &system);

        let resp = self
            .http
            .post("https://api.openai.com/v1/chat/completions")
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("OpenAI error {status}: {body}"));
        }

        let byte_stream = resp.bytes_stream();
        let stream = async_stream::stream! {
            let mut byte_stream = byte_stream;
            let mut buf: Vec<u8> = Vec::new();
            while let Some(chunk) = byte_stream.next().await {
                match chunk {
                    Err(e) => { yield Err(e.to_string()); break; }
                    Ok(bytes) => {
                        buf.extend_from_slice(&bytes);
                        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                            let line = String::from_utf8_lossy(&buf[..pos]).trim().to_string();
                            buf.drain(..pos + 1);

                            if let Some(data) = line.strip_prefix("data: ") {
                                // OpenAI stream terminator
                                if data == "[DONE]" {
                                    return;
                                }

                                match serde_json::from_str::<Value>(data) {
                                    Ok(v) => {
                                        if let Some(text) = v["choices"][0]["delta"]["content"].as_str() {
                                            if !text.is_empty() {
                                                yield Ok(text.to_string());
                                            }
                                        }
                                    }
                                    Err(e) => {
                                        tracing::warn!(
                                            "OpenAI SSE: failed to parse JSON: {e} (data={data:?})"
                                        );
                                    }
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
    fn test_system_prepended_to_messages() {
        let client = OpenAiClient::new("key".into(), "gpt-4o".into());
        let messages = vec![ChatMessage {
            role: "user".into(),
            content: "hi".into(),
        }];
        let system = "You are a Kubernetes expert.".to_string();
        let body = client.build_body(&messages, &system);
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[0]["content"], "You are a Kubernetes expert.");
    }

    #[test]
    fn test_user_message_follows_system() {
        let client = OpenAiClient::new("key".into(), "gpt-4o".into());
        let messages = vec![ChatMessage {
            role: "user".into(),
            content: "hi".into(),
        }];
        let body = client.build_body(&messages, "system prompt");
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[1]["role"], "user");
        assert_eq!(msgs[1]["content"], "hi");
    }

    #[test]
    fn test_stream_flag_set() {
        let client = OpenAiClient::new("key".into(), "gpt-4o".into());
        let body = client.build_body(&[], "system");
        assert_eq!(body["stream"], true);
    }

    #[test]
    fn test_model_in_body() {
        let client = OpenAiClient::new("key".into(), "gpt-4o-mini".into());
        let body = client.build_body(&[], "system");
        assert_eq!(body["model"], "gpt-4o-mini");
    }
}
