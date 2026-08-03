import { describe, it, expect } from 'vitest';
import { resolveAndPin, type DnsLookup } from '../src/proxy/dns.js';

const publicLookup: DnsLookup = async () => [{ address: '203.0.113.10', family: 4 }];
const forbidden = (address: string) => address.startsWith('127.') || address.startsWith('10.') || address.startsWith('169.254.');

describe('resolveAndPin', () => {
  it('returns a deterministic public address from the injected resolver', async () => {
    expect(await resolveAndPin('example.test', {
      lookup: publicLookup, isForbiddenAddress: forbidden, allowPrivateLiteral: false,
    })).toBe('203.0.113.10');
  });

  it('allows an explicitly granted private IP literal', async () => {
    expect(await resolveAndPin('127.0.0.1', {
      isForbiddenAddress: forbidden, allowPrivateLiteral: true,
    })).toBe('127.0.0.1');
  });

  it('rejects an ungranted private literal', async () => {
    await expect(resolveAndPin('127.0.0.1', {
      isForbiddenAddress: forbidden, allowPrivateLiteral: false,
    })).rejects.toThrow(/forbidden literal/);
  });

  it('rejects a hostname when any DNS answer is private/link-local', async () => {
    const rebindingLookup: DnsLookup = async () => [
      { address: '203.0.113.10', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ];
    await expect(resolveAndPin('granted.example', {
      lookup: rebindingLookup, isForbiddenAddress: forbidden, allowPrivateLiteral: false,
    })).rejects.toThrow(/forbidden DNS answer/);
  });

  it('rejects an unresolvable host', async () => {
    await expect(resolveAndPin('no-such-host.invalid', {
      lookup: async () => [], isForbiddenAddress: forbidden, allowPrivateLiteral: false,
    })).rejects.toThrow(/no addresses/);
  });
});
