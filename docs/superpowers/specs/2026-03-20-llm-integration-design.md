# LLM Integration Design — KlustrEye

**Date:** 2026-03-20
**Status:** Approved

## Overview

Add AI assistant capabilities to KlustrEye, supporting YAML generation, resource explanation, error diagnosis, and general Kubernetes Q&A. The integration uses a Rust backend proxy pattern — the frontend never handles API keys directly. Responses stream token-by-token via SSE.

## Supported Providers

| Provider | Auth | Use case |
|---|---|---|
| Anthropic Claude | API key | Cloud, recommended default |
| OpenAI ChatGPT | API key | Cloud, alternative |
| Ollama | Base URL only | Local, free, offline |
| Azure OpenAI | Endpoint URL + API key | Enterprise subscription |

## Architecture

### Data Flow

```
Frontend (React)
  → POST /api/ai/chat   { messages: [{role, content}], context: {...} }
  ← SSE stream          data: {"delta": "...", "done": false}
                        data: {"delta": "", "done": true}

Rust backend
  → reads provider config + API key from SQLite (UserPreference)
  → constructs system prompt with injected context
  → calls provider streaming API
  → proxies SSE chunks to frontend
```

### New Rust Endpoints

- `GET /api/ai/settings/status` — returns `{ provider, model, configured: bool }` (never returns raw key)
- `PUT /api/ai/settings` — saves provider, model, API key (write-only), base URL
- `POST /api/ai/chat` — accepts messages + context, streams SSE response

### Rust LLM Client Abstraction

A single `LlmClient` trait handles all 4 providers behind a uniform streaming interface:

```rust
trait LlmClient {
    async fn chat_stream(
        &self,
        messages: Vec<ChatMessage>,
        system: String,
    ) -> Result<impl Stream<Item = String>>;
}
```

Implementations: `AnthropicClient`, `OpenAiClient`, `OllamaClient`, `AzureOpenAiClient`.

### UserPreference Keys

Stored in the existing `UserPreference` SQLite model:

- `ai_provider` — `"claude" | "openai" | "ollama" | "azure_openai"`
- `ai_api_key` — encrypted API key (empty for Ollama)
- `ai_model` — selected model string
- `ai_base_url` — base URL for Ollama or Azure OpenAI

## Context Injection

When the frontend opens the chat panel or triggers an inline action, it sends a `context` object assembled from the current React Router route and loaded resource data:

```ts
interface AiContext {
  cluster?: string;
  namespace?: string;
  resource_kind?: string;
  resource_name?: string;
  resource_yaml?: string;   // truncated to 4000 chars
  log_lines?: string;       // truncated to 4000 chars
  events?: string;          // truncated to 2000 chars
}
```

The Rust backend prepends this as a system prompt block so the AI always knows the operational context.

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
- Context chip at the top showing current cluster/namespace/resource (auto-derived from route, non-editable)
- Scrollable message history with user and assistant bubbles
- Textarea input: `Enter` to send, `Shift+Enter` for newline
- Streaming responses render token-by-token with a blinking cursor
- "New conversation" button to clear history
- Persisted in Zustand (in-memory, cleared on page reload)

### Inline Contextual Actions

| Location | Button | Pre-filled prompt |
|---|---|---|
| `CreateResourceDialog` | "Generate with AI" | Opens prompt input above YAML editor; fills editor on response |
| Resource detail pages | "Explain this" | Sends resource YAML to chat panel, opens panel |
| Pod detail / events section | "Diagnose" | Sends pod status + events, asks for diagnosis |
| `LogViewer` | "Analyze logs" | Sends visible log lines, asks for error analysis |

**"Use this YAML" button:** When an AI response in the create dialog context contains a fenced YAML block, a button appears below the response to insert it directly into the Monaco editor.

### AI Settings Page (`/settings/ai`)

Global app-level settings, accessible from the sidebar:

- Provider selector (Claude / ChatGPT / Ollama / Azure OpenAI)
- API key field (write-only — shows masked placeholder if key is set)
- Model selector (dropdown populated per provider)
- Base URL field (shown for Ollama and Azure OpenAI only)
- Deployment name field (Azure OpenAI only)
- "Save" button + "Test Connection" button
- Clear indicator if not yet configured (prompts user to set up)

## Inline Action Prompts

Pre-filled prompts sent when inline buttons are triggered:

- **Generate:** `"Generate a Kubernetes {kind} YAML manifest for: {user description}"`
- **Explain:** `"Explain what this {kind} named {name} does and highlight any notable configuration."`
- **Diagnose:** `"This pod is in {phase} state. Diagnose the issue and suggest fixes based on the following events and status:"`
- **Analyze logs:** `"Analyze these logs and identify errors, warnings, or anomalies:"`

## Content Truncation

To avoid exceeding context windows on large resources:
- Resource YAML: truncated to 4000 characters
- Log lines: truncated to 4000 characters
- Events: truncated to 2000 characters

Truncation adds a `[truncated]` marker so the AI knows the content is incomplete.

## Security & Privacy Warnings

### Secrets May Be Sent to External LLMs

**This is the most important security concern in this feature.**

When users trigger inline actions on sensitive resources (Secrets, ConfigMaps with credentials, ServiceAccounts) or analyze logs that may contain API keys, tokens, passwords, or PII, that data is sent to the configured external LLM provider (Anthropic, OpenAI, Azure). External providers may log or use this data per their own policies.

**Mitigations:**

1. **Sensitive resource warning dialog** — Before sending any context that includes a `Secret` resource kind, a warning dialog must be shown:
   > "This resource may contain sensitive data (passwords, tokens, certificates). It will be sent to {provider name}. Are you sure?"
   User must explicitly confirm. This dialog has a "Don't show again for this session" checkbox.

2. **Log analysis warning** — Before sending log lines, a banner warns:
   > "Logs may contain sensitive data. They will be sent to {provider name}."

3. **Ollama exception** — When Ollama (local) is the configured provider, no warning is shown since data stays on the user's machine. The UI should make the active provider clearly visible in the chat panel.

4. **No automatic context for Secrets** — The "Explain this" inline button is hidden on Secret detail pages by default. Users must opt in by manually copying content into the chat.

5. **Settings page disclosure** — The AI settings page prominently states: "Content you send to the AI (YAML, logs, events) may be processed by {provider} according to their privacy policy."

6. **Data minimization** — Only include `resource_yaml` in context when explicitly triggered by the user (inline button or user-initiated chat). Never automatically include resource content in background or passive context.

## Out of Scope

- Conversation persistence across page reloads (in-memory only)
- Multi-turn agentic actions (AI cannot apply changes autonomously)
- Per-cluster AI configuration (global only)
- OAuth/subscription-based auth for Claude.ai or ChatGPT Plus (not supported by those providers for third-party apps)
