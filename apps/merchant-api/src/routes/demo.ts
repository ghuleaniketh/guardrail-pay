import {
  createArkivReadClient,
  createArkivWalletRiskStateQuery,
  createMerchantRiskPublisher,
  createTrustedWalletRiskReader,
  loadArkivReadConfig,
  loadArkivTrustedOwner,
  loadArkivWriteConfig,
} from '@quoteseal/arkiv';
import { executeHederaPayment, SqliteReplayProtection, verifyPaymentProof } from '@quoteseal/hedera-x402';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createInMemoryDemoEventStore } from '../demo/event-store.js';
import { createDemoOrchestrator, DemoDependencyError, DEMO_SCENARIOS, type DemoRiskPublisher } from '../demo/orchestrator.js';
import { DEMO_MODES, DEMO_SCENARIO_IDS, type DemoMode, type DemoScenarioId } from '../demo/types.js';
import { getDemoReadiness } from '../demo/readiness.js';
import { getMerchantPaymentTerms } from './paid.js';

const eventStore = createInMemoryDemoEventStore();
let activeDemoRuns = 0;
let livePaymentRunsUsed = 0;

function isDemoMode(value: string | undefined): value is DemoMode {
  return value !== undefined && DEMO_MODES.some((mode) => mode === value);
}

function configuredMode(): DemoMode {
  const value = process.env.QUOTESEAL_DEMO_MODE;
  if (value === undefined) return 'fixture';
  if (!isDemoMode(value)) throw new Error('QUOTESEAL_DEMO_MODE must be fixture, arkiv-live, or full-live');
  return value;
}

function isScenarioId(value: unknown): value is DemoScenarioId {
  return typeof value === 'string' && DEMO_SCENARIO_IDS.some((scenarioId) => scenarioId === value);
}

function readScenarioId(value: unknown): DemoScenarioId | undefined {
  if (typeof value !== 'object' || value === null || !('scenarioId' in value)) return undefined;
  return isScenarioId(value.scenarioId) ? value.scenarioId : undefined;
}

function readAdminKey(request: FastifyRequest): string | undefined {
  const key = request.headers['x-demo-admin-key'];
  const normalized = typeof key === 'string' ? key.trim() : '';
  return normalized.length > 0 ? normalized : undefined;
}

function hasDemoAuthorization(request: FastifyRequest): boolean {
  const configured = process.env.QUOTESEAL_DEMO_ADMIN_KEY?.trim();
  const supplied = readAdminKey(request);
  return Boolean(configured && supplied && supplied === configured);
}

function assertFullLiveConfiguration(): void {
  if (process.env.HEDERA_MOCK_PAYMENTS?.trim() === 'true') throw new Error('full-live is disabled while HEDERA_MOCK_PAYMENTS is true');
  if (!process.env.HEDERA_BUYER_ACCOUNT_ID?.trim() || !process.env.HEDERA_BUYER_PRIVATE_KEY?.trim() || !process.env.HEDERA_MERCHANT_ACCOUNT_ID?.trim()) {
    throw new Error('full-live requires Hedera testnet buyer and merchant credentials');
  }
}

function positiveBigIntEnvironment(name: string, fallback: bigint): bigint {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  try {
    const value = BigInt(raw);
    if (value <= 0n) throw new Error('must be positive');
    return value;
  } catch {
    throw new Error(`${name} must be a positive integer`);
  }
}

function positiveIntegerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function createRiskReader() {
  const trustedOwner = loadArkivTrustedOwner();
  if (!trustedOwner) throw new Error('ARKIV_TRUSTED_OWNER is required for live demo modes');
  const client = createArkivReadClient(loadArkivReadConfig());
  const query = createArkivWalletRiskStateQuery(client, trustedOwner);
  return createTrustedWalletRiskReader(query, trustedOwner, { timeoutMs: 2_000, retries: 1 });
}

