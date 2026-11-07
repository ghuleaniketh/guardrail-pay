import { FastifyInstance } from 'fastify';
import {
  verifyPaymentProof,
  SqliteReplayProtection,
  type PaymentVerificationResult,
  type VerifiedPaymentPayload,
  type OnChainTransactionRecord,
  type X402PaymentTerms,
  createX402Challenge,
} from '@quoteseal/hedera-x402';

/**
 * Merchant-owned payment terms - NOT client-settable
 * These are fixed by the merchant and cannot be modified by the buyer.
 */
const terms: X402PaymentTerms = {
  network: 'hedera:testnet',
  asset: 'HBAR',
  payTo: process.env.HEDERA_MERCHANT_ACCOUNT_ID || '0.0.12345',
  amount: '100000000', // 1 HBAR in tinybars - server-owned, fixed
  ensName: process.env.ENS_MERCHANT_NAME || 'researchpro.eth',
  serviceEndpoint: process.env.MERCHANT_API_URL || 'http://localhost:3001',
  referenceId: `report_${Date.now()}`,
  expiresAt: Math.floor(Date.now() / 1000) + 300, // 5 min TTL
};

/**
 * Merchant-owned payment terms used by the paid route and the controlled demo.
 * Callers receive a copy so they cannot mutate the server's payment challenge.
 */
export function getMerchantPaymentTerms(): X402PaymentTerms {
  return { ...terms };
}

export function paidRoutes(server: FastifyInstance) {
  server.get('/api/research/paid', async (request, reply) => {
    const paymentHeader = request.headers['payment-signature'];

    // If no payment proof provided, respond with HTTP 402 Payment Required
    if (!paymentHeader) {
      const challenge = createX402Challenge(terms);
      reply.header('payment-required', challenge.headers['payment-required']);
      return reply.code(402).send(challenge.body);
    }

    // Step 1: Verify and consume the payment proof using Agent 1's shared module
    // paymentHeader could be string | string[] from Fastify headers - cast to string
    const replay = new SqliteReplayProtection();
    const verification = await verifyPaymentProof(
      paymentHeader as string,
      terms,
      {
        supportedSchemes: [
          {
            scheme: 'exact',
            network: terms.network,
            verifiableWithoutFacilitator: true,
          },
        ],
        facilitator: undefined,
      },
      replay
    );

    // Step 2: Handle each verification outcome
    switch (verification.type) {
      case 'VERIFIED': {
        const { payload, onChainRecord } = verification;

        // Agent 1's verifyPaymentProof returns VERIFIED with onChainRecord when
        // settlement is confirmed. Check the onChainRecord result status.
        if (onChainRecord?.result === 'SUCCESS') {
          // Fully verified and on-chain settled - deliver protected resource
          return reply.code(200).send({
            status: 'success',
            reportId: payload.referenceId || terms.referenceId,
            title: 'Decentralized Payment Integrity for Autonomous Agent Commerce',
            author: 'ResearchPro AI',
            content:
              'Autonomous agents require cryptographic binding between payment challenges and merchant ENS identities to prevent recipient-substitution attacks.',
            verifiedPayee: payload.payTo,
            paymentProofReceived: String(paymentHeader).slice(0, 32) + '...',
            settlementStatus: 'confirmed',
            transactionId: onChainRecord.transactionId,
            timestamp: new Date().toISOString(),
          });
        } else if (onChainRecord?.result === 'PENDING') {
          // Verified but settlement pending on-chain - do NOT deliver resource
          // Return 402 with guidance to retry later
          return reply.code(402).send({
            status: 'pending',
            message: 'Payment verified but on-chain settlement pending',
            verifiedPayee: payload.payTo,
            paymentProofReceived: String(paymentHeader).slice(0, 32) + '...',
            settlementStatus: 'pending',
            settlementDetails: {
              transactionId: onChainRecord?.transactionId,
              result: onChainRecord?.result,
            },
            timestamp: new Date().toISOString(),
          });
        } else {
          // Verified but settlement status unknown or failed
          return reply.code(402).send({
            status: 'pending',
            message: 'Payment verified but settlement confirmation required',
            verifiedPayee: payload.payTo,
            paymentProofReceived: String(paymentHeader).slice(0, 32) + '...',
            settlementStatus: 'unknown',
            timestamp: new Date().toISOString(),
          });
        }
      }

      case 'INVALID':
        return reply.code(400).send({
          status: 'error',
          error: 'invalid_proof',
          message: verification.reason || 'Payment proof is invalid',
        });

      case 'EXPIRED':
        // Challenge has expired, send new 402 with fresh terms
        const newChallenge = createX402Challenge(terms);
        return reply.code(402).send({
          status: 'expired',
          error: 'payment_expired',
          message: verification.reason || 'Payment proof has expired',
          newChallenge: {
            scheme: newChallenge.body.scheme,
            network: newChallenge.body.payment.network,
            amount: newChallenge.body.payment.amount,
            payTo: newChallenge.body.payment.payTo,
            asset: newChallenge.body.payment.asset,
            expiresAt: newChallenge.body.payment.expiresAt,
          },
        });

      case 'REPLAYED':
        // Duplicate request - reject with 409
        return reply.code(409).send({
          status: 'error',
          error: 'replayed_payment',
          message: verification.reason || 'Payment proof has already been verified',
        });

      case 'UNSUPPORTED_PROOF':
        // Custom hedera scheme without crypto proof - reject
        return reply.code(400).send({
          status: 'error',
          error: 'unsupported_proof',
          message: verification.reason || 'Payment proof scheme is not cryptographically verifiable',
        });

      case 'VERIFICATION_UNAVAILABLE':
        // Verification service down - retry later
        return reply.code(503).send({
          status: 'error',
          error: 'verification_unavailable',
          message: verification.reason || 'Payment verification service unavailable',
        });

      default:
        // Unknown error - don't leak internal details
        return reply.code(500).send({
          status: 'error',
          error: 'verification_failed',
          message: 'Payment verification failed',
        });
    }
  });
}
