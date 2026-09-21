import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getSystemThemeSnapshot,
  getServerThemeSnapshot,
  subscribeToSystemTheme,
} from '../src/app/theme-store.js';

describe('system theme', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renders light on the server even without browser APIs', () => {
    expect(getServerThemeSnapshot()).toBe(false);
  });

  it('reads the current browser preference on every snapshot', () => {
    const mediaQuery = { matches: false };
    const matchMedia = vi.fn(() => mediaQuery);
    vi.stubGlobal('window', { matchMedia });

    expect(getSystemThemeSnapshot()).toBe(false);
    mediaQuery.matches = true;
    expect(getSystemThemeSnapshot()).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
  });

  it('notifies subscribers on changes and removes its listener on cleanup', () => {
    const listeners = new Set<() => void>();
    vi.stubGlobal('window', {
      matchMedia: () => ({
        addEventListener: (_event: string, callback: () => void) => listeners.add(callback),
        removeEventListener: (_event: string, callback: () => void) => listeners.delete(callback),
      }),
    });
    const onChange = vi.fn();
    const unsubscribe = subscribeToSystemTheme(onChange);

    for (const listener of listeners) listener();
    expect(onChange).toHaveBeenCalledTimes(1);

    unsubscribe();
    for (const listener of listeners) listener();
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
