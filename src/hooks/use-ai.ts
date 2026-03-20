import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export interface AiStatus {
  provider: string | null;
  model: string | null;
  configured: boolean;
}

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
      if (!res.ok) return [];
      const data = await res.json();
      return (data.models ?? []).map((m: { name: string }) => m.name);
    },
    enabled: !!baseUrl,
    staleTime: 60_000,
  });
}
