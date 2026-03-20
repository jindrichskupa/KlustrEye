# LLM Integration Design — KlustrEye

**Date:** 2026-03-20
**Status:** Draft

## Overview

Add AI assistant capabilities to KlustrEye, supporting YAML generation, resource explanation, error diagnosis, and general Kubernetes Q&A. The integration uses a Rust backend proxy pattern — the frontend never handles API keys directly. Responses stream token-by-token via SSE.

## Tech Stack Clarification

KlustrEye is a **Tauri v2 desktop app** with a **Vite + React + React Router** frontend and a **Rust binary** as the backend (`cargo run --bin klustreye-server`). The CLAUDE.md file references Next.js but the actual `package.json` confirms the stack is Vite + React Router + Rust. All new `/api/ai/*` endpoints are implemented in the **Rust backend**.

## Supported Providers

| Provider | Auth | Use case |
|---|---|---|
| Anthropic Claude | API key | Cloud, recommended default |
| OpenAI ChatGPT | API key | Cloud, alternative |
| Ollama | Base URL only | Local, free, offline — no key sent externally |
| Azure OpenAI | Endpoint URL + API key + deployment name | Enterprise subscription |

**Default models per provider (hardcoded list, not fetched at runtime):**

| Provider | Default model | Other options |
|---|---|---|
| Anthropic Claude | `claude-sonnet-4-6` | `claude-haiku-4-5-20251001`, `claude-opus-4-6` |
| OpenAI | `gpt-4o` | `gpt-4o-mini`, `gpt-4-turbo` |
| Ollama | first model from `/api/tags` | All models fetched dynamically from local Ollama |
| Azure OpenAI | deployment name (user-defined) | N/A — model determined by deployment |

Ollama models are fetched dynamically from `GET {base_url}/api/tags` when the user selects Ollama as provider. All other provider model lists are hardcoded.

## Architecture

### Data Flow

```
Frontend (React)
  → POST /api/ai/chat   { messages: [{role, content}], context: {...} }
  ← SSE stream          data: {"delta": "...", "done": false}
                        data: {"delta": "", "done": true}
                        data: {"error": "Rate limit exceeded", "done": true}

Rust backend
  → reads provider config + API key from SQLite (UserPreference)
  → if no provider configured: returns HTTP 422 { error: "AI not configured" }
  → constructs system prompt with injected context
  → calls provider streaming API
  → proxies SSE chunks to frontend; on provider error sends error SSE frame then closes
```

### New Rust Endpoints

- `GET /api/ai/settings/status` — returns `{ provider, model, configured: bool }` (never returns raw key)
- `PUT /api/ai/settings` — saves provider, model, API key (write-only), base URL, deployment name
- `DELETE /api/ai/settings` — clears all AI configuration (removes UserPreference keys for ai_*)
- `POST /api/ai/chat` — accepts messages + context, streams SSE response

### Error Handling

**HTTP-level errors** (before streaming starts):
- `422 Unprocessable Entity` — no provider configured; body: `{ "error": "AI provider not configured. Go to Settings > AI to set up a provider." }`
- `401 Unauthorized` — bad API key; body: `{ "error": "Invalid API key" }`

**Stream-level errors** (during streaming):
- The Rust backend sends a final SSE frame: `data: {"error": "...", "done": true}` then closes the connection
- Common stream errors: rate limit (429), provider timeout, network failure mid-stream

**Frontend behavior on error:**
- HTTP 422: show inline prompt in chat panel: "AI not configured — [Go to Settings]"
- HTTP 401: show toast "Invalid API key. Check your AI settings."
- Stream error frame: render the error message in the assistant bubble in red, stop spinner

### Rust LLM Client Abstraction

A single `LlmClient` trait handles all 4 providers behind a uniform streaming interface:

```rust
trait LlmClient {
    async fn chat_stream(
        &self,
        messages: Vec<ChatMessage>,
        system: String,
    ) -> Result<impl Stream<Item = Result<String, LlmError>>>;
}
```

