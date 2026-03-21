import { create } from "zustand";

export interface AiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  isError?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  messages: AiMessage[];
  createdAt: number;
}

interface AiStore {
  messages: AiMessage[];
  isStreaming: boolean;
  logWarningShown: boolean;
  showLogWarning: boolean;
  stopStreaming: (() => void) | null;
  pastConversations: Conversation[];

  addMessage: (msg: AiMessage) => void;
  updateLastAssistantMessage: (content: string) => void;
  setStreaming: (v: boolean) => void;
  setLogWarningShown: () => void;
  setShowLogWarning: (v: boolean) => void;
  clearMessages: () => void;
  setStopStreaming: (fn: (() => void) | null) => void;
  saveCurrentConversation: () => void;
  loadConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
}

export const useAiStore = create<AiStore>((set) => ({
  messages: [],
  isStreaming: false,
  logWarningShown: false,
  showLogWarning: false,
  stopStreaming: null,
  pastConversations: [],

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
  setStopStreaming: (fn) => set({ stopStreaming: fn }),

  clearMessages: () => set((s) => {
    if (s.messages.length === 0) return { messages: [] };
    const firstUserMsg = s.messages.find(m => m.role === 'user');
    const title = firstUserMsg
      ? firstUserMsg.content.slice(0, 60) + (firstUserMsg.content.length > 60 ? '…' : '')
      : 'Conversation';
    const conv: Conversation = {
      id: crypto.randomUUID(),
      title,
      messages: s.messages,
      createdAt: Date.now(),
    };
    return {
      pastConversations: [conv, ...s.pastConversations].slice(0, 20),
      messages: [],
    };
  }),

  saveCurrentConversation: () => set((s) => {
    if (s.messages.length === 0) return s;
    const firstUserMsg = s.messages.find(m => m.role === 'user');
    const title = firstUserMsg
      ? firstUserMsg.content.slice(0, 60) + (firstUserMsg.content.length > 60 ? '…' : '')
      : 'Conversation';
    const conv: Conversation = {
      id: crypto.randomUUID(),
      title,
      messages: s.messages,
      createdAt: Date.now(),
    };
    return {
      pastConversations: [conv, ...s.pastConversations].slice(0, 20),
      messages: [],
    };
  }),

  loadConversation: (id) => set((s) => {
    const conv = s.pastConversations.find(c => c.id === id);
    if (!conv) return s;
    let past = s.pastConversations;
    if (s.messages.length > 0) {
      const firstUserMsg = s.messages.find(m => m.role === 'user');
      const title = firstUserMsg
        ? firstUserMsg.content.slice(0, 60) + (firstUserMsg.content.length > 60 ? '…' : '')
        : 'Conversation';
      past = [{ id: crypto.randomUUID(), title, messages: s.messages, createdAt: Date.now() }, ...past].slice(0, 20);
    }
    return {
      messages: conv.messages,
      pastConversations: past.filter(c => c.id !== id),
    };
  }),

  deleteConversation: (id) => set((s) => ({
    pastConversations: s.pastConversations.filter(c => c.id !== id),
  })),
}));
