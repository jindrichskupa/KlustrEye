import { create } from "zustand";

export interface AiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  isError?: boolean;
}

interface AiStore {
  messages: AiMessage[];
  isStreaming: boolean;
  logWarningShown: boolean;
  showLogWarning: boolean;

  addMessage: (msg: AiMessage) => void;
  updateLastAssistantMessage: (content: string) => void;
  setStreaming: (v: boolean) => void;
  setLogWarningShown: () => void;
  setShowLogWarning: (v: boolean) => void;
  clearMessages: () => void;
}

export const useAiStore = create<AiStore>((set) => ({
  messages: [],
  isStreaming: false,
  logWarningShown: false,
  showLogWarning: false,

  addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  updateLastAssistantMessage: (content) =>
    set((s) => {
      const messages = [...s.messages];
      const last = messages.findLastIndex((m) => m.role === "assistant");
      if (last !== -1) messages[last] = { ...messages[last], content };
      return { messages };
    }),
  setStreaming: (v) => set({ isStreaming: v }),
  setLogWarningShown: () => set({ logWarningShown: true }),
  setShowLogWarning: (v) => set({ showLogWarning: v }),
  clearMessages: () => set({ messages: [] }),
}));
