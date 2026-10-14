/**
 * Shared setup for the token generator end-to-end tests: builds the server
 * through createTokenGenerator (src/token-generator/server) with every file in a temp folder,
 * listens on a free port and talks to it over real HTTP.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { Express } from 'express';

export interface TokenGeneratorOptions {
  port?: number | string;
  envPath?: string;
  backupDir?: string;
  accountsFile?: string;
  keyFile?: string;
  logDir?: string;
}

export interface TokenGeneratorInstance {
  app: Express;
  envManager: { envPath: string; backupDir: string };
  accountManager: { accountsFile: string; keyFile: string };
  port: number | string;
  redirectUri: string;
  start(): Server;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
export const { createTokenGenerator } = require('../../../src/token-generator/server') as {
  createTokenGenerator: (options?: TokenGeneratorOptions) => TokenGeneratorInstance;
};

/** Account record as stored by AccountManager (only the fields the tests read) */
export interface StoredAccount {
  name: string;
  accessToken: string | null;
  refreshToken: string | null;
  tokenScopes: string[];
  broadcasterAccessToken: string | null;
  broadcasterRefreshToken: string | null;
  broadcasterScopes: string[];
  tokenExpiresAt: string | null;
  broadcasterTokenExpiresAt: string | null;
}

interface AccountManagerLike {
  createAccount(name: string, clientId: string, clientSecret: string, broadcasterName: string, channels?: string[]): StoredAccount;
  getAccount(name: string): StoredAccount | null;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AccountManager = require('../../../src/lib/account-manager').AccountManager as new (options: { accountsFile: string; keyFile: string }) => AccountManagerLike;

export interface Harness {
  dir: string;
  envPath: string;
  backupDir: string;
  accountsFile: string;
  keyFile: string;
  logDir: string;
  gen: TokenGeneratorInstance;
  server: Server;
  base: string;
  /** Contents of the temp .env */
  readEnv(): string;
  writeEnv(content: string): void;
  /** A fresh AccountManager on the temp accounts files (reads what is on disk now) */
  accounts(): AccountManagerLike;
  backups(): string[];
  close(): Promise<void>;
}

export interface HarnessOptions {
  /** Initial .env content; undefined = no .env file */
  env?: string;
  /** Port the app believes it runs on (redirect URI); the server itself listens on a free port */
  port?: number | string;
  /** Accounts that exist before the server starts */
  accounts?: Array<{ name: string; clientId?: string; clientSecret?: string; broadcasterName?: string; channels?: string[] }>;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-generator-e2e-'));
  const envPath = path.join(dir, '.env');
  const backupDir = path.join(dir, 'backups');
  const accountsFile = path.join(dir, 'accounts.encrypted.json');
  const keyFile = path.join(dir, '.encryption-key');
  const logDir = path.join(dir, 'logs');
  if (options.env !== undefined) fs.writeFileSync(envPath, options.env);

  const accounts = () => new AccountManager({ accountsFile, keyFile });
  if (options.accounts) {
    const am = accounts();
    for (const a of options.accounts) {
      am.createAccount(a.name, a.clientId ?? 'cid', a.clientSecret ?? 'secret', a.broadcasterName ?? 'caster', a.channels ?? []);
    }
  }

  const gen = createTokenGenerator({
    port: options.port ?? 3000,
    envPath,
    backupDir,
    accountsFile,
    keyFile,
    logDir
  });
  const server = await new Promise<Server>((resolve) => {
    const s = gen.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    dir, envPath, backupDir, accountsFile, keyFile, logDir, gen, server, base,
    readEnv: () => fs.readFileSync(envPath, 'utf8'),
    writeEnv: (content) => fs.writeFileSync(envPath, content),
    accounts,
    backups: () => (fs.existsSync(backupDir) ? fs.readdirSync(backupDir).sort() : []),
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

export function postJson(url: string, body?: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
}

/** Silence console and the Logger's direct stream writes for the duration of a test file */
export function quietOutput(): void {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
}

/** axios replaced by jest.fn()s; install with jest.mock('axios', axiosMockFactory) */
export interface AxiosMock {
  get: jest.Mock;
  post: jest.Mock;
}

/** An axios-style HTTP error carrying a response body */
export function httpError(message: string, data: unknown): Error {
  return Object.assign(new Error(message), { response: { data } });
}
