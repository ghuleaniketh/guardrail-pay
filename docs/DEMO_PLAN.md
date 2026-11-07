# QuoteSeal Stage 1 demo

The Stage 1 demo runs inside `@quoteseal/merchant-api`. It uses the existing HTTP 402 route, PayeeGuard, Arkiv reader and Arkiv publisher. It does not deploy contracts or start another service.

## Modes

`fixture` is the default. It makes no network writes and submits no Hedera payment. Events marked `fixture` are deterministic. A simulated payment never grants access.

`arkiv-live` uses the configured authorized Arkiv publisher and trusted Rabdi reader. Hedera payment submission remains simulated. Do not use it without the credentials and trusted owner below.

`full-live` uses Rabdi and submits one real Hedera testnet payment. It never retries after a settlement result is uncertain. Access appears only after the existing settlement verifier returns a successful on-chain result.

## Run fixture demo

```bash
QUOTESEAL_DEMO_ADMIN_KEY=local-demo-key npm run dev --workspace=@quoteseal/merchant-api
```

In a second terminal, run a predefined scenario and read events:

```bash
curl -X POST http://localhost:3001/api/demo/run \
  -H 'content-type: application/json' \
  -H 'x-demo-admin-key: local-demo-key' \
  -d '{"scenarioId":"NORMAL_PAYMENT"}'
curl http://localhost:3001/api/demo/events
```

Run `SUSPICIOUS_PAYMENT` before `CROSS_MERCHANT_BLOCK` when presenting the story. Fixture mode keeps the flagged state deterministic. The event record labels it as a fixture, not as an accusation or a live fraud finding.

## Live prerequisites

For `arkiv-live`, set `QUOTESEAL_DEMO_MODE=arkiv-live`, `QUOTESEAL_DEMO_ADMIN_KEY`, `ARKIV_ACCESS_KEY`, `ARKIV_PRIVATE_KEY`, and `ARKIV_TRUSTED_OWNER`. The publisher identity must be the trusted owner.

For `full-live`, add valid Hedera testnet `HEDERA_BUYER_ACCOUNT_ID`, `HEDERA_BUYER_PRIVATE_KEY`, and a valid merchant account in `HEDERA_MERCHANT_ACCOUNT_ID`. Keep `HEDERA_MOCK_PAYMENTS` unset. Use a funded, disposable testnet buyer. The service records submitted transaction IDs only when the Hedera client actually returns one.

## Dashboard handoff

The dashboard can poll this read-only endpoint:

```text
GET /api/demo/events?scenarioId=NORMAL_PAYMENT&after=2026-11-07T00:00:00.000Z
```

Response: `{ "events": DemoEvent[] }`. Each event has `scenarioId`, `eventId`, `eventType`, `timestamp`, `buyerId`, `merchantId`, `paymentRequestId`, `network`, `stage`, `verdict`, `reasonCode`, `dataSource`, and optional `arkivEntityKey` and `hederaTransactionId`.

Render provenance as supplied: `fixture`, `local`, `arkiv-rabdi`, and `hedera-testnet` must remain visually distinct. Do not infer a live settlement from a simulated event.
