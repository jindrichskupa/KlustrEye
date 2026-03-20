import { useRef, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAiStore } from "@/lib/stores/ai-store";
import { useUIStore } from "@/lib/stores/ui-store";
import { useAiStatus, useChatStream } from "@/hooks/use-ai";
import type { AiContext } from "@/hooks/use-ai";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { X, Sparkles, RotateCcw, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

const PROVIDER_DISPLAY: Record<string, string> = {
  claude: 'Claude',
  openai: 'ChatGPT',
  ollama: 'Ollama',
  azure_openai: 'Azure OpenAI',
};

interface AiChatPanelProps {
  context?: AiContext;
}

export function AiChatPanel({ context }: AiChatPanelProps) {
  const { aiPanelOpen, setAiPanelOpen } = useUIStore();
  const { messages, clearMessages, logWarningShown, setLogWarningShown } =
    useAiStore();
  const isStreaming = useAiStore((s) => s.isStreaming);
  const { data: aiStatus } = useAiStatus();
  const { sendMessage } = useChatStream();
  const [input, setInput] = useState("");
  const [showLogWarning, setShowLogWarning] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (!aiPanelOpen) return null;

  // Don't flash unconfigured screen while loading
  if (aiStatus === undefined) {
    return (
      <div className="flex flex-col w-80 border-l bg-card h-full shrink-0">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium">AI Assistant</span>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <span className="text-xs text-muted-foreground animate-pulse">Loading...</span>
        </div>
      </div>
    );
  }

  const handleSend = async () => {
    if (!input.trim() || isStreaming) return;

    // Show log warning once if context contains log_lines and provider is not ollama
    if (context?.log_lines && !logWarningShown && aiStatus?.provider !== "ollama") {
      setShowLogWarning(true);
      setLogWarningShown();
    }

    const content = input.trim();
    setInput("");
    await sendMessage({ content, context });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const displayProvider = PROVIDER_DISPLAY[aiStatus?.provider ?? ''] ?? aiStatus?.provider ?? '';
  const providerLabel = aiStatus?.configured
    ? `${displayProvider} · ${aiStatus.model}`
    : null;

  const hasContext =
    context &&
    (context.cluster || context.namespace || context.resource_kind);

  const contextLabel = hasContext
    ? [
        context.cluster,
        context.namespace,
        context.resource_kind && context.resource_name
          ? `${context.resource_kind}/${context.resource_name}`
          : context.resource_kind,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;

  return (
    <div className="flex flex-col w-80 border-l bg-card h-full shrink-0">
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Sparkles className="h-4 w-4 text-primary shrink-0" />
        <span className="text-sm font-medium flex-1">AI Assistant</span>
        {providerLabel ? (
          <Badge variant="secondary" className="text-xs font-normal">
            {providerLabel}
          </Badge>
        ) : (
          <Badge variant="outline" className="text-xs font-normal text-muted-foreground">
            Not configured
          </Badge>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          onClick={clearMessages}
          title="New conversation"
        >
          <RotateCcw className="h-3 w-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          onClick={() => setAiPanelOpen(false)}
          title="Close panel"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>

      {/* Context chip */}
      {contextLabel && (
        <div className="px-3 py-1.5 border-b text-xs text-muted-foreground bg-muted/30 truncate">
          {contextLabel}
        </div>
      )}

      {/* Body */}
      {!aiStatus?.configured ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground p-6 text-center">
          <Sparkles className="h-8 w-8 opacity-20" />
          <div className="space-y-1">
            <p className="font-medium text-foreground">AI not configured</p>
            <p className="text-xs">Set up an AI provider to start chatting.</p>
          </div>
          <Link
            to="/settings/ai"
            className="text-primary underline underline-offset-2 text-xs"
            onClick={() => setAiPanelOpen(false)}
          >
            Go to AI Settings
          </Link>
        </div>
      ) : (
        <>
          {/* Log warning banner */}
          {showLogWarning && (
            <div className="mx-3 mt-2 flex items-start gap-2 rounded-md bg-yellow-500/10 border border-yellow-500/30 p-2 text-xs text-yellow-700 dark:text-yellow-400">
              <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
              <span className="flex-1">
                Logs may contain sensitive data. They will be sent to{" "}
                {PROVIDER_DISPLAY[aiStatus.provider ?? ''] ?? aiStatus.provider} and processed per their privacy policy.
              </span>
              <button
                className="ml-auto shrink-0 hover:opacity-70 transition-opacity"
                onClick={() => setShowLogWarning(false)}
                aria-label="Dismiss warning"
              >
                ✕
              </button>
            </div>
          )}

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {messages.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-8">
                Ask anything about Kubernetes
              </p>
            )}
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={cn(
                  "flex",
                  msg.role === "user" ? "justify-end" : "justify-start"
                )}
              >
                <div
                  className={cn(
                    "rounded-lg px-3 py-2 text-sm max-w-[85%] whitespace-pre-wrap break-words",
                    msg.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted",
                    msg.isError && "bg-destructive/10 border border-destructive/30 text-destructive"
                  )}
                >
                  {msg.content}
                  {msg.role === "assistant" &&
                    isStreaming &&
                    msg === messages[messages.length - 1] && (
                      <span className="inline-block w-0.5 h-4 bg-current animate-pulse ml-0.5 align-middle" />
                    )}
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="border-t p-3">
            <div className="flex gap-2">
              <textarea
                className="flex-1 min-h-[60px] max-h-[120px] rounded-md border bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
                placeholder="Ask about Kubernetes... (Enter to send)"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={isStreaming}
                autoComplete="off"
                aria-label="Chat input"
              />
              <Button
                size="sm"
                className="self-end"
                onClick={handleSend}
                disabled={!input.trim() || isStreaming}
              >
                Send
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
