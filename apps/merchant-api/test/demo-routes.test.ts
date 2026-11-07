import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';

describe('demo HTTP API', () => {
  beforeEach(() => {
    vi.stubEnv('QUOTESEAL_DEMO_ADMIN_KEY', 'test-demo-key');
    vi.stubEnv('QUOTESEAL_DEMO_MODE', 'fixture');
  });

  afterEach(() => vi.unstubAllEnvs());

  it('lists the three allowlisted scenarios', async () => {
    const app = buildApp();
    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/api/demo/scenarios' });
    expect(response.statusCode).toBe(200);
    expect(response.json().map((scenario: { id: string }) => scenario.id)).toEqual(['NORMAL_PAYMENT', 'SUSPICIOUS_PAYMENT', 'CROSS_MERCHANT_BLOCK']);
    await app.close();
  });

  it('rejects unauthenticated and invalid scenario runs', async () => {
    const app = buildApp();
    await app.ready();
    const unauthenticated = await app.inject({ method: 'POST', url: '/api/demo/run', payload: { scenarioId: 'NORMAL_PAYMENT' } });
    const invalid = await app.inject({ method: 'POST', url: '/api/demo/run', headers: { 'x-demo-admin-key': 'test-demo-key' }, payload: { scenarioId: 'UNKNOWN' } });
    expect(unauthenticated.statusCode).toBe(403);
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });

  it('requires an explicitly configured admin key and keeps mode server-controlled', async () => {
    const app = buildApp();
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: '/api/demo/run',
      headers: { 'x-demo-admin-key': 'test-demo-key' },
      payload: { scenarioId: 'NORMAL_PAYMENT', mode: 'full-live' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ scenarioId: 'NORMAL_PAYMENT', mode: 'fixture' });
    await app.close();
  });

  it('fails closed when the server has no admin key configured', async () => {
    vi.stubEnv('QUOTESEAL_DEMO_ADMIN_KEY', '');
    const app = buildApp();
    await app.ready();
    const response = await app.inject({ method: 'POST', url: '/api/demo/run', headers: { 'x-demo-admin-key': 'wrong-admin-key' }, payload: { scenarioId: 'NORMAL_PAYMENT' } });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'DEMO_AUTH_REQUIRED' } });
    await app.close();
  });

  it('isolates events and exposes the saved run', async () => {
    const app = buildApp();
    await app.ready();
    const headers = { 'x-demo-admin-key': 'test-demo-key' };
    const first = await app.inject({ method: 'POST', url: '/api/demo/run', headers, payload: { scenarioId: 'NORMAL_PAYMENT' } });
    const second = await app.inject({ method: 'POST', url: '/api/demo/run', headers, payload: { scenarioId: 'SUSPICIOUS_PAYMENT' } });
    const firstRun = first.json() as { runId: string; scenarioId: string };
    const secondRun = second.json() as { runId: string; scenarioId: string };
    expect(firstRun.runId).not.toBe(first.json().paymentRequestId);
    expect(secondRun.runId).not.toBe(second.json().paymentRequestId);
    const firstEvents = await app.inject({ method: 'GET', url: `/api/demo/events?runId=${firstRun.runId}` });
    const savedRun = await app.inject({ method: 'GET', url: `/api/demo/runs/${secondRun.runId}` });
    expect(firstEvents.statusCode).toBe(200);
    expect(firstEvents.json().events.every((event: { runId: string }) => event.runId === firstRun.runId)).toBe(true);
    expect(savedRun.json()).toMatchObject({ runId: secondRun.runId, scenarioId: 'SUSPICIOUS_PAYMENT', signerCallCount: 0 });
    await app.close();
  });

  it('allows bounded concurrent authorized runs without mixing event streams', async () => {
    const app = buildApp();
    await app.ready();
    const headers = { 'x-demo-admin-key': 'test-demo-key' };
    const [first, second] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/demo/run', headers, payload: { scenarioId: 'NORMAL_PAYMENT' } }),
      app.inject({ method: 'POST', url: '/api/demo/run', headers, payload: { scenarioId: 'SUSPICIOUS_PAYMENT' } }),
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const firstRun = first.json() as { runId: string };
    const secondRun = second.json() as { runId: string };
    expect(firstRun.runId).not.toBe(secondRun.runId);
    const firstEvents = await app.inject({ method: 'GET', url: `/api/demo/events?runId=${firstRun.runId}` });
    const secondEvents = await app.inject({ method: 'GET', url: `/api/demo/events?runId=${secondRun.runId}` });
    expect(firstEvents.json().events.every((event: { runId: string }) => event.runId === firstRun.runId)).toBe(true);
    expect(secondEvents.json().events.every((event: { runId: string }) => event.runId === secondRun.runId)).toBe(true);
    await app.close();
  });

  it('reports non-sensitive mode readiness without exposing secrets', async () => {
    const app = buildApp();
    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/api/demo/readiness' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ mode: 'fixture', fixture: { ready: true }, configuration: { demoAdminKeyConfigured: true } });
    expect(JSON.stringify(response.json())).not.toContain('test-demo-key');
    await app.close();
  });

  it('returns a structured unavailable error when arkiv-live dependencies are absent', async () => {
    process.env.QUOTESEAL_DEMO_MODE = 'arkiv-live';
    delete process.env.ARKIV_ACCESS_KEY;
    delete process.env.ARKIV_PRIVATE_KEY;
    delete process.env.ARKIV_TRUSTED_OWNER;
    const app = buildApp();
    await app.ready();
    const response = await app.inject({ method: 'POST', url: '/api/demo/run', headers: { 'x-demo-admin-key': 'test-demo-key' }, payload: { scenarioId: 'NORMAL_PAYMENT' } });
    expect(response.statusCode).toBe(424);
    expect(response.json()).toMatchObject({ error: { code: 'LIVE_DEPENDENCY_UNAVAILABLE' } });
    await app.close();
  });

  it('returns a structured unavailable error when full-live dependencies are absent', async () => {
    process.env.QUOTESEAL_DEMO_MODE = 'full-live';
    delete process.env.HEDERA_BUYER_ACCOUNT_ID;
    delete process.env.HEDERA_BUYER_PRIVATE_KEY;
    delete process.env.HEDERA_MERCHANT_ACCOUNT_ID;
    const app = buildApp();
    await app.ready();
    const response = await app.inject({ method: 'POST', url: '/api/demo/run', headers: { 'x-demo-admin-key': 'test-demo-key' }, payload: { scenarioId: 'NORMAL_PAYMENT' } });
    expect(response.statusCode).toBe(424);
    expect(response.json()).toMatchObject({ error: { code: 'LIVE_DEPENDENCY_UNAVAILABLE' } });
    await app.close();
  });
});
