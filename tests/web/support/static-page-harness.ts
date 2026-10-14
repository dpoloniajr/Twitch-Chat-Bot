/**
 * Harness for characterizing the plain global browser scripts (dashboard,
 * token generator) inside a fresh jsdom document built from the real HTML file.
 *
 * Script source:
 *   - default: the TypeScript source under src/web, transpiled in-test with the
 *     same compiler options as tsconfig.web.json (module "none", global script)
 *   - WEB_SCRIPT=served (or no .ts source yet): the served .js file as it exists
 *     on disk (the tsc build output, or the original hand-written JS)
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { TextEncoder, TextDecoder } from 'util';

// jsdom's dependencies expect these Node globals, which the jest jsdom
// environment does not expose; install them before loading jsdom.
Object.assign(globalThis, { TextEncoder, TextDecoder });
// jsdom's FileReader schedules with setImmediate, which jest's jsdom env also hides
if (typeof (globalThis as { setImmediate?: unknown }).setImmediate !== 'function') {
  Object.assign(globalThis, {
    setImmediate: (fn: (...args: unknown[]) => void, ...args: unknown[]) => setTimeout(fn, 0, ...args),
  });
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { JSDOM, VirtualConsole } = require('jsdom') as typeof import('jsdom');
type JSDOM = import('jsdom').JSDOM;

export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

export type JsonBody = unknown;

export interface MockResponseInit {
  ok?: boolean;
  status?: number;
  body?: JsonBody;
  /** reject the fetch promise (network error) */
  networkError?: Error;
  /** make res.json() reject */
  jsonError?: Error;
}

export type RouteHandler = (url: string, init: RequestInit | undefined) => MockResponseInit | undefined;

export interface FetchCall {
  url: string;
  method: string;
  body: unknown;
  init: RequestInit | undefined;
}

export interface TimerCall {
  fn: (...args: unknown[]) => void;
  delay: number | undefined;
}

export class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  sent: unknown[] = [];
  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(): void {
    /* no-op */
  }
  /** deliver a server message (JSON-encoded) */
  emit(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

export interface PageHarness {
  dom: JSDOM;
  window: JSDOM['window'] & Record<string, any>;
  document: Document;
  fetchCalls: FetchCall[];
  fetchMock: jest.Mock;
  /** Map of "METHOD url" or "url" -> response; checked before the catch-all handler */
  routes: Map<string, MockResponseInit | ((init: RequestInit | undefined) => MockResponseInit)>;
  alerts: string[];
  confirmMock: jest.Mock;
  openMock: jest.Mock;
  execCommandMock: jest.Mock;
  timers: TimerCall[];
  /** uncaught errors reported by jsdom (script errors, handler exceptions) */
  scriptErrors: Error[];
  sockets: MockWebSocket[];
  consoleError: jest.Mock;
  consoleLog: jest.Mock;
  /** run (and remove) recorded window.setTimeout callbacks with the given delay */
  runTimers(delay?: number): void;
  callsTo(urlPart: string, method?: string): FetchCall[];
  $(id: string): HTMLElement & Record<string, any>;
}

export function compilerOptionsForWeb(): ts.CompilerOptions {
  const configPath = path.join(REPO_ROOT, 'tsconfig.web.json');
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, REPO_ROOT);
  return parsed.options;
}

/**
 * Resolve the script for a served page script, e.g. 'dashboard/public/app.js'.
 */
export function loadScriptSource(servedRelPath: string): { code: string; from: string } {
  const servedPath = path.join(REPO_ROOT, servedRelPath);
  const tsPath = path.join(REPO_ROOT, 'src', 'web', servedRelPath.replace(/\.js$/, '.ts'));
  if (process.env.WEB_SCRIPT !== 'served' && fs.existsSync(tsPath)) {
    const source = fs.readFileSync(tsPath, 'utf8');
    const out = ts.transpileModule(source, {
      compilerOptions: compilerOptionsForWeb(),
      fileName: tsPath,
      reportDiagnostics: false,
    });
    return { code: out.outputText, from: tsPath };
  }
  return { code: fs.readFileSync(servedPath, 'utf8'), from: servedPath };
}

