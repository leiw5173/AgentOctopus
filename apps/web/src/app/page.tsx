'use client';

import { useState, useRef, useEffect } from 'react';

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

const EXAMPLE_QUERIES = [
  'What\'s the weather in Tokyo?',
  'Translate "good morning" to Japanese',
  'Lookup IP 8.8.8.8',
];

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

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

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
    } catch (err) {
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
      prev.map((m) => (m.id === msg.id ? { ...m, feedbackGiven: positive ? 'up' : 'down' } : m))
    );
    await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skillName: msg.skill, positive }),
    });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  }

  return (
    <div className="flex flex-col h-full min-h-screen bg-zinc-50 dark:bg-zinc-950">
      {/* Header */}
      <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-6 py-4 flex items-center gap-3">
        <div className="w-8 h-8 rounded-full bg-black dark:bg-white flex items-center justify-center text-white dark:text-black font-bold text-sm select-none">
          O
        </div>
        <div>
          <h1 className="font-semibold text-sm text-black dark:text-white">AgentOctopus</h1>
          <p className="text-xs text-zinc-400">Intelligent skill routing demo</p>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-4 max-w-2xl w-full mx-auto">
        {messages.length === 0 && (
          <div className="text-center pt-16">
            <p className="text-zinc-400 dark:text-zinc-500 text-sm mb-6">
              Ask anything — AgentOctopus routes your request to the best skill.
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
            placeholder="Ask AgentOctopus anything… (Enter to send, Shift+Enter for newline)"
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
  );
}
