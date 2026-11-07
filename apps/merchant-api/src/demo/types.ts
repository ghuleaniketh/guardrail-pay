import type { X402PaymentTerms } from '@quoteseal/hedera-x402';
import type { Verdict } from '@quoteseal/payee-guard';

export const DEMO_SCENARIO_IDS = ['NORMAL_PAYMENT', 'SUSPICIOUS_PAYMENT', 'CROSS_MERCHANT_BLOCK'] as const;
export type DemoScenarioId = (typeof DEMO_SCENARIO_IDS)[number];
export const DEMO_MODES = ['fixture', 'arkiv-live', 'full-live'] as const;
export type DemoMode = (typeof DEMO_MODES)[number];

export type DemoDataSource = 'simulated_fixture' | 'local' | 'arkiv_live' | 'hedera_live';
export type DemoStage =
  | 'INITIATING'
  | 'CHALLENGE_ISSUED'
  | 'SECURITY_EVALUATION'
  | 'RISK_PUBLICATION'
  | 'RISK_READ'
  | 'SIGNING'
  | 'SETTLING'
  | 'RESOURCE_DELIVERY'
  | 'COMPLETED'
  | 'BLOCKED'
  | 'ERROR';
export type DemoEventType =
  | 'HTTP_402_CHALLENGE'
  | 'FIREWALL_DECISION'
  | 'ABNORMAL_ACTIVITY_MATCHED'
  | 'RISK_SIGNAL_PUBLISHED'
  | 'WALLET_RISK_STATE_READ'
  | 'SIGNER_SKIPPED'
  | 'PAYMENT_SUBMISSION_SIMULATED'
  | 'HEDERA_TRANSACTION_SUBMITTED'
  | 'SETTLEMENT_VERIFIED'
  | 'ACCESS_GRANTED'
  | 'ACCESS_WITHHELD'
  | 'RUN_COMPLETED'
  | 'RUN_FAILED';

export interface DemoEvent {
  runId: string;
  scenarioId: DemoScenarioId;
  eventId: string;
  eventType: DemoEventType;
  timestamp: string;
  buyerId: string;
  merchantId: string;
  paymentRequestId: string;
  network: string;
  stage: DemoStage;
  verdict: Verdict;
  reasonCode: string;
  dataSource: DemoDataSource;
  arkivEntityKey?: string;
  arkivTrustedOwner?: string;
  arkivExpiresAtBlock?: string;
  hederaTransactionId?: string;
  signerCallCount?: number;
  message?: string;
}

export type DemoRunStatus = 'completed' | 'blocked' | 'failed';

export interface DemoRun {
  runId: string;
  scenarioId: DemoScenarioId;
  mode: DemoMode;
  status: DemoRunStatus;
  startedAt: string;
  completedAt: string;
  paymentRequestId: string;
  verdict: Verdict;
  signerCallCount: number;
  accessGranted: boolean;
  error?: DemoError;
}

export interface DemoError {
  code: 'LIVE_DEPENDENCY_UNAVAILABLE' | 'EXECUTION_FAILED';
  message: string;
}

export interface DemoScenarioDefinition {
  id: DemoScenarioId;
  title: string;
  expectedVerdict: 'PASS' | 'BLOCK';
  supportedModes: readonly DemoMode[];
  buyerAccount: string;
  merchantIdentity: string;
  targetNetwork: 'hedera:testnet';
  keyRule: string;
}

export interface DemoPaymentChallenge {
  statusCode: number;
  terms: X402PaymentTerms;
}

export interface DemoRunRequest {
  scenarioId: DemoScenarioId;
}

export interface DemoEventsResponse {
  events: readonly DemoEvent[];
}

export interface DemoApiError {
  error: {
    code: string;
    message: string;
  };
}
