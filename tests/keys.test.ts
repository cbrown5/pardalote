import { describe, it, expect } from 'vitest';
import { newVault, seal, unlockVault, isVaultFile } from '../src/keys';

describe('key vault crypto', () => {
  it('round-trips keys and rejects a wrong passphrase', async () => {
    const { vault, key } = await newVault('correct horse battery staple');
    vault.keys.anthropic = await seal(key, 'sk-ant-test');
    const copy = JSON.parse(JSON.stringify(vault));
    expect(isVaultFile(copy)).toBe(true);
    expect(JSON.stringify(copy)).not.toContain('sk-ant-test');
    const { keys } = await unlockVault(copy, 'correct horse battery staple');
    expect(keys.anthropic).toBe('sk-ant-test');
    await expect(unlockVault(copy, 'wrong')).rejects.toThrow(/Wrong passphrase/);
  }, 20000);
});
