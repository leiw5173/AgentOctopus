'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useSystemDarkMode } from './theme-store';

interface ThemeContextValue {
  darkMode: boolean;
  toggleDarkMode: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemDarkMode = useSystemDarkMode();
  const [darkModeOverride, setDarkModeOverride] = useState<boolean | null>(null);
  const darkMode = darkModeOverride ?? systemDarkMode;

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
  }, [darkMode]);

  function toggleDarkMode() {
    setDarkModeOverride((current) => !(current ?? systemDarkMode));
  }

  return (
    <ThemeContext.Provider value={{ darkMode, toggleDarkMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error('useTheme requires ThemeProvider');
  return theme;
}
