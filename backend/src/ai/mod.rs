pub mod anthropic;
pub mod azure;
pub mod ollama;
pub mod openai;

use futures::Stream;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::pin::Pin;

pub type TokenStream = Pin<Box<dyn Stream<Item = Result<String, String>> + Send>>;

pub trait LlmClient: Send + Sync {
    fn chat_stream(
        &self,
        messages: Vec<ChatMessage>,
        system: String,
    ) -> impl std::future::Future<Output = Result<TokenStream, String>> + Send;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,   // "user" | "assistant"
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct AiConfig {
    pub provider: String,
    pub api_key: String,
    pub model: String,
    pub base_url: String,
    pub deployment_name: String,
}

pub async fn load_config(db: &SqlitePool) -> Option<AiConfig> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT key, value FROM user_preferences WHERE key IN
         ('ai_provider','ai_api_key','ai_model','ai_base_url','ai_deployment_name')",
    )
    .fetch_all(db)
    .await
    .ok()?;

    let map: std::collections::HashMap<String, String> = rows.into_iter().collect();
    let provider = map.get("ai_provider")?.clone();
    if provider.is_empty() {
        return None;
    }

    Some(AiConfig {
        provider,
        api_key: map.get("ai_api_key").cloned().unwrap_or_default(),
        model: map.get("ai_model").cloned().unwrap_or_default(),
        base_url: map.get("ai_base_url").cloned().unwrap_or_default(),
        deployment_name: map.get("ai_deployment_name").cloned().unwrap_or_default(),
    })
}

pub fn build_system_prompt(context: &AiContext) -> String {
    let mut prompt = String::from(
        "You are an expert Kubernetes assistant embedded in KlustrEye, a Kubernetes IDE.\n\
         You help with YAML generation, resource explanation, error diagnosis, and Kubernetes best practices.\n\
         Be concise and practical. When generating YAML, output only valid YAML in a fenced code block.\n"
    );

    prompt.push_str("\nCurrent context:\n");
    if let Some(cluster) = &context.cluster {
        prompt.push_str(&format!("- Cluster: {}\n", cluster));
    }
    if let Some(ns) = &context.namespace {
        prompt.push_str(&format!("- Namespace: {}\n", ns));
    }
    if let Some(kind) = &context.resource_kind {
        let name = context.resource_name.as_deref().unwrap_or("unknown");
        prompt.push_str(&format!("- Resource: {}/{}\n", kind, name));
    }
    if let Some(yaml) = &context.resource_yaml {
        prompt.push_str(&format!("\nResource YAML:\n```yaml\n{}\n```\n", yaml));
    }
    if let Some(logs) = &context.log_lines {
        prompt.push_str(&format!("\nLogs:\n```\n{}\n```\n", logs));
    }
    if let Some(events) = &context.events {
        prompt.push_str(&format!("\nEvents:\n{}\n", events));
    }

    prompt
}

pub fn truncate(s: &str, max_chars: usize, yaml: bool) -> String {
    // Use char count, not byte count, to avoid panics on multibyte characters
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let truncated: String = s.chars().take(max_chars).collect();
    if yaml {
        format!("{}\n# [truncated]", truncated)
    } else {
        format!("{}\n[truncated]", truncated)
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct AiContext {
    pub cluster: Option<String>,
    pub namespace: Option<String>,
    pub resource_kind: Option<String>,
    pub resource_name: Option<String>,
    pub resource_yaml: Option<String>,
    pub log_lines: Option<String>,
    pub events: Option<String>,
}

impl AiContext {
    pub fn truncated(mut self) -> Self {
        self.resource_yaml = self.resource_yaml.map(|s| truncate(&s, 4000, true));
        self.log_lines = self.log_lines.map(|s| truncate(&s, 4000, false));
        self.events = self.events.map(|s| truncate(&s, 2000, false));
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_short_content_unchanged() {
        assert_eq!(truncate("hello", 100, false), "hello");
    }

    #[test]
    fn truncate_long_content_adds_marker() {
        let long = "a".repeat(5000);
        let result = truncate(&long, 4000, false);
        assert!(result.ends_with("\n[truncated]"));
        assert!(result.len() < 5100);
    }

    #[test]
    fn truncate_yaml_adds_comment_marker() {
        let long = "a".repeat(5000);
        let result = truncate(&long, 4000, true);
        assert!(result.ends_with("\n# [truncated]"));
    }

    #[test]
    fn build_system_prompt_includes_context() {
        let ctx = AiContext {
            cluster: Some("prod".into()),
            namespace: Some("default".into()),
            resource_kind: Some("Deployment".into()),
            resource_name: Some("nginx".into()),
            resource_yaml: None,
            log_lines: None,
            events: None,
        };
        let prompt = build_system_prompt(&ctx);
        assert!(prompt.contains("prod"));
        assert!(prompt.contains("default"));
        assert!(prompt.contains("Deployment/nginx"));
    }

    #[test]
    fn truncate_multibyte_chars_no_panic() {
        // Emoji are 4 bytes each; slicing mid-emoji would panic with byte indexing
        let emoji_str = "😀".repeat(2000);
        let result = truncate(&emoji_str, 100, false);
        assert!(result.ends_with("\n[truncated]"));
        // Should not panic
    }
}
