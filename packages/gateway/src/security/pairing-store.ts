import fs from 'fs';
import path from 'path';
import os from 'os';
import { createHash, randomBytes } from 'crypto';

const PAIRING_PATH = path.join(os.homedir(), '.agentoctopus', 'pairing.json');

export interface PairedPeer {
  peerId: string;
  channelType: string;
  pairedAt: string;
  label?: string;
}

export interface PairingStore {
  peers: PairedPeer[];
  pending: Record<string, { code: string; expiresAt: number }>;
}

function loadStore(): PairingStore {
  try {
    if (fs.existsSync(PAIRING_PATH)) {
      return JSON.parse(fs.readFileSync(PAIRING_PATH, 'utf8')) as PairingStore;
    }
  } catch {
    // ignore corrupt file
  }
  return { peers: [], pending: {} };
}

function saveStore(store: PairingStore): void {
  fs.mkdirSync(path.dirname(PAIRING_PATH), { recursive: true });
  fs.writeFileSync(PAIRING_PATH, JSON.stringify(store, null, 2), 'utf8');
}

function makeKey(peerId: string, channelType: string): string {
  return createHash('sha256').update(`${channelType}:${peerId}`).digest('hex').slice(0, 16);
}

export function isPaired(peerId: string, channelType: string): boolean {
  const store = loadStore();
  const key = makeKey(peerId, channelType);
  return store.peers.some((p) => makeKey(p.peerId, p.channelType) === key);
}

export function generatePairingCode(peerId: string, channelType: string): string {
  const store = loadStore();
  const code = randomBytes(3).toString('hex').toUpperCase();
  store.pending[peerId] = { code, expiresAt: Date.now() + 10 * 60 * 1000 }; // 10 min expiry
  saveStore(store);
  return code;
}

export function validatePairingCode(peerId: string, code: string): boolean {
  const store = loadStore();
  const pending = store.pending[peerId];
  if (!pending) return false;
  if (Date.now() > pending.expiresAt) {
    delete store.pending[peerId];
    saveStore(store);
    return false;
  }
  if (pending.code !== code.toUpperCase()) return false;

  // Mark as paired
  delete store.pending[peerId];
  store.peers.push({ peerId, channelType: 'unknown', pairedAt: new Date().toISOString() });
  saveStore(store);
  return true;
}

export function approvePeer(peerId: string, channelType: string, label?: string): void {
  const store = loadStore();
  const key = makeKey(peerId, channelType);
  if (!store.peers.some((p) => makeKey(p.peerId, p.channelType) === key)) {
    store.peers.push({ peerId, channelType, pairedAt: new Date().toISOString(), label });
    saveStore(store);
  }
}

export function revokePeer(peerId: string, channelType: string): void {
  const store = loadStore();
  const key = makeKey(peerId, channelType);
  store.peers = store.peers.filter((p) => makeKey(p.peerId, p.channelType) !== key);
  saveStore(store);
}

export function listPeers(): PairedPeer[] {
  return loadStore().peers;
}
