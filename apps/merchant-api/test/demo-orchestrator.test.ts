import { describe, expect, it } from 'vitest';
import { createTrustedWalletRiskReader, type WalletRiskStateCandidate } from '@quoteseal/arkiv';
import { createInMemoryDemoEventStore } from '../src/demo/event-store.js';
import { createDemoOrchestrator } from '../src/demo/orchestrator.js';

function challenge() {
  return { statusCode: 402, terms: { network: 'hedera:testnet', asset: 'HBAR', payTo: '0.0.12345', amount: '100000000', ensName: 'researchpro.eth', serviceEndpoint: 'http://localhost:3001', referenceId: 'demo-request', expiresAt: Math.floor(Date.now() / 1000) + 300 } };
}

function fixtureOrchestrator() {
  const eventStore = createInMemoryDemoEventStore();
  return { eventStore, orchestrator: createDemoOrchestrator({ mode: 'fixture', eventStore, requestChallenge: async () => challenge(), getRiskReader() { throw new Error('fixture normal flow uses its explicit clean fixture reader'); }, getRiskPublisher: () => undefined }) };
}

describe('QuoteSeal demo orchestration', () => {
  it('traces a normal fixture flow without delivering a resource or claiming a transaction', async () => {
    const { orchestrator } = fixtureOrchestrator();
    const run = await orchestrator.run('NORMAL_PAYMENT');
    expect(run.status).toBe('completed');
    expect(run.verdict).toBe('PASS');
    expect(run.signerCallCount).toBe(1);
    expect(run.accessGranted).toBe(false);
    expect(run.runId).not.toBe(run.paymentRequestId);
  });

  it('keeps concurrent runs and event streams isolated', async () => {
    const { eventStore, orchestrator } = fixtureOrchestrator();
    const [first, second] = await Promise.all([
      orchestrator.run('NORMAL_PAYMENT'),
      orchestrator.run('SUSPICIOUS_PAYMENT'),
    ]);
    expect(first.runId).not.toBe(second.runId);
    expect(first.paymentRequestId).not.toBe(first.runId);
    expect(second.paymentRequestId).not.toBe(second.runId);
    expect(eventStore.list({ runId: first.runId }).every((event) => event.runId === first.runId && event.paymentRequestId === first.paymentRequestId)).toBe(true);
    expect(eventStore.list({ runId: second.runId }).every((event) => event.runId === second.runId && event.paymentRequestId === second.paymentRequestId)).toBe(true);
    const firstEvents = eventStore.list({ runId: first.runId });
    expect(eventStore.list({ runId: first.runId, after: firstEvents[0]?.timestamp })).toHaveLength(firstEvents.length - 1);
  });

  it('blocks a substituted merchant payee before rawSigner is invoked', async () => {
    const { eventStore, orchestrator } = fixtureOrchestrator();
    const run = await orchestrator.run('SUSPICIOUS_PAYMENT');
    const events = eventStore.list({ runId: run.runId });
    expect(run.status).toBe('blocked');
    expect(run.signerCallCount).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({ eventType: 'ABNORMAL_ACTIVITY_MATCHED', reasonCode: 'UNAUTHORIZED_PAYEE' }));
    expect(events).toContainEqual(expect.objectContaining({ eventType: 'SIGNER_SKIPPED', signerCallCount: 0 }));
  });

  it('blocks Merchant B with a trusted fixture WalletRiskState and no transaction submission', async () => {
    const { eventStore, orchestrator } = fixtureOrchestrator();
    const run = await orchestrator.run('CROSS_MERCHANT_BLOCK');
    const events = eventStore.list({ runId: run.runId });
    expect(run.status).toBe('blocked');
    expect(run.signerCallCount).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({ eventType: 'WALLET_RISK_STATE_READ', arkivTrustedOwner: '0x1111111111111111111111111111111111111111' }));
    expect(events.some((event) => event.eventType === 'HEDERA_TRANSACTION_SUBMITTED')).toBe(false);
  });

  it.each(['spoofed reporter', 'expired state', 'RPC failure'])('fails closed when Arkiv returns no trusted state: %s', async () => {
    const eventStore = createInMemoryDemoEventStore();
    const orchestrator = createDemoOrchestrator({
      mode: 'arkiv-live', eventStore, requestChallenge: async () => challenge(), getRiskPublisher() { return { async reportSuspiciousWallet() { return { writer: '0x1111111111111111111111111111111111111111', signal: { entityKey: '0x1' }, riskState: { entityKey: '0x2', expiresAt: 200n } }; } }; },
      getRiskReader() { return { async getTrustedWalletRiskState() { return { kind: 'not_found' as const }; } }; },
    });
    const run = await orchestrator.run('CROSS_MERCHANT_BLOCK');
    expect(run.status).toBe('failed');
    expect(run.verdict).toBe('UNVERIFIABLE');
    expect(run.signerCallCount).toBe(0);
  });

  it('rejects spoofed and expired Arkiv records before the cross-merchant gate', async () => {
    const trustedOwner = '0x1111111111111111111111111111111111111111' as const;
    const candidate: WalletRiskStateCandidate = {
      $key: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      $owner: '0x2222222222222222222222222222222222222222',
      $expiresAt: 100n,
      walletKey: { value: '0.0.90001' }, network: { value: 'hedera:testnet' }, status: { value: 'BLOCK' }, score: { value: '1' }, policyVersion: { value: 'test-v1' }, computedAt: { value: 1n },
    };
    const reader = createTrustedWalletRiskReader({ async fetchWalletRiskStates() { return { blockNumber: 100n, candidates: [candidate] }; } }, trustedOwner);
    await expect(reader.getTrustedWalletRiskState({ walletKey: '0.0.90001', network: 'hedera:testnet' })).resolves.toEqual({ kind: 'not_found' });
  });

  it('rejects a trusted-shaped record from an untrusted reporter', async () => {
    const eventStore = createInMemoryDemoEventStore();
    const orchestrator = createDemoOrchestrator({
      mode: 'arkiv-live', eventStore, requestChallenge: async () => challenge(),
      trustedArkivOwner: '0x1111111111111111111111111111111111111111',
      getRiskPublisher: () => ({ async reportSuspiciousWallet() { return { writer: '0x1111111111111111111111111111111111111111', signal: { entityKey: '0x1' }, riskState: { entityKey: '0x2', expiresAt: 200n } }; } }),
      getRiskReader: () => ({ getTrustedWalletRiskState: async () => ({ kind: 'trusted', state: { status: 'BLOCK', entityKey: '0x2', owner: '0x2222222222222222222222222222222222222222', expiresAt: 200n } }) }),
    });
    const run = await orchestrator.run('CROSS_MERCHANT_BLOCK');
    expect(run.error).toMatchObject({ code: 'LIVE_DEPENDENCY_UNAVAILABLE' });
    expect(run.signerCallCount).toBe(0);
  });

  it('fails closed when the Arkiv RPC is unavailable', async () => {
    const reader = createTrustedWalletRiskReader({ async fetchWalletRiskStates() { throw new Error('RPC unavailable'); } }, '0x1111111111111111111111111111111111111111', { retries: 0, timeoutMs: 10 });
    await expect(reader.getTrustedWalletRiskState({ walletKey: '0.0.90001', network: 'hedera:testnet' })).resolves.toMatchObject({ kind: 'unavailable' });
  });

  it('returns a structured unavailable result when a live normal risk lookup cannot be verified', async () => {
    const eventStore = createInMemoryDemoEventStore();
    const orchestrator = createDemoOrchestrator({
      mode: 'arkiv-live', eventStore, requestChallenge: async () => challenge(),
      getRiskReader: () => ({ getTrustedWalletRiskState: async () => ({ kind: 'unavailable', reason: 'RPC unavailable' }) }),
      getRiskPublisher: () => undefined,
    });
    const run = await orchestrator.run('NORMAL_PAYMENT');
    expect(run.status).toBe('failed');
    expect(run.error).toMatchObject({ code: 'LIVE_DEPENDENCY_UNAVAILABLE' });
    expect(run.accessGranted).toBe(false);
  });

  it('uses Arkiv reads but never submits Hedera in arkiv-live mode', async () => {
    const eventStore = createInMemoryDemoEventStore();
    let submitCalls = 0;
    const orchestrator = createDemoOrchestrator({
      mode: 'arkiv-live', eventStore, requestChallenge: async () => challenge(),
      getRiskReader: () => ({ getTrustedWalletRiskState: async () => ({ kind: 'trusted', state: { status: 'ALLOW', entityKey: 'risk-allow', owner: '0x1111111111111111111111111111111111111111', expiresAt: 9999999999n } }) }),
      getRiskPublisher: () => undefined,
      executeLivePayment: async () => { submitCalls += 1; return { transactionId: 'never', paymentProof: 'never' }; },
    });
    const run = await orchestrator.run('NORMAL_PAYMENT');
    expect(run.status).toBe('completed');
    expect(run.accessGranted).toBe(false);
    expect(submitCalls).toBe(0);
    expect(eventStore.list({ runId: run.runId })).toContainEqual(expect.objectContaining({ eventType: 'PAYMENT_SUBMISSION_SIMULATED', dataSource: 'simulated_fixture' }));
  });

  it('does not retry a payment after an uncertain live execution', async () => {
    const eventStore = createInMemoryDemoEventStore();
    let submitCalls = 0;
    const orchestrator = createDemoOrchestrator({
      mode: 'full-live', eventStore, requestChallenge: async () => challenge(),
      getRiskReader: () => ({ getTrustedWalletRiskState: async () => ({ kind: 'trusted', state: { status: 'ALLOW', entityKey: 'risk-allow', owner: '0x1111111111111111111111111111111111111111', expiresAt: 9999999999n } }) }),
      getRiskPublisher: () => undefined,
      executeLivePayment: async () => { submitCalls += 1; return { transactionId: '0.0.54321@1.2', paymentProof: 'proof' }; },
      verifyLiveSettlement: async () => false,
    });
    const run = await orchestrator.run('NORMAL_PAYMENT');
    expect(submitCalls).toBe(1);
    expect(run.status).toBe('failed');
    expect(run.accessGranted).toBe(false);
    expect(eventStore.list({ runId: run.runId })).toContainEqual(expect.objectContaining({ reasonCode: 'HEDERA_SETTLEMENT_UNCERTAIN_NO_RETRY', verdict: 'UNVERIFIABLE' }));
  });

  it('delivers a resource only after independent settlement confirmation', async () => {
    const eventStore = createInMemoryDemoEventStore();
    const orchestrator = createDemoOrchestrator({
      mode: 'full-live', eventStore, requestChallenge: async () => challenge(),
      getRiskReader: () => ({ getTrustedWalletRiskState: async () => ({ kind: 'trusted', state: { status: 'ALLOW', entityKey: 'risk-allow', owner: '0x1111111111111111111111111111111111111111', expiresAt: 9999999999n } }) }),
      getRiskPublisher: () => undefined,
      executeLivePayment: async () => ({ transactionId: '0.0.54321@1.2', paymentProof: 'proof' }),
      verifyLiveSettlement: async () => true,
    });
    const run = await orchestrator.run('NORMAL_PAYMENT');
    expect(run.status).toBe('completed');
    expect(run.accessGranted).toBe(true);
    expect(eventStore.list({ runId: run.runId })).toContainEqual(expect.objectContaining({ eventType: 'SETTLEMENT_VERIFIED', hederaTransactionId: '0.0.54321@1.2' }));
  });
});
