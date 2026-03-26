'use client';

import { useState, useRef, useEffect } from 'react';

// --- Types ---

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  skill?: string;
  confidence?: number;
  rating?: number;
  feedbackGiven?: 'up' | 'down';
  error?: boolean;
}

interface Skill {
  name: string;
  description: string;
  tags: string[];
  version: string;
  adapter: string;
  rating: number;
  invocations: number;
  enabled: boolean;
}

interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
}

// --- Constants ---

const EXAMPLE_QUERIES = [
  "What's the weather in Tokyo?",
  'Translate "good morning" to Japanese',
  'Lookup IP 8.8.8.8',
  'Translate hello to French and check weather in Paris',
];

// --- Components ---

function SkillBadge({ skill, confidence, rating }: { skill: string; confidence: number; rating: number }) {
  return (
    <div className="flex items-center gap-2 mt-2 text-xs text-zinc-400 dark:text-zinc-500">
      <span className="px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-mono">
        {skill}
      </span>
      <span>{Math.round(confidence * 100)}% match</span>
      <span>★ {rating.toFixed(1)}</span>
    </div>
  );
}

function SkillsSidebar({
  skills,
  open,
  onClose,
  activeTab,
  onTabChange,
}: {
  skills: Skill[];
  open: boolean;
  onClose: () => void;
  activeTab: 'skills' | 'history';
  onTabChange: (tab: 'skills' | 'history') => void;
}) {
  if (!open) return null;

  return (
    <div className="w-72 border-r border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 flex flex-col h-full shrink-0">
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
        <div className="flex gap-1">
          <button
            onClick={() => onTabChange('skills')}
            className={`text-xs px-3 py-1.5 rounded-lg font-medium transition ${
              activeTab === 'skills'
                ? 'bg-black dark:bg-white text-white dark:text-black'
                : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
            }`}
          >
            Skills
          </button>
          <button
            onClick={() => onTabChange('history')}
            className={`text-xs px-3 py-1.5 rounded-lg font-medium transition ${
              activeTab === 'history'
                ? 'bg-black dark:bg-white text-white dark:text-black'
                : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
            }`}
          >
            History
          </button>
        </div>
        <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 text-lg">
          ×
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {activeTab === 'skills' &&
          skills.map((s) => (
            <div
              key={s.name}
              className="p-3 rounded-xl border border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition"
            >
              <div className="flex items-center justify-between">
                <span className="font-medium text-sm text-zinc-800 dark:text-zinc-100">{s.name}</span>
                <span className="text-xs text-zinc-400">v{s.version}</span>
              </div>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 line-clamp-2">{s.description}</p>
              <div className="flex items-center gap-3 mt-2 text-xs text-zinc-400">
                <span>★ {s.rating.toFixed(1)}</span>
                <span>{s.invocations} uses</span>
                <span className="px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 font-mono">{s.adapter}</span>
              </div>
              {s.tags.length > 0 && (
                <div className="flex gap-1 mt-2 flex-wrap">
                  {s.tags.map((t) => (
                    <span key={t} className="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500">
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}

        {activeTab === 'skills' && skills.length === 0 && (
          <p className="text-xs text-zinc-400 text-center py-8">No skills installed</p>
        )}
      </div>
    </div>
  );
}

// --- Main Page ---

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<'skills' | 'history'>('skills');
  const [darkMode, setDarkMode] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Load skills on mount
  useEffect(() => {
    fetch('/api/skills')
      .then((r) => r.json())
      .then((data) => setSkills(data.skills || []))
      .catch(() => {});
  }, []);

  // Detect system dark mode
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    setDarkMode(mq.matches);
    const handler = (e: MediaQueryListEvent) => setDarkMode(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Apply dark mode
  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
  }, [darkMode]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function sendMessage(query: string) {
    if (!query.trim() || loading) return;

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: query.trim(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.trim() }),
      });
      const data = await res.json();

      const assistantMsg: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: res.ok ? (data.response ?? JSON.stringify(data, null, 2)) : (data.error ?? 'Unknown error'),
        skill: data.skill,
        confidence: data.confidence,
        rating: data.rating,
        error: !res.ok,
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: 'assistant', content: 'Network error — is the server running?', error: true },
      ]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }

  async function giveFeedback(msg: Message, positive: boolean) {
    if (!msg.skill || msg.feedbackGiven) return;
    setMessages((prev) =>
      prev.map((m) => (m.id === msg.id ? { ...m, feedbackGiven: positive ? 'up' : 'down' } : m)),
    );
    await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skillName: msg.skill, positive }),
    });
  }

  function clearConversation() {
    setMessages([]);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  }

  return (
    <div className="flex h-full min-h-screen bg-zinc-50 dark:bg-zinc-950">
      {/* Sidebar */}
      <SkillsSidebar
        skills={skills}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        activeTab={sidebarTab}
        onTabChange={setSidebarTab}
      />

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="p-2 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition text-zinc-500"
              title="Toggle sidebar"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 12h18M3 6h18M3 18h18" />
              </svg>
            </button>
            <div className="w-7 h-7 rounded-full bg-black dark:bg-white flex items-center justify-center text-white dark:text-black font-bold text-xs select-none">
              O
            </div>
            <div>
              <h1 className="font-semibold text-sm text-black dark:text-white">AgentOctopus</h1>
              <p className="text-[11px] text-zinc-400">{skills.length} skills loaded</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <a
              href="/marketplace"
              className="text-xs px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition"
            >
              Marketplace
            </a>
            {messages.length > 0 && (
              <button
                onClick={clearConversation}
                className="text-xs px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition"
                title="Clear conversation"
              >
                Clear
              </button>
            )}
            <button
              onClick={() => setDarkMode(!darkMode)}
              className="p-2 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition text-zinc-500"
              title="Toggle dark mode"
            >
              {darkMode ? '☀️' : '🌙'}
            </button>
          </div>
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-6 space-y-4 max-w-2xl w-full mx-auto">
          {messages.length === 0 && (
            <div className="text-center pt-16">
              <div className="w-16 h-16 rounded-full bg-black dark:bg-white flex items-center justify-center text-white dark:text-black font-bold text-2xl mx-auto mb-4 select-none">
                O
              </div>
              <h2 className="text-lg font-semibold text-zinc-800 dark:text-zinc-100 mb-2">AgentOctopus</h2>
              <p className="text-zinc-400 dark:text-zinc-500 text-sm mb-6">
                Ask anything — routes your request to the best skill automatically.
              </p>
              <div className="flex flex-col gap-2 items-center">
                {EXAMPLE_QUERIES.map((q) => (
                  <button
                    key={q}
                    onClick={() => sendMessage(q)}
                    className="text-sm px-4 py-2 rounded-full border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg) => (
            <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] ${msg.role === 'user' ? 'items-end' : 'items-start'} flex flex-col`}>
                <div
                  className={`rounded-2xl px-4 py-3 text-sm whitespace-pre-wrap leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-black dark:bg-white text-white dark:text-black rounded-br-sm'
                      : msg.error
                      ? 'bg-red-50 dark:bg-red-950 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800 rounded-bl-sm'
                      : 'bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-100 border border-zinc-200 dark:border-zinc-700 rounded-bl-sm'
                  }`}
                >
                  {msg.content}
                </div>

                {msg.role === 'assistant' && msg.skill && (
                  <div className="mt-1.5 flex items-center gap-2">
                    <SkillBadge skill={msg.skill} confidence={msg.confidence ?? 0} rating={msg.rating ?? 0} />
                    <div className="flex gap-1 ml-1">
                      <button
                        onClick={() => giveFeedback(msg, true)}
                        disabled={!!msg.feedbackGiven}
                        title="Helpful"
                        className={`text-base transition-opacity ${
                          msg.feedbackGiven === 'up'
                            ? 'opacity-100'
                            : msg.feedbackGiven
                            ? 'opacity-20'
                            : 'opacity-50 hover:opacity-100'
                        }`}
                      >
                        👍
                      </button>
                      <button
                        onClick={() => giveFeedback(msg, false)}
                        disabled={!!msg.feedbackGiven}
                        title="Not helpful"
                        className={`text-base transition-opacity ${
                          msg.feedbackGiven === 'down'
                            ? 'opacity-100'
                            : msg.feedbackGiven
                            ? 'opacity-20'
                            : 'opacity-50 hover:opacity-100'
                        }`}
                      >
                        👎
                      </button>
                    </div>
                  </div>
                )}

                {msg.role === 'assistant' && !msg.skill && !msg.error && (
                  <span className="mt-1 text-[11px] text-zinc-400 dark:text-zinc-500 italic">
                    Answered by LLM (no skill matched)
                  </span>
                )}
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex justify-start">
              <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-2xl rounded-bl-sm px-4 py-3">
                <div className="flex gap-1 items-center h-4">
                  <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-bounce [animation-delay:0ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-bounce [animation-delay:150ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-bounce [animation-delay:300ms]" />
                </div>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="border-t border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-4">
          <div className="max-w-2xl mx-auto flex gap-2 items-end">
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask AgentOctopus anything..."
              className="flex-1 resize-none rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-black dark:focus:ring-white transition"
              style={{ maxHeight: 160 }}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = 'auto';
                el.style.height = `${el.scrollHeight}px`;
              }}
            />
            <button
              onClick={() => sendMessage(input)}
              disabled={!input.trim() || loading}
              className="shrink-0 rounded-xl bg-black dark:bg-white text-white dark:text-black px-4 py-3 text-sm font-medium disabled:opacity-30 hover:opacity-80 transition"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
