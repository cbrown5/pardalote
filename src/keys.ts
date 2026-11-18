/*
 * API keys, encrypted at rest.
 * A passphrase is stretched with PBKDF2 (600,000 iterations, SHA-256) into an AES-GCM key.
 * Only ciphertext, salt and IVs are stored (IndexedDB). Unlocked keys live in memory only.
 */
import type { ProviderId } from './providers';

export const PBKDF2_ITERATIONS = 600_000;
const CHECK_PLAINTEXT = 'pardalote-vault-v1';

interface Sealed { iv: string; ct: string }

export interface VaultFile {
  format: 'pardalote-keys';
  version: 1;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  check: Sealed;
  keys: Partial<Record<ProviderId, Sealed>>;
}

const b64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function deriveKey(passphrase: string, salt: Uint8Array, iterations = PBKDF2_ITERATIONS): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function seal(key: CryptoKey, plaintext: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return { iv: b64(iv), ct: b64(ct) };
}

export async function open(key: CryptoKey, s: Sealed): Promise<string> {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(s.iv) as BufferSource }, key, unb64(s.ct) as BufferSource);
  return new TextDecoder().decode(pt);
}

export async function newVault(passphrase: string): Promise<{ vault: VaultFile; key: CryptoKey }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(passphrase, salt);
  const vault: VaultFile = {
    format: 'pardalote-keys',
    version: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt: b64(salt) },
    check: await seal(key, CHECK_PLAINTEXT),
    keys: {},
  };
  return { vault, key };
}

/** Returns the derived key and decrypted provider keys, or throws on a wrong passphrase. */
export async function unlockVault(vault: VaultFile, passphrase: string) {
  const key = await deriveKey(passphrase, unb64(vault.kdf.salt), vault.kdf.iterations);
  try {
    if ((await open(key, vault.check)) !== CHECK_PLAINTEXT) throw new Error();
  } catch {
    throw new Error('Wrong passphrase.');
  }
  const keys: Partial<Record<ProviderId, string>> = {};
  for (const [p, s] of Object.entries(vault.keys)) keys[p as ProviderId] = await open(key, s!);
  return { key, keys };
}

export function isVaultFile(x: unknown): x is VaultFile {
  const v = x as VaultFile;
  return !!v && v.format === 'pardalote-keys' && v.version === 1 && !!v.kdf?.salt && !!v.check?.ct && typeof v.keys === 'object';
}

/* ------------------------------------------------------------------ */
/* Tiny IndexedDB key-value store                                        */
/* ------------------------------------------------------------------ */

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('pardalote', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function kvGet<T>(k: string): Promise<T | undefined> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction('kv').objectStore('kv').get(k);
    r.onsuccess = () => resolve(r.result as T | undefined);
    r.onerror = () => reject(r.error);
  });
}

export async function kvSet(k: string, v: unknown): Promise<void> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('kv', 'readwrite');
    if (v === undefined) tx.objectStore('kv').delete(k);
    else tx.objectStore('kv').put(v, k);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ------------------------------------------------------------------ */
/* Keyring: the in-memory state the UI talks to                          */
/* ------------------------------------------------------------------ */

export class Keyring {
  vault: VaultFile | null = null;
  private cryptoKey: CryptoKey | null = null;
  /** Unlocked keys and session-only keys, in memory. */
  private plain: Partial<Record<ProviderId, string>> = {};
  private sessionOnly = new Set<ProviderId>();

  async load() {
    const v = await kvGet<VaultFile>('vault');
    this.vault = v && isVaultFile(v) ? v : null;
  }
  get hasVault() { return !!this.vault; }
  get unlocked() { return !!this.cryptoKey; }
  storedProviders(): ProviderId[] { return Object.keys(this.vault?.keys ?? {}) as ProviderId[]; }
  get(p: ProviderId): string | null { return this.plain[p] ?? null; }
  isSessionOnly(p: ProviderId) { return this.sessionOnly.has(p); }

  async create(passphrase: string) {
    const { vault, key } = await newVault(passphrase);
    // Carry over any keys already unlocked or entered this session.
    for (const [p, k] of Object.entries(this.plain)) if (!this.sessionOnly.has(p as ProviderId)) vault.keys[p as ProviderId] = await seal(key, k!);
    this.vault = vault;
    this.cryptoKey = key;
    await kvSet('vault', vault);
  }

  async unlock(passphrase: string) {
    if (!this.vault) throw new Error('No saved keys.');
    const { key, keys } = await unlockVault(this.vault, passphrase);
    this.cryptoKey = key;
    this.plain = { ...keys, ...Object.fromEntries([...this.sessionOnly].map((p) => [p, this.plain[p]])) };
  }

  lock() {
    this.cryptoKey = null;
    for (const p of Object.keys(this.plain) as ProviderId[]) if (!this.sessionOnly.has(p)) delete this.plain[p];
  }

  async set(p: ProviderId, apiKey: string, sessionOnly: boolean) {
    this.plain[p] = apiKey;
    if (sessionOnly) {
      this.sessionOnly.add(p);
      return;
    }
    this.sessionOnly.delete(p);
    if (!this.vault || !this.cryptoKey) throw new Error('Unlock or create your key store first.');
    this.vault.keys[p] = await seal(this.cryptoKey, apiKey);
    await kvSet('vault', this.vault);
  }

  async remove(p: ProviderId) {
    delete this.plain[p];
    this.sessionOnly.delete(p);
    if (this.vault?.keys[p]) {
      delete this.vault.keys[p];
      await kvSet('vault', this.vault);
    }
  }

  async forgetAll() {
    this.vault = null;
    this.cryptoKey = null;
    this.plain = {};
    this.sessionOnly.clear();
    await kvSet('vault', undefined);
  }

  exportFile(): string {
    if (!this.vault) throw new Error('Nothing to export.');
    return JSON.stringify(this.vault, null, 2);
  }

  async importFile(json: string) {
    let parsed: unknown;
    try { parsed = JSON.parse(json); } catch { throw new Error('That file is not a Pardalote key file.'); }
    if (!isVaultFile(parsed)) throw new Error('That file is not a Pardalote key file.');
    this.vault = parsed;
    this.cryptoKey = null;
    this.lock();
    await kvSet('vault', parsed);
  }
}
