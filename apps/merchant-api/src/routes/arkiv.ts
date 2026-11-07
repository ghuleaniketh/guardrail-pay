import {
  createArkivReadClient,
  createArkivWalletRiskStateQuery,
  createMerchantRiskPublisher,
  createMvpFixtureRiskReader,
  createTrustedWalletRiskReader,
  loadArkivReadConfig,
  loadArkivWriteConfig,
  type TrustedWalletRiskReader,
} from '@quoteseal/arkiv';
import type { FastifyInstance } from 'fastify';
import { getAddress, type Address } from 'viem';

type ArkivRiskSource =
  | { kind: 'live'; reader: TrustedWalletRiskReader }
  | { kind: 'fixture'; reader: TrustedWalletRiskReader; reason: string };

function createArkivRiskSource(): ArkivRiskSource {
  const trustedOwner = process.env.ARKIV_TRUSTED_OWNER;
  if (!trustedOwner) {
    return {
      kind: 'fixture',
      reader: createMvpFixtureRiskReader(),
      reason: 'ARKIV_TRUSTED_OWNER is not configured',
    };
  }

  try {
    const owner: Address = getAddress(trustedOwner);
    const client = createArkivReadClient(loadArkivReadConfig());
    const query = createArkivWalletRiskStateQuery(client, owner);
    return {
      kind: 'live',
      reader: createTrustedWalletRiskReader(query, owner, { timeoutMs: 2_000, retries: 1 }),
    };
  } catch {
    return {
      kind: 'fixture',
      reader: createMvpFixtureRiskReader(),
      reason: 'Arkiv public reader configuration is invalid',
    };
  }
}

export async function arkivRoutes(server: FastifyInstance) {
  server.get<{ Params: { walletKey: string } }>('/api/arkiv/risk/:walletKey', async (request) => {
    const source = createArkivRiskSource();
    const result = await source.reader.getTrustedWalletRiskState({
      walletKey: request.params.walletKey,
      network: 'hedera:testnet',
    });

    if (result.kind === 'trusted') {
      return {
        mode: source.kind,
        fixtureReason: source.kind === 'fixture' ? source.reason : undefined,
        result: {
          kind: result.kind,
          state: {
            ...result.state,
            expiresAt: result.state.expiresAt.toString(),
            computedAt: result.state.computedAt.toString(),
          },
        },
      };
    }

    return {
      mode: source.kind,
      fixtureReason: source.kind === 'fixture' ? source.reason : undefined,
      result,
    };
  });

  server.post<{
    Body: {
      walletKey: string;
      network?: string;
      signalCode?: string;
      severity?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
      referenceId?: string;
      status?: 'ALLOW' | 'REVIEW' | 'BLOCK' | 'UNKNOWN';
    };
  }>('/api/arkiv/risk/report', async (request, reply) => {
    const configuredAdminKey = process.env.ARKIV_REPORT_ADMIN_KEY;
    const suppliedAdminKey = request.headers['x-arkiv-admin-key'];
    if (
      !configuredAdminKey ||
      typeof suppliedAdminKey !== 'string' ||
      suppliedAdminKey !== configuredAdminKey
    ) {
      return reply.code(403).send({
        status: 'error',
        message: 'Arkiv risk publication requires a server-configured x-arkiv-admin-key',
      });
    }
    try {
      const writeConfig = loadArkivWriteConfig();
      const publisher = createMerchantRiskPublisher(writeConfig);
      const body = request.body;

      if (!body?.walletKey) {
        reply.status(400);
        return { status: 'error', message: 'walletKey is required' };
      }

      const pubResult = await publisher.reportSuspiciousWallet({
        walletKey: body.walletKey,
        network: body.network ?? 'hedera:testnet',
        signalCode: body.signalCode ?? 'UNAUTHORIZED_PAYEE',
        severity: body.severity ?? 'CRITICAL',
        referenceId: body.referenceId ?? `api-report-${Date.now()}`,
        status: body.status ?? 'BLOCK',
      });

      return {
        status: 'success',
        mode: 'live',
        evidence: {
          writer: pubResult.writer,
          signalEntityKey: pubResult.signal.entityKey,
          signalTxHash: pubResult.signal.txHash,
          riskStateEntityKey: pubResult.riskState.entityKey,
          riskStateTxHash: pubResult.riskState.txHash,
          action: pubResult.riskState.action,
          status: pubResult.riskState.status,
        },
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Publication failed';
      reply.status(400);
      return { status: 'error', message };
    }
  });
}
