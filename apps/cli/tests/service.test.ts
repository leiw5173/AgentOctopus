import { describe, expect, it } from 'vitest';

import { startService } from '../src/service.js';

describe('service helpers', () => {
  it('exports a startService function', () => {
    expect(typeof startService).toBe('function');
  });
});
