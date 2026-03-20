use axum::{
    body::Body,
    extract::State,
    http::{header, StatusCode},
    response::Response,
    Json,
};
use bytes::Bytes;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    ai::{
        anthropic::AnthropicClient, azure::AzureOpenAiClient, ollama::OllamaClient,
        openai::OpenAiClient, AiContext, ChatMessage, LlmClient, build_system_prompt, load_config,
    },
    error::Result,
    AppState,
};

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ChatRequest {
    pub messages: Vec<AiMessage>,
    pub context: Option<AiRequestContext>,
}

#[derive(Deserialize, Serialize)]
pub struct AiMessage {
    pub role: String,
    pub content: String,
}

#[derive(Deserialize)]
pub struct AiRequestContext {
    pub cluster: Option<String>,
    pub namespace: Option<String>,
    pub resource_kind: Option<String>,
    pub resource_name: Option<String>,
    pub resource_yaml: Option<String>,
    pub log_lines: Option<String>,
    pub events: Option<String>,
}

#[derive(Serialize)]
pub struct AiStatusResponse {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub configured: bool,
}

#[derive(Deserialize)]
pub struct SaveAiSettingsRequest {
    pub provider: String,
    pub model: String,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub deployment_name: Option<String>,
}

// ---------------------------------------------------------------------------
// Handler 1: GET /api/ai/settings/status
// ---------------------------------------------------------------------------

pub async fn get_ai_status(
    State(state): State<AppState>,
) -> Result<Json<AiStatusResponse>> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT key, value FROM user_preferences WHERE key IN \
         ('ai_provider','ai_model','ai_api_key')",
    )
    .fetch_all(&state.db)
    .await?;

    let map: std::collections::HashMap<String, String> = rows.into_iter().collect();

    let provider = map.get("ai_provider").filter(|v| !v.is_empty()).cloned();
    let model = map.get("ai_model").filter(|v| !v.is_empty()).cloned();
    let api_key_is_set = map
        .get("ai_api_key")
        .map(|v| !v.is_empty())
        .unwrap_or(false);

    let configured = provider.is_some() && api_key_is_set;

    Ok(Json(AiStatusResponse {
        provider,
        model,
        configured,
    }))
}

// ---------------------------------------------------------------------------
// Handler 2: PUT /api/ai/settings
// ---------------------------------------------------------------------------

pub async fn save_ai_settings(
    State(state): State<AppState>,
    Json(body): Json<SaveAiSettingsRequest>,
) -> Result<StatusCode> {
    // Helper closure: upsert a key/value into user_preferences
    let upsert = |db: sqlx::SqlitePool, key: String, value: String| async move {
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO user_preferences (id, key, value) VALUES (?, ?, ?) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(id)
        .bind(key)
        .bind(value)
        .execute(&db)
        .await
    };

    upsert(state.db.clone(), "ai_provider".into(), body.provider).await?;
    upsert(state.db.clone(), "ai_model".into(), body.model).await?;

    if let Some(key) = body.api_key.filter(|k| !k.is_empty()) {
        upsert(state.db.clone(), "ai_api_key".into(), key).await?;
    }

    let base_url_val = body.base_url.unwrap_or_default();
    upsert(state.db.clone(), "ai_base_url".into(), base_url_val).await?;

    let deployment_val = body.deployment_name.unwrap_or_default();
    upsert(state.db.clone(), "ai_deployment_name".into(), deployment_val).await?;

    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Handler 3: DELETE /api/ai/settings
// ---------------------------------------------------------------------------

pub async fn delete_ai_settings(
    State(state): State<AppState>,
) -> Result<StatusCode> {
    sqlx::query(
        "DELETE FROM user_preferences WHERE key IN \
         ('ai_provider','ai_model','ai_api_key','ai_base_url','ai_deployment_name')",
    )
    .execute(&state.db)
    .await?;

    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Handler 4: POST /api/ai/chat  (SSE streaming)
// ---------------------------------------------------------------------------

fn error_response(status: StatusCode, message: &str) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::json!({ "error": message }).to_string(),
        ))
        .unwrap()
}

