import { ensurePrivateDirectory } from "./private-directory.js";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  clearRememberedAccounts,
  loadAccountStore,
  rememberAccount,
  withAccountStorageDirectory,
} from "../auth/accounts.js";
import { getApiKey, refreshAntigravityToken } from "../auth/oauth.js";
import type { AntigravityOAuthCredentials } from "../types/types.js";

// Shared across runners in this process: concurrent sessions must not refresh twice.
const locks = new Map<string, Promise<unknown>>();

export function desktopDataDirectory(): string {
  return resolve(
    process.env.PI_ANTIGRAVITY_DESKTOP_DATA_DIR || join(homedir(), ".pi", "desktop-antigravity"),
  );
}

export class DesktopAuthStore {
  readonly directory: string;
  private readonly refresh: typeof refreshAntigravityToken;

  constructor(directory = desktopDataDirectory(), refresh = refreshAntigravityToken) {
    this.directory = resolve(directory);
    this.refresh = refresh;
  }
  scoped<T>(operation: () => T, signal?: AbortSignal): T {
    return withAccountStorageDirectory(this.directory, operation, signal);
  }

  private async exclusive<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = locks.get(this.directory) || Promise.resolve();
    const pending = previous
      .catch(() => {})
      .then(() => {
        signal?.throwIfAborted();
        return this.scoped(operation, signal);
      });
    locks.set(this.directory, pending);
    try {
      return await pending;
    } finally {
      if (locks.get(this.directory) === pending) locks.delete(this.directory);
    }
  }

  status(): { signedIn: boolean; email?: string } {
    return this.scoped(() => {
      const store = loadAccountStore();
      const account = store.activeAccountId ? store.accounts[store.activeAccountId] : undefined;
      return { signedIn: Boolean(account), email: account?.email };
    });
  }

  async save(credentials: AntigravityOAuthCredentials, signal?: AbortSignal): Promise<void> {
    await this.exclusive(async () => {
      signal?.throwIfAborted();
      if (!credentials.access || !credentials.refresh || !Number.isFinite(credentials.expires)) {
        throw new Error("Google did not return valid credentials.");
      }
      await ensurePrivateDirectory(this.directory, signal);
      signal?.throwIfAborted();
      rememberAccount(credentials);
    }, signal);
  }

  async apiKey(signal?: AbortSignal): Promise<string> {
    return this.exclusive(async () => {
      const store = loadAccountStore();
      const current = store.activeAccountId ? store.accounts[store.activeAccountId] : undefined;
      if (!current) throw new Error("尚未登录 Antigravity，请运行 /antigravity.login。");
      let credentials: AntigravityOAuthCredentials = current;
      if (
        !current.access ||
        !Number.isFinite(current.expires) ||
        current.expires <= Date.now() + 5 * 60 * 1000
      ) {
        const refreshSignal = signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
          : AbortSignal.timeout(30000);
        credentials = await this.refresh(current, refreshSignal);
        refreshSignal.throwIfAborted();
        if (!credentials.access || !credentials.refresh || !Number.isFinite(credentials.expires)) {
          throw new Error("Google did not return valid refreshed credentials.");
        }
        rememberAccount(credentials);
      }
      return getApiKey(credentials);
    }, signal);
  }

  async logout(signal?: AbortSignal): Promise<void> {
    await this.exclusive(async () => {
      if (!this.status().signedIn) return;
      signal?.throwIfAborted();
      clearRememberedAccounts();
    }, signal);
  }
}
