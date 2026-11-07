import { randomUUID } from 'node:crypto';
import { createGuardedSigner, type MerchantProfile, type SharedRiskLookup, type SharedRiskReader } from '@quoteseal/payee-guard';
import type { X402PaymentTerms } from '@quoteseal/hedera-x402';
import { MVP_FIXTURE_WRITER, MVP_FLAGGED_WALLET } from '@quoteseal/arkiv';
import type { DemoEventStore } from './event-store.js';
import type { DemoDataSource, DemoError, DemoEvent, DemoMode, DemoPaymentChallenge, DemoRun, DemoScenarioDefinition, DemoScenarioId } from './types.js';

const FIXTURE_ENTITY_KEY = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NORMAL_BUYER_WALLET = '0.0.54321';
const DEMO_POLICY = { trustedMerchants: ['researchpro.eth'], maxAmount: 1_000_000_000n };

export const DEMO_SCENARIOS: readonly DemoScenarioDefinition[] = [
  { id: 'NORMAL_PAYMENT', title: 'Normal authorized payment', expectedVerdict: 'PASS', supportedModes: ['fixture', 'arkiv-live', 'full-live'], buyerAccount: NORMAL_BUYER_WALLET, merchantIdentity: 'researchpro.eth', targetNetwork: 'hedera:testnet', keyRule: 'Trusted merchant, payee, asset, amount, and wallet risk state must pass before signing.' },
  { id: 'SUSPICIOUS_PAYMENT', title: 'Unauthorized payee substitution', expectedVerdict: 'BLOCK', supportedModes: ['fixture', 'arkiv-live', 'full-live'], buyerAccount: NORMAL_BUYER_WALLET, merchantIdentity: 'researchpro.eth', targetNetwork: 'hedera:testnet', keyRule: 'A substituted merchant recipient blocks before the signer is reached.' },
  { id: 'CROSS_MERCHANT_BLOCK', title: 'Cross-merchant Arkiv block', expectedVerdict: 'BLOCK', supportedModes: ['fixture', 'arkiv-live', 'full-live'], buyerAccount: MVP_FLAGGED_WALLET, merchantIdentity: 'merchant-b.demo', targetNetwork: 'hedera:testnet', keyRule: 'Merchant B accepts only an active WalletRiskState from the configured trusted Arkiv owner.' },
];

export interface DemoRiskPublisher {
  reportSuspiciousWallet(input: { walletKey: string; network: string; signalCode: string; severity: 'CRITICAL'; source: string; referenceId: string; status: 'BLOCK' }): Promise<{ writer: string; signal: { entityKey: string }; riskState: { entityKey: string; expiresAt: bigint } }>;
}

export interface DemoOrchestratorDependencies {
  mode: DemoMode;
  eventStore: DemoEventStore;
  requestChallenge(): Promise<DemoPaymentChallenge>;
  getRiskReader(): SharedRiskReader;
  getRiskPublisher(): DemoRiskPublisher | undefined;
  executeLivePayment?(terms: X402PaymentTerms): Promise<{ transactionId: string; paymentProof: string }>;
  verifyLiveSettlement?(input: { paymentProof: string; terms: X402PaymentTerms }): Promise<boolean>;
  /** Server-owned tinybar ceiling; clients cannot change the challenge amount. */
  maxPaymentTinybars?: bigint;
  /** Optional second assertion for readers; the Arkiv adapter also validates this. */
  trustedArkivOwner?: string;
  now?: () => Date;
}

export class DemoDependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DemoDependencyError';
  }
}

function profileFor(terms: X402PaymentTerms): MerchantProfile {
  return { ensName: terms.ensName ?? 'researchpro.eth', serviceEndpoint: terms.serviceEndpoint, network: terms.network, assetId: terms.asset, activePayTo: terms.payTo, maxAmount: 1_000_000_000n, profileVersion: 1, rotationStatus: 'none' };
}

function reasonCode(reason: string): string {
  const separator = reason.indexOf(':');
  return separator === -1 ? reason : reason.slice(0, separator);
}

function cleanFixtureReader(): SharedRiskReader {
  return { async getTrustedWalletRiskState() { return { kind: 'trusted', state: { status: 'ALLOW', entityKey: 'fixture-clean-wallet', owner: MVP_FIXTURE_WRITER, expiresAt: 9_999_999_999n } }; } };
}

