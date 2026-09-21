'use client';

import { useSyncExternalStore } from 'react';

const DARK_MODE_QUERY = '(prefers-color-scheme: dark)';

export function getServerThemeSnapshot(): false {
  return false;
}

export function getSystemThemeSnapshot(): boolean {
  return window.matchMedia(DARK_MODE_QUERY).matches;
}

export function subscribeToSystemTheme(onChange: () => void): () => void {
  const mediaQuery = window.matchMedia(DARK_MODE_QUERY);
  mediaQuery.addEventListener('change', onChange);
  return () => mediaQuery.removeEventListener('change', onChange);
}

export function useSystemDarkMode(): boolean {
  return useSyncExternalStore(
    subscribeToSystemTheme,
    getSystemThemeSnapshot,
    getServerThemeSnapshot,
  );
}