Implementations: `AnthropicClient`, `OpenAiClient`, `OllamaClient`, `AzureOpenAiClient`.

### UserPreference Keys

Stored in the existing `UserPreference` SQLite model (`key` + `value` String fields):

- `ai_provider` — `"claude" | "openai" | "ollama" | "azure_openai"`
- `ai_api_key` — API key value, stored as plaintext in SQLite (see Security Note below)
- `ai_model` — selected model string
- `ai_base_url` — base URL for Ollama or Azure OpenAI
- `ai_deployment_name` — deployment name for Azure OpenAI only

**Security note on key storage:** The current `UserPreference` schema stores values as plain `String`. For this version, the API key is stored as plaintext in the local SQLite database (acceptable for a local desktop app where the database file is only accessible to the current OS user). A future enhancement can migrate to Tauri's `stronghold` plugin for OS keychain-backed encryption. The settings API never returns the raw key to the frontend.

## Context Injection

When the frontend opens the chat panel or triggers an inline action, it sends a `context` object assembled from the current React Router route and loaded resource data:

```ts
interface AiContext {
  cluster?: string;
  namespace?: string;
  resource_kind?: string;
  resource_name?: string;
  resource_yaml?: string;   // truncated to 4000 chars, appended with "# [truncated]" as YAML comment
  log_lines?: string;       // truncated to 4000 chars, appended with "[truncated]"
  events?: string;          // truncated to 2000 chars, appended with "[truncated]"
}
```

`resource_yaml` is only included when explicitly triggered by a user action (inline button press or user initiating a chat referencing the current resource). It is never automatically injected on every message.

`resource_yaml` truncation appends `# [truncated]` as a YAML comment so the truncated content remains syntactically valid YAML.

### System Prompt

```
You are an expert Kubernetes assistant embedded in KlustrEye, a Kubernetes IDE.
You help with YAML generation, resource explanation, error diagnosis, and Kubernetes best practices.
Be concise and practical. When generating YAML, output only valid YAML in a fenced code block.

Current context:
- Cluster: {cluster}
- Namespace: {namespace}
- Resource: {kind}/{name}
[YAML or logs if provided]
```

## UI Components

### Global Chat Panel (`AiChatPanel`)

- Collapsible right-side drawer, toggled by a sparkle icon button in the app header
- Active provider badge shown in the panel header (e.g. "Claude · sonnet-4-6" or "Ollama · llama3")
- Context chip below the header showing current cluster/namespace/resource (auto-derived from route, non-editable)
- Scrollable message history with user and assistant bubbles
- Textarea input: `Enter` to send, `Shift+Enter` for newline
- Streaming responses render token-by-token with a blinking cursor
- "New conversation" button to clear history
- If no provider configured: panel shows a full-panel prompt "AI not configured — [Go to Settings]" instead of the chat UI
- State persisted in Zustand (in-memory); cleared on app restart (Tauri app lifecycle, not page reload)

### Inline Contextual Actions

| Location | Button | Behavior |
|---|---|---|
| `CreateResourceDialog` | "Generate with AI" | See "Generate Flow" section below |
| Resource detail pages (non-sensitive) | "Explain this" | Sends resource YAML to chat panel, opens panel |
| Secret / ConfigMap detail pages | "Explain this" (hidden by default) | Hidden; user must manually paste into chat |
| Pod detail / events section | "Diagnose" | Sends pod status + events to chat, opens panel |
| `LogViewer` | "Analyze logs" | Sends visible log lines to chat, opens panel |

### Generate with AI Flow (in `CreateResourceDialog`)

1. User clicks "Generate with AI" button — a text input row appears above the YAML editor (the dialog height expands slightly to accommodate)
2. User types a description and presses Enter or clicks "Generate"
3. A loading spinner replaces the "Generate" button; streaming response is shown in a read-only text area below the prompt input (not in the sidebar chat panel)
4. When the response contains a YAML code block, a "Use this YAML" button appears below the streaming area
5. Clicking "Use this YAML" replaces the Monaco editor content (with a confirmation if the editor already has non-default content)
6. User can dismiss the generate area and return to manual editing at any time

