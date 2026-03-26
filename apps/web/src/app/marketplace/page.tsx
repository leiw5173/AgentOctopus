'use client';

import { useState, useEffect } from 'react';

interface MarketplaceSkill {
  slug: string;
  name: string;
  description: string;
  tags: string[];
  version: string;
  author: string;
  adapter: string;
  downloads: number;
  rating: number;
  publishedAt: string;
}

export default function MarketplacePage() {
  const [skills, setSkills] = useState<MarketplaceSkill[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  useEffect(() => {
    fetchSkills();
  }, []);

  async function fetchSkills(query = '') {
    setLoading(true);
    try {
      const url = query ? `/api/marketplace?q=${encodeURIComponent(query)}` : '/api/marketplace';
      const res = await fetch(url);
      const data = await res.json();
      setSkills(data.skills || []);
    } catch {
      setSkills([]);
    } finally {
      setLoading(false);
    }
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    fetchSkills(search);
  }

  async function installSkill(slug: string) {
    setInstalling(slug);
    setMessage(null);
    try {
      const res = await fetch('/api/marketplace/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ text: `Installed "${slug}" successfully. Restart server to activate.`, type: 'success' });
        fetchSkills(search); // refresh downloads count
      } else {
        setMessage({ text: data.error || 'Install failed', type: 'error' });
      }
    } catch {
      setMessage({ text: 'Network error', type: 'error' });
    } finally {
      setInstalling(null);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      {/* Header */}
      <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <a
              href="/"
              className="w-8 h-8 rounded-full bg-black dark:bg-white flex items-center justify-center text-white dark:text-black font-bold text-sm select-none"
            >
              O
            </a>
            <div>
              <h1 className="font-semibold text-sm text-black dark:text-white">Skill Marketplace</h1>
              <p className="text-xs text-zinc-400">Browse and install community skills</p>
            </div>
          </div>
          <a
            href="/"
            className="text-xs px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition"
          >
            Back to Chat
          </a>
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-6 py-8">
        {/* Search */}
        <form onSubmit={handleSearch} className="mb-8">
          <div className="flex gap-2">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search skills..."
              className="flex-1 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-black dark:focus:ring-white transition"
            />
            <button
              type="submit"
              className="rounded-xl bg-black dark:bg-white text-white dark:text-black px-5 py-3 text-sm font-medium hover:opacity-80 transition"
            >
              Search
            </button>
          </div>
        </form>

        {/* Message */}
        {message && (
          <div
            className={`mb-6 px-4 py-3 rounded-xl text-sm ${
              message.type === 'success'
                ? 'bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-300 border border-green-200 dark:border-green-800'
                : 'bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800'
            }`}
          >
            {message.text}
          </div>
        )}

        {/* Skills grid */}
        {loading ? (
          <div className="text-center py-16 text-zinc-400">Loading...</div>
        ) : skills.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-zinc-400 dark:text-zinc-500 mb-4">
              {search ? `No skills found for "${search}"` : 'No skills in the marketplace yet.'}
            </p>
            <p className="text-zinc-400 dark:text-zinc-500 text-sm">
              Publish a skill with <code className="px-1.5 py-0.5 bg-zinc-100 dark:bg-zinc-800 rounded font-mono text-xs">octopus publish</code>
            </p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {skills.map((skill) => (
              <div
                key={skill.slug}
                className="p-5 rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:shadow-sm transition"
              >
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <h3 className="font-semibold text-sm text-zinc-800 dark:text-zinc-100">{skill.name}</h3>
                    <p className="text-xs text-zinc-400 mt-0.5">
                      by {skill.author} &middot; v{skill.version}
                    </p>
                  </div>
                  <button
                    onClick={() => installSkill(skill.slug)}
                    disabled={installing === skill.slug}
                    className="text-xs px-3 py-1.5 rounded-lg bg-black dark:bg-white text-white dark:text-black font-medium hover:opacity-80 disabled:opacity-50 transition"
                  >
                    {installing === skill.slug ? 'Installing...' : 'Install'}
                  </button>
                </div>

                <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-3 line-clamp-2">{skill.description}</p>

                <div className="flex items-center gap-3 text-xs text-zinc-400">
                  <span>★ {skill.rating.toFixed(1)}</span>
                  <span>{skill.downloads} downloads</span>
                  <span className="px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 font-mono">{skill.adapter}</span>
                </div>

                {skill.tags.length > 0 && (
                  <div className="flex gap-1 mt-3 flex-wrap">
                    {skill.tags.map((t) => (
                      <span
                        key={t}
                        className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
