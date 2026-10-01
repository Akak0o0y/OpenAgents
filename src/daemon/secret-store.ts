import { spawn } from 'node:child_process';

/**
 * Protects provider credentials at rest. Plaintext never leaves the daemon: settings reads, model context, logs,
 * telemetry, browser tools and Obsidian exports only ever see whether a key is configured.
 */
export interface SecretStore {
  availability(): Promise<{ available: boolean; backend: string; reason?: string }>;
  /** Returns an opaque ciphertext suitable for persistence. */
  protect(plaintext: string): Promise<string>;
  unprotect(ciphertext: string): Promise<string>;
}

export class SecretStoreError extends Error {
  override readonly name = 'SecretStoreError';
}

// Application-specific entropy binds the ciphertext to this purpose; it is not itself a secret.
// Compatibility constant: every saved provider key is bound to this exact text, so it keeps the pre-0.6.0 product name.
const DPAPI_SCRIPT = (operation: 'Protect' | 'Unprotect') => [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Security',
  "$entropy = [Text.Encoding]::UTF8.GetBytes('OpenHours provider credential v1')",
  '$data = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
  `$out = [Security.Cryptography.ProtectedData]::${operation}($data, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)`,
  '[Console]::Out.Write([Convert]::ToBase64String($out))',
].join('; ');

/** A slow PowerShell start is worth waiting out twice; a real failure is not. */
const DPAPI_ATTEMPTS = 3;
const DPAPI_RETRY_DELAY_MS = 500;

/** Windows DPAPI for the current Windows user, through the built-in PowerShell. Values travel on stdin, never argv. */
export class WindowsDpapiSecretStore implements SecretStore {
  private probed?: Promise<{ available: boolean; backend: string; reason?: string }>;

  constructor(private readonly timeoutMs = 15_000) {}

  availability() {
    this.probed ??= (async () => {
      if (process.platform !== 'win32') return { available: false, backend: 'windows-dpapi', reason: 'Windows DPAPI is only available on Windows.' };
      try {
        const probe = 'openhours-secret-store-probe';
        const ok = (await this.unprotect(await this.protect(probe))) === probe;
        return ok ? { available: true, backend: 'windows-dpapi' } : { available: false, backend: 'windows-dpapi', reason: 'DPAPI round trip returned different data.' };
      } catch (error) {
        return { available: false, backend: 'windows-dpapi', reason: `Protected storage is unavailable: ${error instanceof Error ? error.message : String(error)}` };
      }
    })();
    return this.probed;
  }

  protect(plaintext: string) { return this.run('Protect', Buffer.from(plaintext, 'utf8').toString('base64')); }

  async unprotect(ciphertext: string) { return Buffer.from(await this.run('Unprotect', ciphertext), 'base64').toString('utf8'); }

  /**
   * Retry a timeout, and only a timeout.
   *
   * This spawns PowerShell, which on a loaded machine can take longer to start than the
   * whole budget allows. The failure then surfaced as "the stored gateway key could not be
   * unlocked", and every scheduled run failed until someone replaced a key that was never
   * wrong. Nothing left this computer and nothing was decrypted, so asking again is free.
   * A genuine failure - wrong user, corrupt ciphertext, PowerShell missing - is not
   * retried, because repeating it would only delay the real message.
   */
  private async run(operation: 'Protect' | 'Unprotect', input: string): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      try { return await this.runOnce(operation, input); }
      catch (error) {
        const timedOut = error instanceof SecretStoreError && /timed out/.test(error.message);
        if (!timedOut || attempt >= DPAPI_ATTEMPTS) throw error;
        await new Promise(resolve => setTimeout(resolve, attempt * DPAPI_RETRY_DELAY_MS));
      }
    }
  }

  private runOnce(operation: 'Protect' | 'Unprotect', input: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', DPAPI_SCRIPT(operation)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { child.kill(); reject(new SecretStoreError(`DPAPI ${operation.toLowerCase()} timed out.`)); }, this.timeoutMs);
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
      child.on('error', error => { clearTimeout(timer); reject(new SecretStoreError(`PowerShell could not start: ${error.message}`)); });
      child.on('close', code => {
        clearTimeout(timer);
        // stderr can only contain PowerShell diagnostics; the plaintext is never echoed.
        if (code === 0 && stdout.trim()) resolve(stdout.trim());
        else reject(new SecretStoreError(`DPAPI ${operation.toLowerCase()} failed${stderr.trim() ? `: ${stderr.trim().split(/\r?\n/)[0]}` : '.'}`));
      });
      child.stdin.end(input);
    });
  }
}

/** Reports honestly that keys cannot be protected here, so none is ever stored in plain text. */
export class UnavailableSecretStore implements SecretStore {
  constructor(private readonly reason: string) {}
  async availability() { return { available: false, backend: 'none', reason: this.reason }; }
  async protect(): Promise<string> { throw new SecretStoreError(this.reason); }
  async unprotect(): Promise<string> { throw new SecretStoreError(this.reason); }
}

/** Test-only reversible store. Never used by the daemon. */
export class MemorySecretStore implements SecretStore {
  protectCalls = 0;
  constructor(private readonly options: { available?: boolean; failProtect?: boolean } = {}) {}
  async availability() { return this.options.available === false ? { available: false, backend: 'memory', reason: 'Fixture store disabled.' } : { available: true, backend: 'memory' }; }
  async protect(plaintext: string) {
    this.protectCalls++;
    if (this.options.failProtect) throw new SecretStoreError('Fixture protect failure.');
    return `memory:${Buffer.from(plaintext, 'utf8').toString('base64')}`;
  }
  async unprotect(ciphertext: string) {
    if (!ciphertext.startsWith('memory:')) throw new SecretStoreError('Not a fixture ciphertext.');
    return Buffer.from(ciphertext.slice(7), 'base64').toString('utf8');
  }
}

export function createDefaultSecretStore(): SecretStore {
  return process.platform === 'win32'
    ? new WindowsDpapiSecretStore()
    : new UnavailableSecretStore('Protected credential storage is not implemented for this operating system yet, so provider keys cannot be saved.');
}
