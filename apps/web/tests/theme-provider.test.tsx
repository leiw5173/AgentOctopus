import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThemeProvider, useTheme } from '../src/app/theme-provider.js';

function ThemeLabel() {
  const { darkMode } = useTheme();
  return <span>{darkMode ? 'dark' : 'light'}</span>;
}

describe('theme provider', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('prerenders the light snapshot even when the browser prefers dark', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    expect(renderToStaticMarkup(<ThemeProvider><ThemeLabel /></ThemeProvider>))
      .toContain('<span>light</span>');
  });
});