function parseBody(init: RequestInit | undefined): unknown {
  const raw = init?.body;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export interface LoadPageOptions {
  /** e.g. 'dashboard/public/index.html' */
  html: string;
  /** e.g. 'dashboard/public/app.js' */
  script: string;
  url?: string;
  routes?: Record<string, MockResponseInit | ((init: RequestInit | undefined) => MockResponseInit)>;
  /** before the script is evaluated */
  beforeScript?: (h: PageHarness) => void;
  confirmResult?: boolean;
}

export function loadPage(opts: LoadPageOptions): PageHarness {
  const htmlPath = path.join(REPO_ROOT, opts.html);
  const html = fs.readFileSync(htmlPath, 'utf8');
  const scriptErrors: Error[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err: Error) => {
    scriptErrors.push(err);
  });
  const dom = new JSDOM(html, {
    virtualConsole,
    url: opts.url ?? 'http://localhost:3000/',
    // 'dangerously' so the page's inline on* attribute handlers run; the
    // <script src> tag itself is not fetched (no resources: 'usable').
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const window = dom.window as PageHarness['window'];
  const document = window.document;

  const fetchCalls: FetchCall[] = [];
  const routes: PageHarness['routes'] = new Map(Object.entries(opts.routes ?? {}));

  const fetchMock = jest.fn((input: string, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    fetchCalls.push({ url, method, body: parseBody(init), init });
    let spec = routes.get(`${method} ${url}`) ?? routes.get(url);
    if (spec === undefined) {
      // prefix match on "METHOD prefix*" / "prefix*"
      for (const [key, value] of routes) {
        if (!key.endsWith('*')) continue;
        const k = key.slice(0, -1);
        if (`${method} ${url}`.startsWith(k) || url.startsWith(k)) {
          spec = value;
          break;
        }
      }
    }
    const res: MockResponseInit = typeof spec === 'function' ? spec(init) : (spec ?? { body: {} });
    if (res.networkError) return Promise.reject(res.networkError);
    const status = res.status ?? (res.ok === false ? 500 : 200);
    return Promise.resolve({
      ok: res.ok ?? (status >= 200 && status < 300),
      status,
      json: () => (res.jsonError ? Promise.reject(res.jsonError) : Promise.resolve(JSON.parse(JSON.stringify(res.body ?? null)))),
    });
  });

  const alerts: string[] = [];
  const confirmMock = jest.fn(() => opts.confirmResult ?? true);
  const openMock = jest.fn();
  const execCommandMock = jest.fn(() => true);
  const timers: TimerCall[] = [];
  MockWebSocket.instances = [];
  const consoleError = jest.fn();
  const consoleLog = jest.fn();

  // jsdom does not implement innerText; approximate it with textContent so
  // pages that read/write innerText behave as in a browser for plain text.
  if (!Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'innerText')) {
    Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
      configurable: true,
      get(this: HTMLElement) {
        return this.textContent;
      },
      set(this: HTMLElement, value: string) {
        this.textContent = value;
      },
    });
  }

  // install the test doubles (untyped view: they only mimic what the pages use)
  const globals = window as unknown as Record<string, unknown>;
  globals.fetch = fetchMock;
  globals.alert = (msg: unknown) => {
    alerts.push(String(msg));
  };
  globals.confirm = confirmMock;
  globals.open = openMock;
  (document as unknown as Record<string, unknown>).execCommand = execCommandMock;
  globals.WebSocket = MockWebSocket;
  globals.setTimeout = (fn: (...args: unknown[]) => void, delay?: number) => {
    timers.push({ fn, delay });
    return timers.length;
  };
  globals.console = { ...console, error: consoleError, log: consoleLog };

  const h: PageHarness = {
    dom,
    window,
    document,
    fetchCalls,
    fetchMock,
    routes,
    alerts,
    confirmMock,
    openMock,
    execCommandMock,
    timers,
    scriptErrors,
    sockets: MockWebSocket.instances,
    consoleError,
    consoleLog,
    runTimers(delay?: number) {
      const due = timers.filter(t => delay === undefined || t.delay === delay);
      for (const t of due) timers.splice(timers.indexOf(t), 1);
      for (const t of due) t.fn();
    },
    callsTo(urlPart: string, method?: string) {
      return fetchCalls.filter(c => c.url.includes(urlPart) && (method === undefined || c.method === method));
    },
    $(id: string) {
      const el = document.getElementById(id);
      if (!el) throw new Error(`#${id} not found`);
      return el as HTMLElement & Record<string, any>;
    },
  };

  opts.beforeScript?.(h);
  const { code } = loadScriptSource(opts.script);
  // Run as a classic <script> (not eval) so top-level let/const become shared
  // global lexical bindings exactly as in the browser.
  const scriptEl = document.createElement('script');
  scriptEl.textContent = code;
  document.body.appendChild(scriptEl);
  if (scriptErrors.length > 0) throw scriptErrors[0];
  return h;
}

/** let pending promise chains (mocked fetch -> json -> render) settle */
export async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
}

/** invoke an inline on* handler the way a user would */
export function click(el: Element): void {
  const win = el.ownerDocument.defaultView as Window & typeof globalThis;
  el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
}

export function change(el: Element, value?: string | boolean): void {
  const win = el.ownerDocument.defaultView as Window & typeof globalThis;
  if (typeof value === 'boolean') (el as HTMLInputElement).checked = value;
  else if (value !== undefined) (el as HTMLInputElement).value = value;
  el.dispatchEvent(new win.Event('change', { bubbles: true }));
}