export function createDemoOrchestrator(deps: DemoOrchestratorDependencies) {
  const now = deps.now ?? (() => new Date());
  const maxPaymentTinybars = deps.maxPaymentTinybars ?? DEMO_POLICY.maxAmount;

  async function run(scenarioId: DemoScenarioId): Promise<DemoRun> {
    const runId = randomUUID();
    const startedAt = now().toISOString();
    let lastEventTimestamp = startedAt;
    const paymentRequestId = `${scenarioId.toLowerCase()}-${randomUUID()}`;
    const identity = scenarioId === 'CROSS_MERCHANT_BLOCK'
      ? { buyerId: MVP_FLAGGED_WALLET, merchantId: 'merchant-b.demo' }
      : { buyerId: NORMAL_BUYER_WALLET, merchantId: 'researchpro.eth' };
    let network = 'hedera:testnet';
    const emit = (event: Omit<DemoEvent, 'runId' | 'eventId' | 'timestamp'>) => {
      const candidate = now().toISOString();
      const timestamp = candidate > lastEventTimestamp
        ? candidate
        : new Date(new Date(lastEventTimestamp).getTime() + 1).toISOString();
      lastEventTimestamp = timestamp;
      deps.eventStore.append({ ...event, runId, eventId: randomUUID(), timestamp });
    };
    const challenge = async () => {
      const result = await deps.requestChallenge();
      if (result.statusCode !== 402) throw new DemoDependencyError(`Merchant payment endpoint returned ${result.statusCode}, not HTTP 402`);
      let amount: bigint;
      try {
        amount = BigInt(result.terms.amount);
      } catch {
        throw new DemoDependencyError('Merchant payment challenge has an invalid amount');
      }
      if (amount <= 0n || amount > maxPaymentTinybars) {
        throw new DemoDependencyError(`Merchant payment amount exceeds the server demo limit of ${maxPaymentTinybars.toString()} tinybars`);
      }
      if (result.terms.network !== 'hedera:testnet' || result.terms.asset !== 'HBAR') {
        throw new DemoDependencyError('Demo payment challenge must use HBAR on Hedera testnet');
      }
      network = result.terms.network;
      emit({ scenarioId, eventType: 'HTTP_402_CHALLENGE', ...identity, paymentRequestId, network, stage: 'CHALLENGE_ISSUED', verdict: 'PASS', reasonCode: 'HTTP_402_PAYMENT_REQUIRED', dataSource: 'local', message: 'Merchant returned payment requirements.' });
      return result.terms;
    };
    try {
      let outcome: { verdict: DemoRun['verdict']; signerCallCount: number; accessGranted: boolean };
      switch (scenarioId) {
        case 'NORMAL_PAYMENT': outcome = await normal({ challenge, emit, scenarioId, paymentRequestId, identity }); break;
        case 'SUSPICIOUS_PAYMENT': outcome = await suspicious({ challenge, emit, scenarioId, paymentRequestId, identity }); break;
        case 'CROSS_MERCHANT_BLOCK': outcome = await crossMerchant({ challenge, emit, scenarioId, paymentRequestId, identity }); break;
      }
      const status = outcome.verdict === 'BLOCK' ? 'blocked' : outcome.verdict === 'PASS' ? 'completed' : 'failed';
      const failed = status === 'failed';
      emit({ scenarioId, eventType: failed ? 'RUN_FAILED' : 'RUN_COMPLETED', ...identity, paymentRequestId, network, stage: failed ? 'ERROR' : status === 'blocked' ? 'BLOCKED' : 'COMPLETED', verdict: outcome.verdict, reasonCode: failed ? 'DEMO_UNVERIFIABLE' : status === 'blocked' ? 'DEMO_BLOCKED' : 'DEMO_COMPLETED', dataSource: 'local', signerCallCount: outcome.signerCallCount });
      const record: DemoRun = { runId, scenarioId, mode: deps.mode, status, startedAt, completedAt: now().toISOString(), paymentRequestId, ...outcome, ...(failed ? { error: { code: 'EXECUTION_FAILED' as const, message: 'Settlement or verification did not complete; protected resource was withheld' } } : {}) };
      deps.eventStore.saveRun(record);
      return record;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Demo execution failed';
      const demoError: DemoError = { code: error instanceof DemoDependencyError ? 'LIVE_DEPENDENCY_UNAVAILABLE' : 'EXECUTION_FAILED', message };
      emit({ scenarioId, eventType: 'RUN_FAILED', ...identity, paymentRequestId, network, stage: 'ERROR', verdict: 'UNVERIFIABLE', reasonCode: demoError.code, dataSource: 'local', message });
      const record: DemoRun = { runId, scenarioId, mode: deps.mode, status: 'failed', startedAt, completedAt: now().toISOString(), paymentRequestId, verdict: 'UNVERIFIABLE', signerCallCount: 0, accessGranted: false, error: demoError };
      deps.eventStore.saveRun(record);
      return record;
    }
  }

  async function normal(context: RunContext) {
    const terms = await context.challenge();
    const riskReader = deps.mode === 'fixture' ? cleanFixtureReader() : deps.getRiskReader();
    let transactionId: string | undefined;
    let paymentProof: string | undefined;
    const signer = createGuardedSigner(async () => {
      if (deps.mode !== 'full-live') return { kind: 'simulated' as const };
      if (!deps.executeLivePayment) throw new DemoDependencyError('Hedera testnet signing is not configured for full-live mode');
      const payment = await deps.executeLivePayment(terms);
      if (!payment.transactionId || !payment.paymentProof) {
        throw new DemoDependencyError('Hedera execution returned no transaction ID and proof; settlement is unverified');
      }
      transactionId = payment.transactionId;
      paymentProof = payment.paymentProof;
      return { kind: 'live' as const };
    }, { resolveProfile: async () => profileFor(terms), policy: DEMO_POLICY, riskReader });
    const execution = await signer.execute(toPaymentRequest(terms, NORMAL_BUYER_WALLET));
    context.emit({ scenarioId: context.scenarioId, eventType: 'FIREWALL_DECISION', ...context.identity, paymentRequestId: context.paymentRequestId, network: terms.network, stage: 'SECURITY_EVALUATION', verdict: execution.verdict, reasonCode: reasonCode(execution.reason), dataSource: 'local', signerCallCount: execution.signerCallCount });
    if (execution.verdict !== 'PASS') {
      if (execution.verdict === 'UNVERIFIABLE' && deps.mode !== 'fixture') {
        throw new DemoDependencyError(execution.reason);
      }
      context.emit({ scenarioId: context.scenarioId, eventType: 'SIGNER_SKIPPED', ...context.identity, paymentRequestId: context.paymentRequestId, network: terms.network, stage: 'BLOCKED', verdict: execution.verdict, reasonCode: reasonCode(execution.reason), dataSource: 'local', signerCallCount: execution.signerCallCount });
      return { verdict: execution.verdict, signerCallCount: execution.signerCallCount, accessGranted: false };
    }
    if (deps.mode !== 'full-live') {
      context.emit({ scenarioId: context.scenarioId, eventType: 'PAYMENT_SUBMISSION_SIMULATED', ...context.identity, paymentRequestId: context.paymentRequestId, network: terms.network, stage: 'SIGNING', verdict: 'PASS', reasonCode: 'SIMULATED_PAYMENT_NOT_SUBMITTED', dataSource: 'simulated_fixture', signerCallCount: execution.signerCallCount });
      context.emit({ scenarioId: context.scenarioId, eventType: 'ACCESS_WITHHELD', ...context.identity, paymentRequestId: context.paymentRequestId, network: terms.network, stage: 'RESOURCE_DELIVERY', verdict: 'UNVERIFIABLE', reasonCode: 'SIMULATED_PAYMENT_CANNOT_GRANT_ACCESS', dataSource: 'simulated_fixture' });
      return { verdict: 'PASS' as const, signerCallCount: execution.signerCallCount, accessGranted: false };
    }
    context.emit({ scenarioId: context.scenarioId, eventType: 'HEDERA_TRANSACTION_SUBMITTED', ...context.identity, paymentRequestId: context.paymentRequestId, network: terms.network, stage: 'SETTLING', verdict: 'PASS', reasonCode: 'HEDERA_TESTNET_SUBMITTED', dataSource: 'hedera_live', hederaTransactionId: transactionId, signerCallCount: execution.signerCallCount });
    const settled = paymentProof !== undefined && deps.verifyLiveSettlement !== undefined && await deps.verifyLiveSettlement({ paymentProof, terms });
    if (!settled) {
      context.emit({ scenarioId: context.scenarioId, eventType: 'ACCESS_WITHHELD', ...context.identity, paymentRequestId: context.paymentRequestId, network: terms.network, stage: 'RESOURCE_DELIVERY', verdict: 'UNVERIFIABLE', reasonCode: 'HEDERA_SETTLEMENT_UNCERTAIN_NO_RETRY', dataSource: 'hedera_live', hederaTransactionId: transactionId });
      return { verdict: 'UNVERIFIABLE' as const, signerCallCount: execution.signerCallCount, accessGranted: false };
    }
    context.emit({ scenarioId: context.scenarioId, eventType: 'SETTLEMENT_VERIFIED', ...context.identity, paymentRequestId: context.paymentRequestId, network: terms.network, stage: 'SETTLING', verdict: 'PASS', reasonCode: 'HEDERA_SETTLEMENT_VERIFIED', dataSource: 'hedera_live', hederaTransactionId: transactionId });
    context.emit({ scenarioId: context.scenarioId, eventType: 'ACCESS_GRANTED', ...context.identity, paymentRequestId: context.paymentRequestId, network: terms.network, stage: 'RESOURCE_DELIVERY', verdict: 'PASS', reasonCode: 'MERCHANT_VERIFIED_SETTLEMENT', dataSource: 'local', hederaTransactionId: transactionId });
    return { verdict: 'PASS' as const, signerCallCount: execution.signerCallCount, accessGranted: true };
  }

  async function suspicious(context: RunContext) {
    const terms = await context.challenge();
    const substitutedPayTo = '0.0.99999';
    let rawSignerCalls = 0;
    const signer = createGuardedSigner(async () => { rawSignerCalls += 1; return { unexpected: true }; }, { resolveProfile: async () => profileFor(terms), policy: DEMO_POLICY });
    const execution = await signer.execute({ ...toPaymentRequest(terms, NORMAL_BUYER_WALLET), payTo: substitutedPayTo });
    context.emit({ scenarioId: context.scenarioId, eventType: 'ABNORMAL_ACTIVITY_MATCHED', ...context.identity, paymentRequestId: context.paymentRequestId, network: terms.network, stage: 'SECURITY_EVALUATION', verdict: execution.verdict, reasonCode: 'UNAUTHORIZED_PAYEE', dataSource: 'local', message: 'The detected subject is the substituted merchant recipient, not the buyer wallet.' });
    context.emit({ scenarioId: context.scenarioId, eventType: 'FIREWALL_DECISION', ...context.identity, paymentRequestId: context.paymentRequestId, network: terms.network, stage: 'BLOCKED', verdict: execution.verdict, reasonCode: reasonCode(execution.reason), dataSource: 'local', signerCallCount: execution.signerCallCount });
    context.emit({ scenarioId: context.scenarioId, eventType: 'SIGNER_SKIPPED', ...context.identity, paymentRequestId: context.paymentRequestId, network: terms.network, stage: 'BLOCKED', verdict: execution.verdict, reasonCode: 'RAW_SIGNER_NOT_CALLED', dataSource: 'local', signerCallCount: rawSignerCalls });
    return { verdict: execution.verdict, signerCallCount: rawSignerCalls, accessGranted: false };
  }

  async function crossMerchant(context: RunContext) {
    const terms = await context.challenge();
    const source: DemoDataSource = deps.mode === 'fixture' ? 'simulated_fixture' : 'arkiv_live';
    const publication = deps.mode === 'fixture'
      ? { entityKey: FIXTURE_ENTITY_KEY, owner: MVP_FIXTURE_WRITER, expiresAt: 9_999_999_999n }
      : await publishRisk(terms.network, context.paymentRequestId);
    if (deps.trustedArkivOwner && publication.owner.toLowerCase() !== deps.trustedArkivOwner.toLowerCase()) throw new DemoDependencyError('Arkiv risk publication was not signed by the configured trusted owner');
    if (publication.expiresAt <= 0n) throw new DemoDependencyError('Arkiv risk publication returned an expired WalletRiskState');
    context.emit({ scenarioId: context.scenarioId, eventType: 'RISK_SIGNAL_PUBLISHED', ...context.identity, paymentRequestId: context.paymentRequestId, network: terms.network, stage: 'RISK_PUBLICATION', verdict: 'BLOCK', reasonCode: 'DEMO_CROSS_MERCHANT_WALLET_SIGNAL', dataSource: source, arkivEntityKey: publication.entityKey, arkivTrustedOwner: publication.owner, arkivExpiresAtBlock: publication.expiresAt.toString(), message: 'Synthetic demo risk record for the allowlisted buyer wallet.' });
    const lookup = deps.mode === 'fixture' ? fixtureBlockedLookup() : await deps.getRiskReader().getTrustedWalletRiskState({ walletKey: MVP_FLAGGED_WALLET, network: terms.network });
    if (lookup.kind !== 'trusted') throw new DemoDependencyError(`Arkiv trusted WalletRiskState is ${lookup.kind}; fixture data was not substituted`);
    if (deps.trustedArkivOwner && lookup.state.owner.toLowerCase() !== deps.trustedArkivOwner.toLowerCase()) throw new DemoDependencyError('Arkiv WalletRiskState owner is not the configured trusted owner');
    if (lookup.state.expiresAt <= 0n) throw new DemoDependencyError('Arkiv WalletRiskState is expired');
    if (lookup.state.status !== 'BLOCK') throw new DemoDependencyError(`Arkiv trusted WalletRiskState status is ${lookup.state.status}; Merchant B requires BLOCK`);
    context.emit({ scenarioId: context.scenarioId, eventType: 'WALLET_RISK_STATE_READ', ...context.identity, paymentRequestId: context.paymentRequestId, network: terms.network, stage: 'RISK_READ', verdict: lookup.state.status === 'BLOCK' ? 'BLOCK' : 'HOLD', reasonCode: `TRUSTED_SCHEMA_OWNER_WALLET_NETWORK_EXPIRY_VALIDATED_${lookup.state.status}`, dataSource: source, arkivEntityKey: lookup.state.entityKey, arkivTrustedOwner: lookup.state.owner, arkivExpiresAtBlock: lookup.state.expiresAt.toString() });
    const fixedReader: SharedRiskReader = { async getTrustedWalletRiskState() { return lookup; } };
    const signer = createGuardedSigner(async () => ({ shouldNeverRun: true }), { resolveProfile: async () => profileFor(terms), policy: DEMO_POLICY, riskReader: fixedReader });
    const execution = await signer.execute(toPaymentRequest(terms, MVP_FLAGGED_WALLET));
    context.emit({ scenarioId: context.scenarioId, eventType: 'FIREWALL_DECISION', ...context.identity, paymentRequestId: context.paymentRequestId, network: terms.network, stage: 'BLOCKED', verdict: execution.verdict, reasonCode: reasonCode(execution.reason), dataSource: 'local', arkivEntityKey: lookup.state.entityKey, signerCallCount: execution.signerCallCount });
    context.emit({ scenarioId: context.scenarioId, eventType: 'SIGNER_SKIPPED', ...context.identity, paymentRequestId: context.paymentRequestId, network: terms.network, stage: 'BLOCKED', verdict: execution.verdict, reasonCode: 'RAW_SIGNER_NOT_CALLED', dataSource: 'local', arkivEntityKey: lookup.state.entityKey, signerCallCount: execution.signerCallCount });
    return { verdict: execution.verdict, signerCallCount: execution.signerCallCount, accessGranted: false };
  }

  async function publishRisk(network: string, referenceId: string) {
    const publisher = deps.getRiskPublisher();
    if (!publisher) throw new DemoDependencyError(`${deps.mode} requires an authorized Arkiv risk publisher`);
    let result: Awaited<ReturnType<DemoRiskPublisher['reportSuspiciousWallet']>>;
    try {
      result = await publisher.reportSuspiciousWallet({ walletKey: MVP_FLAGGED_WALLET, network, signalCode: 'DEMO_CROSS_MERCHANT_WALLET_SIGNAL', severity: 'CRITICAL', source: 'quoteseal-demo-orchestrator', referenceId, status: 'BLOCK' });
    } catch (error: unknown) {
      throw new DemoDependencyError(error instanceof Error ? error.message : 'Arkiv risk publication failed');
    }
    return { entityKey: result.riskState.entityKey, owner: result.writer, expiresAt: result.riskState.expiresAt };
  }

  return { run };
}

interface RunContext {
  challenge(): Promise<X402PaymentTerms>;
  emit(event: Omit<DemoEvent, 'runId' | 'eventId' | 'timestamp'>): void;
  scenarioId: DemoScenarioId;
  paymentRequestId: string;
  identity: { buyerId: string; merchantId: string };
}

function toPaymentRequest(terms: X402PaymentTerms, payerWallet: string) {
  return { origin: terms.serviceEndpoint, payerWallet, payTo: terms.payTo, amount: terms.amount, asset: terms.asset, network: terms.network, expiresAt: terms.expiresAt, referenceId: terms.referenceId, ensName: terms.ensName };
}

function fixtureBlockedLookup(): SharedRiskLookup {
  return { kind: 'trusted', state: { status: 'BLOCK', entityKey: FIXTURE_ENTITY_KEY, owner: MVP_FIXTURE_WRITER, expiresAt: 9_999_999_999n } };
}
