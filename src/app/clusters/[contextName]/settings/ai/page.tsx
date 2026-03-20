import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  useAiStatus,
  useSaveAiSettings,
  useDeleteAiSettings,
  useOllamaModels,
} from "@/hooks/use-ai";
import { Loader2 } from "lucide-react";

const MODELS: Record<string, string[]> = {
  claude: ["claude-sonnet-4-6", "claude-haiku-4-5-20251001", "claude-opus-4-6"],
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
  ollama: [],
  azure_openai: [],
};

const PROVIDER_OPTIONS = [
  { value: "claude", label: "Anthropic Claude" },
  { value: "openai", label: "OpenAI ChatGPT" },
  { value: "ollama", label: "Ollama (Local)" },
  { value: "azure_openai", label: "Azure OpenAI" },
];

const PROVIDER_DISPLAY: Record<string, string> = {
  claude: "Anthropic Claude",
  openai: "OpenAI",
  ollama: "Ollama",
  azure_openai: "Azure OpenAI",
};

const DEFAULT_BASE_URLS: Record<string, string> = {
  ollama: "http://localhost:11434",
};

type TestStatus = "idle" | "testing" | "success" | "error";

export default function AiSettingsPage() {
  const { addToast } = useToast();
  const confirm = useConfirm();
  const { data: aiStatus } = useAiStatus();
  const saveSettings = useSaveAiSettings();
  const deleteSettings = useDeleteAiSettings();

  const [provider, setProvider] = useState("claude");
  const [model, setModel] = useState(MODELS.claude[0]);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [deploymentName, setDeploymentName] = useState("");
  const [testStatus, setTestStatus] = useState<TestStatus>("idle");
  const [testError, setTestError] = useState("");

  // Initialize form from current AI status
  useEffect(() => {
    if (aiStatus?.provider) {
      setProvider(aiStatus.provider);
    }
    if (aiStatus?.model) {
      setModel(aiStatus.model);
    }
  }, [aiStatus]);

  // When provider changes, set sensible defaults for model and baseUrl
  const handleProviderChange = (newProvider: string) => {
    setProvider(newProvider);
    // Reset model to first option for the new provider (if available)
    const providerModels = MODELS[newProvider] ?? [];
    if (providerModels.length > 0) {
      setModel(providerModels[0]);
    } else {
      setModel("");
    }
    // Set default base URL for providers that need it
    setBaseUrl(DEFAULT_BASE_URLS[newProvider] ?? "");
    setTestStatus("idle");
    setTestError("");
  };

  // Fetch Ollama models dynamically
  const ollamaBaseUrl = provider === "ollama" ? (baseUrl || DEFAULT_BASE_URLS.ollama) : null;
  const { data: ollamaModels, isLoading: ollamaLoading } = useOllamaModels(ollamaBaseUrl);

  // Compute available model options based on provider
  const modelOptions: { value: string; label: string }[] = (() => {
    if (provider === "ollama") {
      if (ollamaLoading) return [{ value: "", label: "Loading..." }];
      if (!ollamaModels || ollamaModels.length === 0) return [{ value: "", label: "No models found" }];
      return ollamaModels.map((m) => ({ value: m, label: m }));
    }
    if (provider === "azure_openai") {
      return [];
    }
    return (MODELS[provider] ?? []).map((m) => ({ value: m, label: m }));
  })();

  const showBaseUrl = provider === "ollama" || provider === "azure_openai";
  const showDeploymentName = provider === "azure_openai";
  const showModelSelector = provider !== "azure_openai";

  const handleSave = () => {
    saveSettings.mutate(
      {
        provider,
        model: model || "",
        api_key: apiKey || undefined,
        base_url: baseUrl || undefined,
        deployment_name: deploymentName || undefined,
      },
      {
        onSuccess: () => {
          addToast({ title: "AI settings saved", variant: "success" });
          setApiKey(""); // clear key field after save
        },
        onError: (err) => {
          addToast({
            title: "Failed to save AI settings",
            description: err instanceof Error ? err.message : undefined,
            variant: "destructive",
          });
        },
      }
    );
  };

  const handleDelete = async () => {
    const confirmed = await confirm({
      title: "Remove AI Settings",
      description: "Are you sure you want to remove all AI settings including your API key?",
      confirmLabel: "Remove",
      variant: "destructive",
    });
    if (!confirmed) return;

    deleteSettings.mutate(undefined, {
      onSuccess: () => {
        addToast({ title: "AI settings removed", variant: "success" });
        setProvider("claude");
        setModel(MODELS.claude[0]);
        setApiKey("");
        setBaseUrl("");
        setDeploymentName("");
        setTestStatus("idle");
        setTestError("");
      },
      onError: (err) => {
        addToast({
          title: "Failed to remove AI settings",
          description: err instanceof Error ? err.message : undefined,
          variant: "destructive",
        });
      },
    });
  };

  const handleTestConnection = async () => {
    setTestStatus("testing");
    setTestError("");

    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Say 'ok' and nothing else." }],
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setTestStatus("error");
        setTestError(err.error ?? `HTTP ${res.status}`);
        return;
      }

      // Read the first SSE data frame from the stream
      const reader = res.body?.getReader();
      if (!reader) {
        setTestStatus("error");
        setTestError("No response body");
        return;
      }

      const decoder = new TextDecoder();
      let found = false;

      try {
        while (!found) {
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
                setTestStatus("error");
                setTestError(frame.error);
                found = true;
                break;
              }
              if (frame.delta || frame.done) {
                setTestStatus("success");
                found = true;
                break;
              }
            } catch {
              // malformed frame, keep reading
            }
          }
        }

        if (!found) {
          setTestStatus("success");
        }
      } finally {
        reader.cancel().catch(() => {});
      }
    } catch (err) {
      setTestStatus("error");
      setTestError(err instanceof Error ? err.message : "Network error");
    }
  };

  const privacyNote =
    provider === "ollama"
      ? "Ollama processes all data locally on your machine."
      : `Content you send to the AI (YAML, logs, events) is processed by ${PROVIDER_DISPLAY[provider] ?? provider} according to their privacy policy.`;

  const hasExistingKey = aiStatus?.configured && aiStatus?.provider === provider;

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold">AI Settings</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Configure your AI provider for generating YAML, analyzing logs, and diagnosing issues.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Provider</CardTitle>
          <CardDescription>Choose which AI provider to use</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="text-sm font-medium mb-1 block">Provider</label>
            <Select
              value={provider}
              onChange={(e) => handleProviderChange(e.target.value)}
              options={PROVIDER_OPTIONS}
              className="w-56"
            />
          </div>

          {showModelSelector && (
            <div>
              <label className="text-sm font-medium mb-1 block">Model</label>
              {ollamaLoading && provider === "ollama" ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading models from Ollama...
                </div>
              ) : (
                <Select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  options={modelOptions}
                  disabled={modelOptions.length === 0 || (provider === "ollama" && ollamaLoading)}
                  className="w-56"
                />
              )}
            </div>
          )}

          {showBaseUrl && (
            <div>
              <label className="text-sm font-medium mb-1 block">
                Base URL
              </label>
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={DEFAULT_BASE_URLS[provider] ?? "https://..."}
                className="max-w-xs"
                autoComplete="off"
              />
              {provider === "ollama" && (
                <p className="text-xs text-muted-foreground mt-1">
                  Default: http://localhost:11434
                </p>
              )}
            </div>
          )}

          {showDeploymentName && (
            <div>
              <label className="text-sm font-medium mb-1 block">Deployment Name</label>
              <Input
                value={deploymentName}
                onChange={(e) => setDeploymentName(e.target.value)}
                placeholder="my-gpt4-deployment"
                className="max-w-xs"
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground mt-1">
                The Azure OpenAI deployment name (determines the model)
              </p>
            </div>
          )}

          {provider !== "ollama" && (
            <div>
              <label className="text-sm font-medium mb-1 block">API Key</label>
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={hasExistingKey ? "••••••••" : "Enter API key..."}
                className="max-w-xs font-mono"
                autoComplete="new-password"
              />
              {hasExistingKey && !apiKey && (
                <p className="text-xs text-muted-foreground mt-1">
                  An API key is already saved. Leave blank to keep the existing key.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Actions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={handleSave}
              disabled={saveSettings.isPending}
            >
              {saveSettings.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save"
              )}
            </Button>

            <Button
              variant="outline"
              onClick={handleTestConnection}
              disabled={testStatus === "testing"}
            >
              {testStatus === "testing" ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Testing...
                </>
              ) : (
                "Test Connection"
              )}
            </Button>

            {testStatus === "success" && (
              <Badge variant="success">Connected</Badge>
            )}
            {testStatus === "error" && (
              <Badge variant="destructive" title={testError}>
                {testError ? `Error: ${testError.slice(0, 60)}${testError.length > 60 ? "..." : ""}` : "Connection failed"}
              </Badge>
            )}
          </div>

          {aiStatus?.configured && (
            <div>
              <Button
                variant="outline"
                onClick={handleDelete}
                disabled={deleteSettings.isPending}
                className="text-destructive hover:text-destructive border-destructive/30 hover:border-destructive/60"
              >
                {deleteSettings.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Removing...
                  </>
                ) : (
                  "Remove AI Settings"
                )}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Privacy</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{privacyNote}</p>
        </CardContent>
      </Card>
    </div>
  );
}