function createRiskPublisher(): DemoRiskPublisher {
  const publisher = createMerchantRiskPublisher(loadArkivWriteConfig());
  return { reportSuspiciousWallet(input) { return publisher.reportSuspiciousWallet(input); } };
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Demo execution exceeded ${timeoutMs}ms`)), timeoutMs);
    operation.then((result) => { clearTimeout(timeout); resolve(result); }, (error: unknown) => { clearTimeout(timeout); reject(error); });
  });
}

export function demoRoutes(server: FastifyInstance) {
  server.get('/api/demo/scenarios', async () => DEMO_SCENARIOS);

  server.get('/api/demo/readiness', async (_request, reply) => {
    try {
      const report = getDemoReadiness();
      const verifiedHederaTransactionIds = new Set<string>();
      const verifiedArkivEntityKeys = new Set<string>();
      for (const run of eventStore.listRuns()) {
        for (const event of eventStore.list({ runId: run.runId })) {
          if (event.eventType === 'SETTLEMENT_VERIFIED' && event.dataSource === 'hedera_live' && event.hederaTransactionId) {
            verifiedHederaTransactionIds.add(event.hederaTransactionId);
          }
          if ((event.eventType === 'RISK_SIGNAL_PUBLISHED' || event.eventType === 'WALLET_RISK_STATE_READ') && event.dataSource === 'arkiv_live' && event.arkivEntityKey) {
            verifiedArkivEntityKeys.add(event.arkivEntityKey);
          }
        }
      }
      return { ...report, liveEvidence: { verifiedHederaTransactionIds: [...verifiedHederaTransactionIds], verifiedArkivEntityKeys: [...verifiedArkivEntityKeys] } };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Invalid demo configuration';
      return reply.code(503).send({ error: { code: 'DEMO_CONFIGURATION_INVALID', message } });
    }
  });

  server.get<{ Querystring: { runId?: string; after?: string } }>('/api/demo/events', async (request, reply) => {
    const { runId, after } = request.query;
    if (!runId) return reply.code(400).send({ error: { code: 'RUN_ID_REQUIRED', message: 'runId query parameter is required' } });
    if (!eventStore.getRun(runId)) return reply.code(404).send({ error: { code: 'RUN_NOT_FOUND', message: 'No demo run exists for runId' } });
    return { events: eventStore.list({ runId, after }) };
  });

  server.get<{ Params: { runId: string } }>('/api/demo/runs/:runId', async (request, reply) => {
    const run = eventStore.getRun(request.params.runId);
    if (!run) return reply.code(404).send({ error: { code: 'RUN_NOT_FOUND', message: 'No demo run exists for runId' } });
    return run;
  });

  server.post('/api/demo/run', async (request, reply) => {
    if (!hasDemoAuthorization(request)) {
      return reply.code(403).send({ error: { code: 'DEMO_AUTH_REQUIRED', message: 'Demo execution requires x-demo-admin-key' } });
    }
    const scenarioId = readScenarioId(request.body);
    if (!scenarioId) return reply.code(400).send({ error: { code: 'INVALID_SCENARIO', message: 'scenarioId must be an allowlisted demo scenario' } });
    let reservedDemoRun = false;
    try {
      const mode = configuredMode();
      if (mode === 'full-live') assertFullLiveConfiguration();
      const maxPaymentTinybars = positiveBigIntEnvironment('QUOTESEAL_MAX_HBAR_TINYBARS', 1_000_000_000n);
      const maxLivePaymentRuns = positiveIntegerEnvironment('QUOTESEAL_MAX_LIVE_PAYMENT_RUNS', 1);
      const maxConcurrentDemoRuns = positiveIntegerEnvironment('QUOTESEAL_MAX_CONCURRENT_DEMO_RUNS', 4);
      if (activeDemoRuns >= maxConcurrentDemoRuns) {
        return reply.code(429).send({ error: { code: 'DEMO_CONCURRENCY_LIMIT', message: 'The configured maximum number of concurrent demo runs has been reached' } });
      }
      const isLivePaymentRun = mode === 'full-live' && scenarioId === 'NORMAL_PAYMENT';
      if (isLivePaymentRun && livePaymentRunsUsed >= maxLivePaymentRuns) {
        return reply.code(429).send({ error: { code: 'LIVE_PAYMENT_RUN_LIMIT', message: 'The configured maximum number of full-live payment runs has been reached' } });
      }
      activeDemoRuns += 1;
      reservedDemoRun = true;
      const orchestrator = createDemoOrchestrator({
        mode,
        eventStore,
        maxPaymentTinybars,
        trustedArkivOwner: mode === 'fixture' ? undefined : (() => {
          const owner = loadArkivTrustedOwner();
          if (!owner) throw new DemoDependencyError('ARKIV_TRUSTED_OWNER is required for live demo modes');
          return owner;
        })(),
        async requestChallenge() {
          const response = await server.inject({ method: 'GET', url: '/api/research/paid' });
          return { statusCode: response.statusCode, terms: getMerchantPaymentTerms() };
        },
        getRiskReader() {
          try { return createRiskReader(); } catch (error: unknown) {
            throw new DemoDependencyError(error instanceof Error ? error.message : 'Arkiv reader is unavailable');
          }
        },
        getRiskPublisher: mode === 'fixture' ? () => undefined : () => {
          try { return createRiskPublisher(); } catch (error: unknown) {
            throw new DemoDependencyError(error instanceof Error ? error.message : 'Arkiv publisher is unavailable');
          }
        },
        async executeLivePayment(terms) {
          try {
            const result = await executeHederaPayment(terms, { mode: 'real', network: 'testnet' });
            return { transactionId: result.receipt.transactionId, paymentProof: result.paymentProof };
          } catch (error: unknown) {
            throw new DemoDependencyError(error instanceof Error ? error.message : 'Hedera payment execution failed');
          }
        },
        async verifyLiveSettlement({ paymentProof, terms }) {
          try {
            const result = await verifyPaymentProof(paymentProof, terms, { supportedSchemes: [{ scheme: 'hedera', network: 'hedera:testnet', verifiableWithoutFacilitator: true }], timeoutMs: 10_000 }, new SqliteReplayProtection());
            return result.type === 'VERIFIED' && result.onChainRecord?.result === 'SUCCESS';
          } catch (error: unknown) {
            throw new DemoDependencyError(error instanceof Error ? error.message : 'Hedera settlement verification failed');
          }
        },
      });
      // Reserve the one-way live-payment slot only after all server dependencies are constructed.
      if (isLivePaymentRun) livePaymentRunsUsed += 1;
      const run = await withTimeout(orchestrator.run(scenarioId), 20_000);
      return reply.code(run.status === 'failed' && run.error?.code === 'LIVE_DEPENDENCY_UNAVAILABLE' ? 424 : 200).send(run);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Demo execution failed';
      return reply.code(424).send({ error: { code: 'LIVE_DEPENDENCY_UNAVAILABLE', message } });
    } finally {
      if (reservedDemoRun) activeDemoRuns = Math.max(0, activeDemoRuns - 1);
    }
  });
}
