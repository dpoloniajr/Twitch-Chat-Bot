/**
 * Tests for the dashboard entry point src/dashboard/main.ts (what
 * `node dist/dashboard/main.js` / `npm run dashboard` runs).
 * createDashboard itself is covered over HTTP by tests/e2e/dashboard.
 */

import * as path from 'path';

/* eslint-disable @typescript-eslint/no-require-imports */

const ROOT = path.join(__dirname, '..', '..');

interface FakeDashboard {
  server: { listen: jest.Mock };
  init: jest.Mock;
}

/** Load src/dashboard/main.ts with dotenv and createDashboard mocked; returns what it did */
function runMain(initResult: Promise<unknown>) {
  const order: string[] = [];
  const dashboard: FakeDashboard = {
    server: { listen: jest.fn((_port: unknown, _host: string, cb: () => void) => cb()) },
    init: jest.fn(() => initResult)
  };
  const config = jest.fn(() => { order.push('dotenv'); });
  const createDashboard = jest.fn(() => { order.push('createDashboard'); return dashboard; });
  jest.isolateModules(() => {
    jest.doMock('../../src/lib/console-timestamp', () => { order.push('console-timestamp'); return {}; });
    jest.doMock('dotenv', () => ({ config }));
    jest.doMock('../../src/dashboard/server', () => { order.push('server'); return { createDashboard }; });
    require('../../src/dashboard/main');
  });
  return { order, config, createDashboard, dashboard };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

describe('dashboard main', () => {
  const savedPort = process.env.DASHBOARD_PORT;
  const savedHost = process.env.DASHBOARD_HOST;
  let log: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
    error = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (savedPort === undefined) delete process.env.DASHBOARD_PORT;
    else process.env.DASHBOARD_PORT = savedPort;
    if (savedHost === undefined) delete process.env.DASHBOARD_HOST;
    else process.env.DASHBOARD_HOST = savedHost;
    jest.dontMock('../../src/lib/console-timestamp');
    jest.dontMock('dotenv');
    jest.dontMock('../../src/dashboard/server');
  });

  it('timestamps the console and loads the project .env before loading the dashboard', async () => {
    delete process.env.DASHBOARD_PORT;
    const { order, config, createDashboard } = runMain(Promise.resolve());
    expect(order).toEqual(['console-timestamp', 'dotenv', 'server', 'createDashboard']);
    expect(config).toHaveBeenCalledWith({ path: path.join(ROOT, '.env') });
    expect(createDashboard).toHaveBeenCalledWith();
    await flush();
  });

  it('listens on 127.0.0.1:3001 by default after init()', async () => {
    delete process.env.DASHBOARD_PORT;
    delete process.env.DASHBOARD_HOST;
    const { dashboard } = runMain(Promise.resolve());
    expect(dashboard.server.listen).not.toHaveBeenCalled();
    await flush();
    expect(dashboard.server.listen).toHaveBeenCalledWith(3001, '127.0.0.1', expect.any(Function));
    expect(log).toHaveBeenCalledWith('Dashboard server running on http://localhost:3001');
  });

  it('uses DASHBOARD_PORT as given', async () => {
    delete process.env.DASHBOARD_HOST;
    process.env.DASHBOARD_PORT = '4555';
    const { dashboard } = runMain(Promise.resolve());
    await flush();
    expect(dashboard.server.listen).toHaveBeenCalledWith('4555', '127.0.0.1', expect.any(Function));
    expect(log).toHaveBeenCalledWith('Dashboard server running on http://localhost:4555');
  });

  it('listens on DASHBOARD_HOST when set (Docker uses 0.0.0.0)', async () => {
    process.env.DASHBOARD_PORT = '3001';
    process.env.DASHBOARD_HOST = '0.0.0.0';
    const { dashboard } = runMain(Promise.resolve());
    await flush();
    expect(dashboard.server.listen).toHaveBeenCalledWith('3001', '0.0.0.0', expect.any(Function));
  });

  it('exits with 1 when init() fails', async () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const failure = new Error('disk full');
    const { dashboard } = runMain(Promise.reject(failure));
    await flush();
    expect(error).toHaveBeenCalledWith('Failed to initialize server:', failure);
    expect(exit).toHaveBeenCalledWith(1);
    expect(dashboard.server.listen).not.toHaveBeenCalled();
  });
});
