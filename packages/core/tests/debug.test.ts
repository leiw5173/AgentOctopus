import { describe, it, expect, vi, afterEach } from 'vitest';
import { dbg } from '../src/debug.js';

describe('dbg', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes dim debug line to stdout when enabled', () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    dbg(true, 'hello world');

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('[debug]');
    expect(writes[0]).toContain('hello world');
  });

  it('does nothing when disabled', () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    dbg(false, 'should not appear');

    expect(writes).toHaveLength(0);
  });
});