pub async fn post_ai_chat(
    State(state): State<AppState>,
    Json(body): Json<ChatRequest>,
) -> Response {
    // 1. Load AI config
    let config = match load_config(&state.db).await {
        Some(c) => c,
        None => {
            return error_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                "AI provider not configured. Go to Settings > AI to set up a provider.",
            );
        }
    };

    // 2. Build AiContext with truncation applied
    let ai_context = match body.context {
        Some(req_ctx) => AiContext {
            cluster: req_ctx.cluster,
            namespace: req_ctx.namespace,
            resource_kind: req_ctx.resource_kind,
            resource_name: req_ctx.resource_name,
            resource_yaml: req_ctx.resource_yaml,
            log_lines: req_ctx.log_lines,
            events: req_ctx.events,
        }
        .truncated(),
        None => AiContext {
            cluster: None,
            namespace: None,
            resource_kind: None,
            resource_name: None,
            resource_yaml: None,
            log_lines: None,
            events: None,
        },
    };

    // 3. Build system prompt
    let system = build_system_prompt(&ai_context);

    // 4. Convert messages
    let messages: Vec<ChatMessage> = body
        .messages
        .into_iter()
        .map(|m| ChatMessage {
            role: m.role,
            content: m.content,
        })
        .collect();

    // 5. Dispatch to the right client and stream SSE
    macro_rules! stream_with_client {
        ($client:expr) => {{
            let client = $client;
            let sse_stream = async_stream::stream! {
                match client.chat_stream(messages, system).await {
                    Err(e) => {
                        let frame = format!(
                            "data: {}\n\n",
                            serde_json::json!({"error": e, "done": true})
                        );
                        yield Ok::<Bytes, String>(Bytes::from(frame));
                    }
                    Ok(mut token_stream) => {
                        while let Some(result) = token_stream.next().await {
                            match result {
                                Ok(token) => {
                                    let frame = format!(
                                        "data: {}\n\n",
                                        serde_json::json!({"delta": token, "done": false})
                                    );
                                    yield Ok::<Bytes, String>(Bytes::from(frame));
                                }
                                Err(e) => {
                                    let frame = format!(
                                        "data: {}\n\n",
                                        serde_json::json!({"error": e, "done": true})
                                    );
                                    yield Ok::<Bytes, String>(Bytes::from(frame));
                                    return;
                                }
                            }
                        }
                        let done = format!(
                            "data: {}\n\n",
                            serde_json::json!({"delta": "", "done": true})
                        );
                        yield Ok::<Bytes, String>(Bytes::from(done));
                    }
                }
            };

            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "text/event-stream")
                .header(header::CACHE_CONTROL, "no-cache")
                .body(Body::from_stream(sse_stream))
                .unwrap()
        }};
    }

    match config.provider.as_str() {
        "claude" => stream_with_client!(AnthropicClient::new(config.api_key, config.model)),
        "openai" => stream_with_client!(OpenAiClient::new(config.api_key, config.model)),
        "ollama" => stream_with_client!(OllamaClient::new(config.base_url, config.model)),
        "azure_openai" => stream_with_client!(AzureOpenAiClient::new(
            config.base_url,
            config.api_key,
            config.deployment_name
        )),
        unknown => error_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            &format!("Unknown AI provider: {unknown}"),
        ),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ai_request_context_deserializes_partial() {
        let json = r#"{"cluster":"prod","namespace":"default"}"#;
        let ctx: AiRequestContext = serde_json::from_str(json).unwrap();
        assert_eq!(ctx.cluster.as_deref(), Some("prod"));
        assert_eq!(ctx.namespace.as_deref(), Some("default"));
        assert!(ctx.resource_kind.is_none());
        assert!(ctx.resource_yaml.is_none());
    }

    #[test]
    fn ai_request_context_deserializes_all_fields() {
        let json = r#"{
            "cluster": "dev",
            "namespace": "kube-system",
            "resource_kind": "Deployment",
            "resource_name": "coredns",
            "resource_yaml": "apiVersion: apps/v1",
            "log_lines": "error: crash",
            "events": "Warning BackOff"
        }"#;
        let ctx: AiRequestContext = serde_json::from_str(json).unwrap();
        assert_eq!(ctx.resource_kind.as_deref(), Some("Deployment"));
        assert_eq!(ctx.log_lines.as_deref(), Some("error: crash"));
        assert_eq!(ctx.events.as_deref(), Some("Warning BackOff"));
    }

    #[test]
    fn save_ai_settings_request_deserializes() {
        let json = r#"{
            "provider": "claude",
            "model": "claude-opus-4-5",
            "api_key": "sk-test",
            "base_url": null,
            "deployment_name": null
        }"#;
        let req: SaveAiSettingsRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.provider, "claude");
        assert_eq!(req.model, "claude-opus-4-5");
        assert_eq!(req.api_key.as_deref(), Some("sk-test"));
        assert!(req.base_url.is_none());
    }

    #[test]
    fn save_ai_settings_request_optional_fields_absent() {
        let json = r#"{"provider":"openai","model":"gpt-4o"}"#;
        let req: SaveAiSettingsRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.provider, "openai");
        assert!(req.api_key.is_none());
        assert!(req.deployment_name.is_none());
    }

    #[test]
    fn ai_status_response_serializes() {
        let resp = AiStatusResponse {
            provider: Some("ollama".into()),
            model: Some("llama3".into()),
            configured: true,
        };
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("\"configured\":true"));
        assert!(json.contains("\"provider\":\"ollama\""));
    }

    #[test]
    fn ai_status_response_not_configured() {
        let resp = AiStatusResponse {
            provider: None,
            model: None,
            configured: false,
        };
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("\"configured\":false"));
        assert!(json.contains("\"provider\":null"));
    }

    #[test]
    fn chat_request_deserializes_with_context() {
        let json = r#"{
            "messages": [
                {"role": "user", "content": "What is this pod doing?"}
            ],
            "context": {
                "cluster": "prod",
                "resource_kind": "Pod",
                "resource_name": "nginx-abc"
            }
        }"#;
        let req: ChatRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.messages.len(), 1);
        assert_eq!(req.messages[0].role, "user");
        let ctx = req.context.unwrap();
        assert_eq!(ctx.cluster.as_deref(), Some("prod"));
        assert_eq!(ctx.resource_name.as_deref(), Some("nginx-abc"));
    }

    #[test]
    fn chat_request_deserializes_no_context() {
        let json = r#"{"messages":[{"role":"user","content":"hello"}]}"#;
        let req: ChatRequest = serde_json::from_str(json).unwrap();
        assert!(req.context.is_none());
        assert_eq!(req.messages[0].content, "hello");
    }
}
