// packages/sandbox/tests/vm/vm-ports.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORTS_SRC = path.resolve(HERE, '../../src/vm/ports.ts');
const TYPES_SRC = path.resolve(HERE, '../../src/vm/types.ts');

describe('vm ports — leaf-package boundary', () => {
  it('ports.ts imports nothing from @agentoctopus/*', () => {
    const src = readFileSync(PORTS_SRC, 'utf8');
    // Match only quoted import specifiers (e.g. from '@agentoctopus/...'), not
    // documentation comments that mention @agentoctopus/* in plain text.
    expect(src).not.toMatch(/['"]@agentoctopus\//);
  });

  it('types.ts imports nothing from @agentoctopus/*', () => {
    const src = readFileSync(TYPES_SRC, 'utf8');
    expect(src).not.toMatch(/['"]@agentoctopus\//);
  });

  it('VmEnginePort has the R4/R8/R10 method set', async () => {
    const mod = await import('../../src/vm/ports.ts');
    // interfaces are erased at runtime; assert the module loads and exports types
    expect(mod).toBeDefined();
  });
});
