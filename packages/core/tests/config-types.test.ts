import { describe, it, expect } from 'vitest';
import { GatewayConfigSchema } from '../src/config-types.js';

describe('GatewayConfigSchema.debugEndpoints', () => {
  it('defaults to disabled with includeQuery false and bufferSize 10', () => {
    const c = GatewayConfigSchema.parse({});
    expect(c.debugEndpoints).toEqual({ enabled: false, includeQuery: false, bufferSize: 10 });
  });
  it('accepts an explicit object', () => {
    const c = GatewayConfigSchema.parse({ debugEndpoints: { enabled: true, includeQuery: true, bufferSize: 25 } });
    expect(c.debugEndpoints).toEqual({ enabled: true, includeQuery: true, bufferSize: 25 });
  });
});
