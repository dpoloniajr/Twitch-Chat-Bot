/**
 * Characterization: /api/scopes routes (categories, presets, required scopes).
 */

import { Harness, quietOutput, startHarness } from './harness';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const featureScopes = require('../../../src/lib/feature-scopes');

describe('/api/scopes', () => {
  quietOutput();
  let h: Harness;
  const saved = { ...process.env };

  beforeEach(async () => {
    h = await startHarness();
  });

  afterEach(async () => {
    await h.close();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  it('GET /categories returns the scope catalogue', async () => {
    const res = await fetch(`${h.base}/api/scopes/categories`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body)).toEqual([
      'Chat (IRC)', 'Chat (Bot/User)', 'Clips', 'Moderation', 'Channel Management',
      'Followers & Subscriptions', 'VIPs', 'Channel Points', 'User Account',
      'Extensions & Analytics', 'Bits', 'Guest Star', 'Other'
    ]);
    expect(body['Chat (IRC)']).toEqual([
      { scope: 'chat:read', description: 'Read chat messages' },
      { scope: 'chat:edit', description: 'Send chat messages' }
    ]);
    expect(body.Bits).toEqual([{ scope: 'bits:read', description: 'View Bits information' }]);
    const counts = Object.values(body).map((list) => (list as unknown[]).length);
    expect(counts).toEqual([2, 5, 3, 18, 8, 2, 3, 6, 4, 6, 1, 4, 18]);
  });

  it('GET /presets returns the presets', async () => {
    const body = await (await fetch(`${h.base}/api/scopes/presets`)).json();
    expect(Object.keys(body)).toEqual([
      'basic-bot', 'full-moderation', 'eventsub-complete', 'streamer-tools', 'bot-recommended', 'broadcaster-recommended'
    ]);
    expect(body['basic-bot']).toEqual({
      name: 'Basic Bot', description: 'Minimal scopes for chat only', scopes: ['chat:read', 'chat:edit']
    });
    expect(body['broadcaster-recommended'].scopes).toEqual([
      'moderator:read:followers', 'channel:read:redemptions', 'channel:read:subscriptions', 'bits:read'
    ]);
  });

  it('GET /required reads the current .env file, with process.env filling in missing keys', async () => {
    h.writeEnv('DISABLE_EVENTSUB=true\nENABLE_SHIELD_MODE=true\n');
    process.env.DISABLE_CLIPS = '1';
    process.env.TWITCH_BROADCASTER_ACCESS_TOKEN = 'from-process';
    delete process.env.DISABLE_EVENTSUB;
    delete process.env.ENABLE_SHIELD_MODE;
    delete process.env.YOUTUBE_API_KEY;

    let body = await (await fetch(`${h.base}/api/scopes/required`)).json();
    const merged = { ...process.env, DISABLE_EVENTSUB: 'true', ENABLE_SHIELD_MODE: 'true' };
    const active = featureScopes.getActiveFeatures(merged) as string[];
    expect(active).not.toContain('eventsub');
    expect(active).not.toContain('clips');
    expect(active).toContain('shield_mode');
    expect(body).toEqual({
      featureScopes: featureScopes.FEATURE_SCOPES,
      activeFeatures: active.map((f) => ({
        id: f, name: featureScopes.FEATURE_SCOPES[f].name, description: featureScopes.FEATURE_SCOPES[f].description
      })),
      bot: featureScopes.getRequiredScopes(active, 'bot'),
      broadcaster: featureScopes.getRequiredScopes(active, 'broadcaster'),
      hasBroadcasterToken: true
    });
    expect(body.activeFeatures[0]).toEqual({ id: 'chat', name: expect.any(String), description: expect.any(String) });

    // edits to .env (e.g. a token saved by /callback) show up without a restart, and the file wins
    delete process.env.TWITCH_BROADCASTER_ACCESS_TOKEN;
    process.env.DISABLE_EVENTSUB = 'true';
    h.writeEnv('DISABLE_EVENTSUB=false\nTWITCH_BROADCASTER_ACCESS_TOKEN=saved\n');
    body = await (await fetch(`${h.base}/api/scopes/required`)).json();
    expect(body.hasBroadcasterToken).toBe(true);
    expect(body.activeFeatures.map((f: { id: string }) => f.id)).toContain('eventsub');
    expect(body.activeFeatures.map((f: { id: string }) => f.id)).not.toContain('shield_mode');
    expect(body.broadcaster).toEqual(expect.arrayContaining(['bits:read', 'channel:read:subscriptions']));
  });

  it('GET /required works without a .env file and reports no broadcaster token', async () => {
    delete process.env.TWITCH_BROADCASTER_ACCESS_TOKEN;
    const res = await fetch(`${h.base}/api/scopes/required`);
    expect(res.status).toBe(200);
    expect((await res.json()).hasBroadcasterToken).toBe(false);
  });

  it('GET /required sends a 500 JSON error when .env cannot be read', async () => {
    require('fs').mkdirSync(h.envPath);
    const res = await fetch(`${h.base}/api/scopes/required`);
    expect(res.status).toBe(500);
    expect((await res.json()).success).toBe(false);
  });

  it('sends 404 for unknown scope routes', async () => {
    expect((await fetch(`${h.base}/api/scopes`)).status).toBe(404);
    expect((await fetch(`${h.base}/api/scopes/presets`, { method: 'POST' })).status).toBe(404);
  });
});
