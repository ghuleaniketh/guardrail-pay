import {
  loadArkivReadConfig,
  loadArkivTrustedOwner,
  loadArkivWriteConfig,
} from '@quoteseal/arkiv';
import { DEMO_MODES, type DemoMode } from './types.js';

export interface DemoReadinessReport {
  mode: DemoMode;
  fixture: { ready: true };
  arkivLive: { ready: boolean; missing: string[] };
  fullLive: { ready: boolean; missing: string[] };
  configuration: {
    demoAdminKeyConfigured: boolean;
    sqliteReplayDatabaseConfigured: boolean;
    sqliteReplayDatabaseSource: 'DATABASE_URL' | 'default';
    maxPaymentTinybars: string;
    maxLivePaymentRuns: number;
    maxConcurrentDemoRuns: number;
  };
  liveEvidence: {
    verifiedHederaTransactionIds: string[];
    verifiedArkivEntityKeys: string[];
  };
}

function configuredMode(environment: NodeJS.ProcessEnv): DemoMode {
  const value = environment.QUOTESEAL_DEMO_MODE;
  if (!value) return 'fixture';
  if (!DEMO_MODES.includes(value as DemoMode)) {
    throw new Error('QUOTESEAL_DEMO_MODE must be fixture, arkiv-live, or full-live');
  }
  return value as DemoMode;
}

function has(environment: NodeJS.ProcessEnv, key: string): boolean {
  return Boolean(environment[key]?.trim());
}

function positiveBigInt(environment: NodeJS.ProcessEnv, key: string, fallback: bigint): bigint {
  const raw = environment[key]?.trim();
  if (!raw) return fallback;
  try {
    const value = BigInt(raw);
    if (value <= 0n) throw new Error('must be positive');
    return value;
  } catch {
    throw new Error(`${key} must be a positive integer`);
  }
}

function positiveNumber(environment: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = environment[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer`);
  return value;
}

export function getDemoReadiness(environment: NodeJS.ProcessEnv = process.env): DemoReadinessReport {
  const mode = configuredMode(environment);
  const missingArkiv: string[] = [];
  try { loadArkivReadConfig(environment); } catch { missingArkiv.push('ARKIV_ACCESS_KEY'); }
  try { loadArkivTrustedOwner(environment); if (!has(environment, 'ARKIV_TRUSTED_OWNER')) missingArkiv.push('ARKIV_TRUSTED_OWNER'); } catch { missingArkiv.push('ARKIV_TRUSTED_OWNER'); }
  if (!has(environment, 'ARKIV_PRIVATE_KEY')) missingArkiv.push('ARKIV_PRIVATE_KEY');
  else {
    try { loadArkivWriteConfig(environment); } catch { missingArkiv.push('ARKIV_PRIVATE_KEY_INVALID'); }
  }

  const missingHedera = ['HEDERA_BUYER_ACCOUNT_ID', 'HEDERA_BUYER_PRIVATE_KEY', 'HEDERA_MERCHANT_ACCOUNT_ID']
    .filter((key) => !has(environment, key));
  if (environment.HEDERA_MOCK_PAYMENTS?.trim() === 'true') missingHedera.push('HEDERA_MOCK_PAYMENTS=false');

  return {
    mode,
    fixture: { ready: true },
    arkivLive: { ready: missingArkiv.length === 0, missing: [...new Set(missingArkiv)] },
    fullLive: { ready: missingArkiv.length === 0 && missingHedera.length === 0, missing: [...new Set([...missingArkiv, ...missingHedera])] },
    configuration: {
      demoAdminKeyConfigured: has(environment, 'QUOTESEAL_DEMO_ADMIN_KEY'),
      sqliteReplayDatabaseConfigured: true,
      sqliteReplayDatabaseSource: has(environment, 'DATABASE_URL') ? 'DATABASE_URL' : 'default',
      maxPaymentTinybars: positiveBigInt(environment, 'QUOTESEAL_MAX_HBAR_TINYBARS', 1_000_000_000n).toString(),
      maxLivePaymentRuns: positiveNumber(environment, 'QUOTESEAL_MAX_LIVE_PAYMENT_RUNS', 1),
      maxConcurrentDemoRuns: positiveNumber(environment, 'QUOTESEAL_MAX_CONCURRENT_DEMO_RUNS', 4),
    },
    // This endpoint never performs network reads. Evidence is added only by a verified run.
    liveEvidence: { verifiedHederaTransactionIds: [], verifiedArkivEntityKeys: [] },
  };
}
