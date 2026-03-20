import { useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAiStore, AiMessage } from "@/lib/stores/ai-store";

export interface AiStatus {
  provider: string | null;
  model: string | null;
  configured: boolean;
}

// snake_case field names match the Rust backend JSON contract directly
export interface SaveAiSettingsPayload {
  provider: string;
  model: string;
  api_key?: string;
  base_url?: string;
  deployment_name?: string;
}

const AI_SETTINGS_KEY = ["ai", "status"];

export function useAiStatus() {
  return useQuery<AiStatus>({
    queryKey: AI_SETTINGS_KEY,
    queryFn: async () => {
      const res = await fetch("/api/ai/settings/status");
      if (!res.ok) throw new Error("Failed to fetch AI status");
      return res.json();
    },
    staleTime: 30_000,
  });
}

export function useSaveAiSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: SaveAiSettingsPayload) => {
      const res = await fetch("/api/ai/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("Failed to save AI settings");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: AI_SETTINGS_KEY }),
  });
}

export function useDeleteAiSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/ai/settings", { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete AI settings");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: AI_SETTINGS_KEY }),
  });
}

export function useOllamaModels(baseUrl: string | null) {
  return useQuery<string[]>({
    queryKey: ["ollama", "models", baseUrl],
    queryFn: async () => {
      if (!baseUrl) return [];
      const res = await fetch(`${baseUrl}/api/tags`);
      if (!res.ok) throw new Error(`Could not reach Ollama at ${baseUrl}`);
      const data = await res.json();
      return (data.models ?? []).map((m: { name: string }) => m.name);
    },
    enabled: !!baseUrl,
    staleTime: 60_000,
  });
}

export interface AiContext {
  cluster?: string;
  namespace?: string;
  resource_kind?: string;
  resource_name?: string;
  resource_yaml?: string;
  log_lines?: string;
  events?: string;
}

export interface SendMessageOptions {
  content: string;
  context?: AiContext;
}

export function useChatStream() {
  const { addMessage, updateLastAssistantMessage, setStreaming, isStreaming } =
    useAiStore();

  const sendMessage = useCallback(
    async ({ content, context }: SendMessageOptions) => {
      if (isStreaming) return;

      // Add user message to store
      const userMsg: AiMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content,
      };
      addMessage(userMsg);

      // Add empty assistant message placeholder
      const assistantMsg: AiMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
      };
      addMessage(assistantMsg);

      setStreaming(true);

      // Read current messages via getState() to avoid stale closure
      const messages = useAiStore
        .getState()
        .messages.filter((m) => m.id !== assistantMsg.id)
        .map((m) => ({ role: m.role, content: m.content }));

      try {
        const res = await fetch("/api/ai/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages, context }),
        });

        if (!res.ok) {
          const err = await res
            .json()
            .catch(() => ({ error: `HTTP ${res.status}` }));
          updateLastAssistantMessage(err.error ?? "Request failed");
          useAiStore.setState((s) => {
            const msgs = [...s.messages];
            const last = msgs.findLastIndex((m) => m.role === "assistant");
            if (last !== -1) msgs[last] = { ...msgs[last], isError: true };
            return { messages: msgs };
          });
          return;
        }

        // Read SSE stream
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";

        outer: while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const text = decoder.decode(value, { stream: true });
          const lines = text.split("\n");

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (!data) continue;

            try {
              const frame = JSON.parse(data);

              if (frame.error) {
                useAiStore.setState((s) => {
                  const msgs = [...s.messages];
                  const last = msgs.findLastIndex(
                    (m) => m.role === "assistant"
                  );
                  if (last !== -1)
                    msgs[last] = {
                      ...msgs[last],
                      content: frame.error,
                      isError: true,
                    };
                  return { messages: msgs };
                });
                break outer;
              }

              if (frame.delta) {
                accumulated += frame.delta;
                updateLastAssistantMessage(accumulated);
              }

              if (frame.done) break outer;
            } catch {
              // ignore malformed frame
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Network error";
        updateLastAssistantMessage(msg);
        useAiStore.setState((s) => {
          const msgs = [...s.messages];
          const last = msgs.findLastIndex((m) => m.role === "assistant");
          if (last !== -1) msgs[last] = { ...msgs[last], isError: true };
          return { messages: msgs };
        });
      } finally {
        setStreaming(false);
      }
    },
    [isStreaming, addMessage, updateLastAssistantMessage, setStreaming]
  );

  return { sendMessage, isStreaming };
}
