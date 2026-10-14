/**
 * Harness for the OBS browser-source overlays (obs/overlays/*.html + obs/js/overlay-client.js).
 *
 * Builds a fresh jsdom document from the real overlay HTML, installs mocks for
 * fetch / WebSocket / speechSynthesis / Audio, then runs the page's <script>
 * tags in their original order as classic scripts.
 *
 * Script source for each <script src>:
 *   - default: the TypeScript source under src/web (src/web/obs/<path>.ts),
 *     transpiled in-test with tsconfig.web.json's compiler options
 *   - WEB_SCRIPT=served: the served .js file on disk (tsc output)
 *   - OBS_ORIGINAL_DIR=<dir>: the pre-TypeScript copy of obs/ (js/ + overlays/)
 *     whose HTML still carries the inline scripts; used for the parity run
 *
 * Timers: call jest.useFakeTimers() first; the page window shares the test's
 * (fake) setTimeout/setInterval/Date.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { TextEncoder, TextDecoder } from 'util';

// jsdom's dependencies expect these Node globals, which the jest jsdom
// environment does not expose; install them before loading jsdom.
Object.assign(globalThis, { TextEncoder, TextDecoder });
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { JSDOM, VirtualConsole } = require('jsdom') as typeof import('jsdom');
type JSDOMInstance = import('jsdom').JSDOM;

export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** Root of the obs/ tree whose HTML (and scripts) are loaded. */
function obsRoot(): string {
  return process.env.OBS_ORIGINAL_DIR ? path.resolve(process.env.OBS_ORIGINAL_DIR) : path.join(REPO_ROOT, 'obs');
}

export const usingOriginal = (): boolean => !!process.env.OBS_ORIGINAL_DIR;

let webCompilerOptions: ts.CompilerOptions | null = null;
function compilerOptionsForWeb(): ts.CompilerOptions {
  if (!webCompilerOptions) {
    const configPath = path.join(REPO_ROOT, 'tsconfig.web.json');
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    webCompilerOptions = ts.parseJsonConfigFileContent(read.config, ts.sys, REPO_ROOT).options;
  }
  return webCompilerOptions;
}

/** Source for a script under obs/, given its path relative to obs/ (e.g. 'js/overlay-client.js'). */
export function obsScriptSource(relPath: string): string {
  if (usingOriginal()) {
    return fs.readFileSync(path.join(obsRoot(), relPath), 'utf8');
  }
  const tsPath = path.join(REPO_ROOT, 'src', 'web', 'obs', relPath.replace(/\.js$/, '.ts'));
  if (process.env.WEB_SCRIPT !== 'served' && fs.existsSync(tsPath)) {
    return ts.transpileModule(fs.readFileSync(tsPath, 'utf8'), {
      compilerOptions: compilerOptionsForWeb(),
      fileName: tsPath,
      reportDiagnostics: false,
    }).outputText;
  }
  return fs.readFileSync(path.join(REPO_ROOT, 'obs', relPath), 'utf8');
}

// ─── Mocks ────────────────────────────────────────────────────────────────

export class MockWebSocket {
  url: string;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  closed = false;
  constructor(url: string, registry: MockWebSocket[]) {
    this.url = url;
    registry.push(this);
  }
  send(): void {
    /* overlays never send */
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.();
  }
  /** deliver a dashboard broadcast `{ type, data }` */
  emit(type: string, data?: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ type, data }) });
  }
  raw(data: string): void {
    this.onmessage?.({ data });
  }
  serverClose(): void {
    this.onclose?.();
  }
}

