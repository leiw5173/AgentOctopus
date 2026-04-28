import type { FSWatcher } from "fs";
import { watch } from "fs";

type SkillsChangeListener = () => void;
const listeners = new Set<SkillsChangeListener>();

export function registerSkillsChangeListener(listener: SkillsChangeListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function bumpSnapshotVersion(): void {
  for (const listener of listeners) {
    try { listener(); } catch { /* swallow */ }
  }
}

export function watchSkillsDir(dirPath: string, debounceMs = 500): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(dirPath, { recursive: true }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => bumpSnapshotVersion(), debounceMs);
    });
  } catch {
    // fs.watch is not available on all platforms — graceful no-op
  }
  return () => {
    if (timer) clearTimeout(timer);
    if (watcher) watcher.close();
  };
}
