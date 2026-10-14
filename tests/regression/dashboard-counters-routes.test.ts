/**
 * Regression: the dashboard's counter increment/decrement/reset endpoints
 * returned 404 because they forwarded to the PUT handler with router.handle,
 * which Express 5 does not route.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const express = require('express');
import { createCountersRouter as countersRouter } from '../../src/dashboard/routes/counters';

describe('dashboard counters routes', () => {
  let dir: string;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'counters-routes-'));
    const app = express();
    app.use(express.json());
    app.use('/api/counters', countersRouter(dir));
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/counters`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const post = (url: string, body?: object) =>
    fetch(url, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });

  it('increments, decrements and resets a counter', async () => {
    let res = await post(`${base}/deaths/increment`);
    expect(res.status).toBe(200);
    expect((await res.json()).counter.value).toBe(1);

    res = await post(`${base}/deaths/increment`, { amount: 5 });
    expect((await res.json()).counter.value).toBe(6);

    res = await post(`${base}/deaths/decrement`, { amount: 2 });
    expect((await res.json()).counter.value).toBe(4);

    res = await post(`${base}/deaths/reset`);
    expect((await res.json()).counter.value).toBe(0);

    const history = await (await fetch(`${base}/deaths/history`)).json();
    expect(history.map((h: { reason: string }) => h.reason)).toEqual(['Reset', '-2', '+5', '+1']);
  });

  it('returns 404 for an unknown counter and 400 for a bad amount', async () => {
    expect((await post(`${base}/nope/increment`)).status).toBe(404);
    expect((await post(`${base}/deaths/increment`, { amount: 'x' })).status).toBe(400);
  });

  it('does not lose concurrent increments', async () => {
    await Promise.all(Array.from({ length: 15 }, () => post(`${base}/wins/increment`)));

    const counter = await (await fetch(`${base}/wins`)).json();
    expect(counter.value).toBe(15);
  });
});