export class MockUtterance {
  text: string;
  voice: unknown = undefined;
  rate = 1;
  pitch = 1;
  volume = 1;
  onstart: ((ev?: unknown) => void) | null = null;
  onend: ((ev?: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

export interface MockVoice {
  name: string;
  lang: string;
  default?: boolean;
}

export interface MockSpeech {
  voices: MockVoice[];
  speaking: boolean;
  pending: boolean;
  paused: boolean;
  onvoiceschanged: (() => void) | null;
  spoken: MockUtterance[];
  getVoices: jest.Mock;
  speak: jest.Mock;
  cancel: jest.Mock;
  resume: jest.Mock;
}

function createSpeech(voices: MockVoice[]): MockSpeech {
  const speech: MockSpeech = {
    voices,
    speaking: false,
    pending: false,
    paused: false,
    onvoiceschanged: null,
    spoken: [],
    getVoices: jest.fn(() => speech.voices),
    speak: jest.fn((u: MockUtterance) => {
      speech.spoken.push(u);
    }),
    cancel: jest.fn(),
    resume: jest.fn(),
  };
  return speech;
}

export class MockAudio {
  static instances: MockAudio[] = [];
  src: string;
  volume = 1;
  preload = '';
  play = jest.fn(() => Promise.resolve());
  constructor(src = '') {
    this.src = src;
    MockAudio.instances.push(this);
  }
  cloneNode(): MockAudio {
    const clone = new MockAudio(this.src);
    clone.volume = this.volume;
    return clone;
  }
}

export interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

export interface RouteSpec {
  status?: number;
  body?: unknown;
  /** reject the fetch promise (network error) */
  networkError?: boolean;
}

export type Routes = Record<string, RouteSpec | ((call: FetchCall) => RouteSpec)>;

export interface LoadOverlayOptions {
  /** query string, e.g. '?debug=true' */
  query?: string;
  /** fetch routes keyed by "METHOD url" or "url" (exact match after the query string is kept) */
  routes?: Routes;
  /** install window.speechSynthesis (default true) */
  speech?: boolean;
  voices?: MockVoice[];
  /** run before the page scripts */
  beforeScripts?: (h: OverlayHarness) => void;
}

export interface OverlayHarness {
  dom: JSDOMInstance;
  window: JSDOMInstance['window'] & Record<string, any>;
  document: Document;
  sockets: MockWebSocket[];
  /** the first (current) socket */
  ws: MockWebSocket;
  fetchCalls: FetchCall[];
  routes: Routes;
  speech: MockSpeech;
  audios: MockAudio[];
  /** media element play() calls (e.g. <audio id="tts-audio">) */
  mediaPlay: jest.Mock;
  mediaPause: jest.Mock;
  logs: { log: unknown[][]; warn: unknown[][]; error: unknown[][] };
  scriptErrors: Error[];
  $(id: string): HTMLElement & Record<string, any>;
  callsTo(url: string, method?: string): FetchCall[];
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

interface SetupOptions extends LoadOverlayOptions {
  url: string;
}

/** Build the jsdom window, install the mocks and run the given scripts in order. */
function setup(markup: string, scripts: Array<{ src?: string; code?: string }>, opts: SetupOptions): OverlayHarness {
  const scriptErrors: Error[] = [];
  const logs: OverlayHarness['logs'] = { log: [], warn: [], error: [] };
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err: Error) => {
    scriptErrors.push(err);
  });
  const dom = new JSDOM(markup, {
    virtualConsole,
    url: opts.url,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const window = dom.window as OverlayHarness['window'];
  const document = window.document;
  // untyped view for installing mocks over DOM globals
  const w = window as unknown as Record<string, any>;

  // Share the test's (possibly fake) clock
  window.setTimeout = setTimeout as unknown as typeof window.setTimeout;
  window.clearTimeout = clearTimeout as unknown as typeof window.clearTimeout;
  window.setInterval = setInterval as unknown as typeof window.setInterval;
  window.clearInterval = clearInterval as unknown as typeof window.clearInterval;
  window.Date = Date;

  window.console = {
    ...console,
    log: (...args: unknown[]) => logs.log.push(args),
    warn: (...args: unknown[]) => logs.warn.push(args),
    error: (...args: unknown[]) => logs.error.push(args),
  } as Console;

  const sockets: MockWebSocket[] = [];
  w.WebSocket = function (url: string) {
    return new MockWebSocket(url, sockets);
  };

  const fetchCalls: FetchCall[] = [];
  const routes: Routes = { ...(opts.routes ?? {}) };
  w.fetch = jest.fn((input: string, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const call: FetchCall = { url, method, body: parseBody(init) };
    fetchCalls.push(call);
    const spec = routes[`${method} ${url}`] ?? routes[url];
    const res: RouteSpec = typeof spec === 'function' ? spec(call) : (spec ?? { status: 404, body: { error: 'Not found' } });
    if (res.networkError) return Promise.reject(new Error('network down'));
    const status = res.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(JSON.parse(JSON.stringify(res.body ?? null))),
    });
  });

  const speech = createSpeech(opts.voices ?? [
    { name: 'English US', lang: 'en-US', default: true },
    { name: 'English UK', lang: 'en-GB' },
    { name: 'Deutsch', lang: 'de-DE' },
  ]);
  if (opts.speech !== false) {
    w.speechSynthesis = speech;
    w.SpeechSynthesisUtterance = MockUtterance;
  }

  MockAudio.instances = [];
  w.Audio = MockAudio;
  const mediaPlay = jest.fn(() => Promise.resolve());
  const mediaPause = jest.fn();
  window.HTMLMediaElement.prototype.play = mediaPlay;
  window.HTMLMediaElement.prototype.pause = mediaPause;

  const h: OverlayHarness = {
    dom,
    window,
    document,
    sockets,
    get ws() {
      if (sockets.length === 0) throw new Error('no WebSocket created');
      return sockets[0];
    },
    fetchCalls,
    routes,
    speech,
    audios: MockAudio.instances,
    mediaPlay,
    mediaPause,
    logs,
    scriptErrors,
    $(id: string) {
      const el = document.getElementById(id);
      if (!el) throw new Error(`#${id} not found`);
      return el as HTMLElement & Record<string, any>;
    },
    callsTo(url: string, method?: string) {
      return fetchCalls.filter(c => c.url === url && (method === undefined || c.method === method));
    },
  };

  opts.beforeScripts?.(h);

  for (const s of scripts) {
    if (s.src && /^https?:/.test(s.src)) continue;
    const code = s.src
      ? obsScriptSource(path.posix.normalize(path.posix.join('overlays', s.src)))
      : (s.code as string);
    // Run as a classic <script> so top-level bindings behave as in the browser
    const el = document.createElement('script');
    el.textContent = code;
    document.body.appendChild(el);
    if (scriptErrors.length > 0) throw scriptErrors[0];
  }
  return h;
}

/**
 * Load obs/overlays/<page>.html with its scripts.
 */
export function loadOverlay(page: string, opts: LoadOverlayOptions = {}): OverlayHarness {
  const htmlPath = path.join(obsRoot(), 'overlays', `${page}.html`);
  const html = fs.readFileSync(htmlPath, 'utf8');

  // Pull the <script> tags out of the markup (they are run once the mocks are
  // installed, in their original order, at the end of <body> where they sit).
  const scripts: Array<{ src?: string; code?: string }> = [];
  const markup = html.replace(/<script(?:\s+src="([^"]+)")?\s*>([\s\S]*?)<\/script>/g, (_m, src: string | undefined, code: string) => {
    scripts.push(src ? { src } : { code });
    return '';
  });
  return setup(markup, scripts, { ...opts, url: `http://localhost:3001/obs/overlays/${page}.html${opts.query ?? ''}` });
}

/** Load just overlay-client.js into a blank page (for the shared library). */
export function loadOverlayClient(opts: LoadOverlayOptions & { protocol?: 'http' | 'https' } = {}): OverlayHarness {
  return setup('<!DOCTYPE html><html><head></head><body></body></html>', [{ src: '../js/overlay-client.js' }], {
    ...opts,
    url: `${opts.protocol ?? 'http'}://overlay.test:3001/obs/overlays/x.html${opts.query ?? ''}`,
  });
}

/** Let pending promise chains (mocked fetch -> json -> render) settle without advancing fake time. */
export async function flush(times = 50): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

/** Dispatch a click the way a user would. */
export function click(el: Element): void {
  const win = el.ownerDocument.defaultView as Window & typeof globalThis;
  el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
}