### "Use this YAML" Button

Appears inline within the `CreateResourceDialog` generate area (not in the global chat panel) when the AI response contains a fenced YAML block. Clicking it overwrites the Monaco editor content after a confirmation prompt if the editor has been modified from the default template.

### AI Settings Page (`/settings/ai`)

Global app-level settings, accessible from the sidebar under a top-level "Settings" section:

- Provider selector (Claude / ChatGPT / Ollama / Azure OpenAI)
- API key field (write-only — shows `••••••••` placeholder if key is set, empty if not)
- Model selector (dropdown; see model table above)
- Base URL field (shown for Ollama and Azure OpenAI only; defaults to `http://localhost:11434` for Ollama)
- Deployment name field (Azure OpenAI only)
- "Save" button
- "Test Connection" button (sends a minimal test prompt and shows success/failure inline)
- "Remove API Key" button (calls `DELETE /api/ai/settings`; prompts confirmation)
- Privacy disclosure: "Content you send to the AI (YAML, logs, events) is processed by {provider} according to their privacy policy. Ollama processes all data locally."

## Inline Action Prompts

Pre-filled prompts sent when inline buttons are triggered:

- **Generate:** `"Generate a Kubernetes {kind} YAML manifest for: {user description}"`
- **Explain:** `"Explain what this {kind} named {name} does and highlight any notable configuration."`
- **Diagnose:** `"This pod is in {phase} state. Diagnose the issue and suggest fixes based on the following events and status:"`
- **Analyze logs:** `"Analyze these logs and identify errors, warnings, or anomalies:"`

## Content Truncation

To avoid exceeding context windows on large resources:
- Resource YAML: truncated to 4000 characters; truncation marker: `# [truncated]` (valid YAML comment)
- Log lines: truncated to 4000 characters; truncation marker: `[truncated]`
- Events: truncated to 2000 characters; truncation marker: `[truncated]`

## Security & Privacy Warnings

### Secrets and ConfigMaps May Contain Sensitive Data Sent to External LLMs

When users trigger inline actions on sensitive resources (Secrets, ConfigMaps with credentials) or analyze logs that may contain API keys, tokens, passwords, or PII, that data is sent to the configured external LLM provider (Anthropic, OpenAI, Azure). External providers may log or use this data per their own policies.

**Mitigations:**

1. **Hidden inline button for Secrets and ConfigMaps** — The "Explain this" button is not rendered on Secret or ConfigMap detail pages. Users must consciously paste content into the chat panel themselves.

2. **Log analysis warning banner** — Before sending log lines, a dismissible yellow warning banner appears in the chat panel:
   > "Logs may contain sensitive data. They will be sent to {provider name} and processed per their privacy policy."
   This banner is shown once per app session (Tauri app launch). "Session" = from app launch until app quit. It persists across Tauri window hide/show cycles (stored in Zustand, cleared only on app restart).

3. **Ollama exception** — When Ollama is the configured provider, no privacy warnings are shown. The active provider badge in the chat panel header makes it clear that data stays local.

4. **Settings page disclosure** — Prominently displayed on the AI settings page: "Content you send to the AI (YAML, logs, events) is processed by {provider} according to their privacy policy. Ollama processes all data locally."

5. **Data minimization** — `resource_yaml` and `log_lines` are only included in context when explicitly triggered by a user action. They are never injected automatically or passively.

6. **No automatic secret scanning** — KlustrEye does not attempt to detect or redact secrets in YAML or logs before sending. This is explicitly documented as a known limitation.

## Out of Scope

- Conversation persistence across app restarts (in-memory Zustand only)
- Multi-turn agentic actions (AI cannot apply changes to the cluster autonomously)
- Per-cluster AI configuration (global only)
- OAuth/subscription-based auth for Claude.ai or ChatGPT Plus (not supported by those providers for third-party apps)
- OS keychain-backed API key encryption (deferred to future; current storage is plaintext SQLite)
- Automatic secret detection/redaction before sending to LLM
