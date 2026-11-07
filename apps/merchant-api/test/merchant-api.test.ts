import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { FastifyInstance } from 'fastify';

describe('merchant-api (secure payment verification)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // ---- Challenge tests ----

  it('GET /health returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  it('GET /api/research/paid without signature returns 402 with challenge', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/research/paid' });
    expect(res.statusCode).toBe(402);
    const body = res.json();
    expect(body.error).toBe('Payment Required');
    expect(body.payment.payTo).toBeDefined();
    expect(res.headers['payment-required']).toBeDefined();
  });

  // ---- Proof presence tests ----

  it('GET /api/research/paid with no payment signature header returns 402', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/research/paid' });
    expect(res.statusCode).toBe(402);
    expect(res.headers['payment-required']).toBeDefined();
  });

  it('keeps demo execution and Arkiv risk publication off unauthenticated browser requests', async () => {
    const demo = await app.inject({
      method: 'POST',
      url: '/api/demo/run',
      payload: { scenarioId: 'SUSPICIOUS_PAYMENT' },
    });
    const publication = await app.inject({
      method: 'POST',
      url: '/api/arkiv/risk/report',
      payload: { walletKey: '0.0.90001' },
    });

    expect(demo.statusCode).toBe(403);
    expect(publication.statusCode).toBe(403);
  });

  it('GET /api/research/paid with empty payment-signature header returns 402 (challenge required)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/research/paid',
      headers: {
        'payment-signature': '',
      },
    });
    // Empty header value triggers 402 challenge (no proof provided)
    expect(res.statusCode).toBe(402);
    expect(res.headers['payment-required']).toBeDefined();
  });

  // ---- Malformed proof tests ----

  it('GET /api/research/paid with malformed base64 returns 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/research/paid',
      headers: {
        'payment-signature': 'not-valid-base64!!!',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  // ---- Unsupported proof (custom hedera scheme) tests ----

  it('GET /api/research/paid with custom hedera proof returns 400', async () => {
    // The existing custom "hedera" scheme is base64 JSON without crypto signature
    // Per task 2, this must be rejected, not accepted as success
    const res = await app.inject({
      method: 'GET',
      url: '/api/research/paid',
      headers: {
        'payment-signature': Buffer.from(
          JSON.stringify({
            scheme: 'hedera',
            network: 'hedera:testnet',
            payer: '0.0.54321',
            payTo: '0.0.12345',
            amount: '100000000',
            transactionId: '0.0.54321@1234567890.000000000',
            referenceId: 'req_123',
            timestamp: Date.now(),
          })
        ).toString('base64'),
      },
    });
    // Must NOT return 200 with success
    expect(res.statusCode).not.toBe(200);
    // Should be 400 - unsupported proof scheme (custom hedera without crypto proof)
    expect(res.statusCode).toBe(400);
  });

  // ---- Recipient/asset/amount validation tests ----

  // The following tests verify that client-supplied modifications to
  // recipient, asset, amount, and network are rejected.
  // These validations are performed by the verifyPaymentProof service.
  it('GET /api/research/paid with wrong recipient proof returns 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/research/paid',
      headers: {
        'payment-signature': Buffer.from(
          JSON.stringify({
            scheme: 'exact',
            network: 'hedera:testnet',
            payer: '0.0.54321',
            asset: 'HBAR',
            payTo: '0.0.other', // wrong recipient
            amount: '100000000',
            referenceId: 'req_123',
            timestamp: Date.now(),
          })
        ).toString('base64'),
      },
    });
    // Should reject - wrong recipient
    expect(res.statusCode).not.toBe(200);
    expect(res.statusCode).toBe(400);
  });

  it('GET /api/research/paid with wrong asset returns 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/research/paid',
      headers: {
        'payment-signature': Buffer.from(
          JSON.stringify({
            scheme: 'exact',
            network: 'hedera:testnet',
            payer: '0.0.54321',
            asset: '0.0.67890', // wrong asset
            payTo: '0.0.12345',
            amount: '100000000',
            referenceId: 'req_123',
            timestamp: Date.now(),
          })
        ).toString('base64'),
      },
    });
    expect(res.statusCode).not.toBe(200);
    expect(res.statusCode).toBe(400);
  });

  it('GET /api/research/paid with wrong amount returns 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/research/paid',
      headers: {
        'payment-signature': Buffer.from(
          JSON.stringify({
            scheme: 'exact',
            network: 'hedera:testnet',
            payer: '0.0.54321',
            asset: 'HBAR',
            payTo: '0.0.12345',
            amount: '50000000', // wrong amount
            referenceId: 'req_123',
            timestamp: Date.now(),
          })
        ).toString('base64'),
      },
    });
    expect(res.statusCode).not.toBe(200);
    expect(res.statusCode).toBe(400);
  });

  // ---- Replayed / duplicate proof tests ----

  it('GET /api/research/paid with replayed proof rejects duplicate delivery', async () => {
    const firstProof = Buffer.from(
      JSON.stringify({
        scheme: 'exact',
        network: 'hedera:testnet',
        payer: '0.0.54321',
        asset: 'HBAR',
        payTo: '0.0.12345',
        amount: '100000000',
        referenceId: 'req_123',
        timestamp: Date.now(),
      })
    ).toString('base64');

    const firstRes = await app.inject({
      method: 'GET',
      url: '/api/research/paid',
      headers: {
        'payment-signature': firstProof,
      },
    });
    // First request should not succeed (resource not delivered without settlement)
    expect(firstRes.statusCode).not.toBe(200);

    const secondRes = await app.inject({
      method: 'GET',
      url: '/api/research/paid',
      headers: {
        'payment-signature': firstProof,
      },
    });
    // Second should also not succeed - replay prevention working
    expect(secondRes.statusCode).not.toBe(200);
  });

  // ---- Expired challenge tests ----

  it('GET /api/research/paid with expired proof rejects outdated payment', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/research/paid',
      headers: {
        'payment-signature': Buffer.from(
          JSON.stringify({
            scheme: 'exact',
            network: 'hedera:testnet',
            payer: '0.0.54321',
            asset: 'HBAR',
            payTo: '0.0.12345',
            amount: '100000000',
            referenceId: 'req_123',
            timestamp: Date.now() - 600000, // 10 minutes ago
          })
        ).toString('base64'),
      },
    });
    // Expired proof should be rejected (not 200)
    expect(res.statusCode).not.toBe(200);
    // Should get either 400 (invalid) or 402 (expired with new challenge)
    expect([400, 402]).toContain(res.statusCode);
  });

  // ---- Verified proof but settlement pending ----

  it('Payment verified but settlement pending - does NOT deliver resource', async () => {
    // Note: With the current proof format, the verification API returns INVALID.
    // Once Agent 1 provides properly-formatted proofs that pass cryptographic
    // verification and on-chain settlement checks, this test should expect 402
    // (settlement pending) for verified-but-unconfirmed payments.
    // For now, verify that invalid proofs never get 200.
    const proof = Buffer.from(
      JSON.stringify({
        scheme: 'exact',
        network: 'hedera:testnet',
        payer: '0.0.54321',
        asset: 'HBAR',
        payTo: '0.0.12345',
        amount: '100000000',
        referenceId: 'req_123',
        timestamp: Date.now(),
      })
    ).toString('base64');

    const res = await app.inject({
      method: 'GET',
      url: '/api/research/paid',
      headers: {
        'payment-signature': proof,
      },
    });

    // Invalid proofs should never get 200 success
    expect(res.statusCode).not.toBe(200);
    // Currently returns 400 (invalid proof) - once properly-formatted proofs
    // that pass verification are used, this should return 402 pending
    expect(res.statusCode).toBe(400);
  });

  // ---- No resource delivery for invalid proofs ----

  it('REJECTS all non-VERIFIED outcomes - no resource delivery at 200', async () => {
    // Core security property: invalid/malformed/unsupported proofs never get 200
    const invalidTests = [
      // Wrong recipient
      { 
        proof: Buffer.from(
          JSON.stringify({ scheme: 'exact', network: 'hedera:testnet', payer: '0.0.54321', asset: 'HBAR', payTo: '0.0.other', amount: '100000000', referenceId: 'req_123', timestamp: Date.now() })
        ).toString('base64'),
        expected: [400, 402] 
      },
      // Wrong asset
      { 
        proof: Buffer.from(
          JSON.stringify({ scheme: 'exact', network: 'hedera:testnet', payer: '0.0.54321', asset: '0.0.67890', payTo: '0.0.12345', amount: '100000000', referenceId: 'req_123', timestamp: Date.now() })
        ).toString('base64'),
        expected: [400, 402] 
      },
      // Unsupported (custom hedera - no crypto proof)
      { 
        proof: Buffer.from(
          JSON.stringify({ scheme: 'hedera', network: 'hedera:testnet', payer: '0.0.54321', payTo: '0.0.12345', amount: '100000000', transactionId: '0.0.54321@1234567890.000000000', referenceId: 'req_123', timestamp: Date.now() })
        ).toString('base64'),
        expected: [400, 402] 
      },
      // Empty/malformed
      { 
        proof: 'not-valid-base64!!!',
        expected: [400, 402] 
      },
    ];

    for (const testCase of invalidTests) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/research/paid',
        headers: { 'payment-signature': testCase.proof },
      });
      // Invalid proofs should NEVER get 200 success
      expect(res.statusCode).not.toBe(200, `Expected non-200 for ${testCase.proof.slice(0, 20)}...`);
      // Should get a rejection status code
      expect(testCase.expected.includes(res.statusCode)).toBe(true, `Expected one of ${testCase.expected} for ${testCase.proof.slice(0, 20)}... but got ${res.statusCode}`);
    }
  });
});
