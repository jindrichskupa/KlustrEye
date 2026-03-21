use futures::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};

use super::{ChatMessage, LlmClient, TokenStream};

pub struct AzureOpenAiClient {
    endpoint: String,
    api_key: String,
    deployment_name: String,
    http: Client,
}

impl AzureOpenAiClient {
    pub fn new(endpoint: String, api_key: String, deployment_name: String) -> Self {
        Self {
            endpoint,
            api_key,
            deployment_name,
            http: Client::new(),
        }
    }

    pub fn chat_url(&self) -> String {
        format!(
            "{}/openai/deployments/{}/chat/completions?api-version=2024-02-01",
            self.endpoint.trim_end_matches('/'),
            self.deployment_name
        )
    }
}

impl LlmClient for AzureOpenAiClient {
    async fn chat_stream(
        &self,
        messages: Vec<ChatMessage>,
        system: String,
    ) -> Result<TokenStream, String> {
        let mut api_messages: Vec<Value> = Vec::with_capacity(messages.len() + 1);
        // Azure OpenAI uses the same format as OpenAI: system is first message
        api_messages.push(json!({ "role": "system", "content": system }));
        for m in &messages {
            api_messages.push(json!({ "role": m.role, "content": m.content }));
        }

        let resp = self
            .http
            .post(self.chat_url())
            .header("api-key", &self.api_key)
            .header("Content-Type", "application/json")
            .json(&json!({
                "stream": true,
                "messages": api_messages,
            }))
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Azure OpenAI error {status}: {body}"));
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
                                // OpenAI-compatible stream terminator
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
                                            "Azure OpenAI SSE: failed to parse JSON: {e} (data={data:?})"
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
    fn test_azure_url_construction() {
        let client = AzureOpenAiClient::new(
            "https://myresource.openai.azure.com".into(),
            "key".into(),
            "gpt-4o-deploy".into(),
        );
        assert_eq!(
            client.chat_url(),
            "https://myresource.openai.azure.com/openai/deployments/gpt-4o-deploy/chat/completions?api-version=2024-02-01"
        );
    }

    #[test]
    fn test_azure_url_trailing_slash() {
        let client = AzureOpenAiClient::new(
            "https://myresource.openai.azure.com/".into(),
            "key".into(),
            "deploy".into(),
        );
        assert!(client.chat_url().starts_with("https://myresource.openai.azure.com/openai/"));
    }

    #[test]
    fn test_azure_url_contains_api_version() {
        let client = AzureOpenAiClient::new(
            "https://myresource.openai.azure.com".into(),
            "key".into(),
            "my-deployment".into(),
        );
        assert!(client.chat_url().contains("api-version=2024-02-01"));
    }

    #[test]
    fn test_azure_url_contains_deployment_name() {
        let client = AzureOpenAiClient::new(
            "https://myresource.openai.azure.com".into(),
            "key".into(),
            "my-custom-deploy".into(),
        );
        assert!(client.chat_url().contains("my-custom-deploy"));
    }
}
