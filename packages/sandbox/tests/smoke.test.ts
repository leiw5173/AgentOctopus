import { describe, it, expect } from 'vitest';
import { SANDBOX_PACKAGE } from '../src/index.js';

describe('sandbox package scaffold', () => {
  it('exports a package marker', () => {
    expect(SANDBOX_PACKAGE).toBe('@agentoctopus/sandbox');
  });
});
