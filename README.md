# GuardRail Pay

> **Merchant-Authorized Payment Identity for Autonomous x402 Agents**  
> *ETHGlobal Mumbai 2026*

QuoteSeal provides cryptographic payee identity verification for autonomous AI agents paying for HTTP 402 (x402) micropayments on Hedera. Before signing any payment, QuoteSeal's **PayeeGuard** checks that the requested recipient (`payTo`) matches the merchant's trusted ENSv2 payment profile on Sepolia. Legitimate payout changes go through an announced, delayed, human-approved rotation guarded by World ID Agent Pass.

---

## The Problem: Recipient-Substitution (MITM) in x402 Agent Commerce

When an autonomous AI agent encounters an HTTP 402 Payment Required response, it receives payment instructions specifying:
`{ network: "hedera:testnet", asset: "HBAR", payTo: "0.0.12345", amount: "100000000" }`

In autonomous workflows without human-in-the-loop:
1. An attacker (compromised proxy, DNS hijack, or malicious middleware) can rewrite `payTo` to their own account (`0.0.66666`).
2. The agent's wallet blind-signs and transfers funds to the attacker.
3. The facilitator settles the transaction because the seller-supplied requirements matched the payment proof, but the merchant never received the funds.

**QuoteSeal stops this attack at the agent layer.** PayeeGuard verifies the requested `payTo` against the seller's verified ENSv2 profile **before the signer is ever invoked**. If tampered, the payment is blocked with **Signer Call Count = 0**.

---

## Architecture

```
                           +---------------------------------------+
                           |           Merchant Server             |
                           |   (Protected x402 Hedera Endpoint)    |
                           +-------------------+-------------------+
                                               |
                                     1. HTTP 402 Payment
                                        Required (payTo,
                                        amount, asset, network)
                                               |
                                               v
+-----------------------+           +----------+------------+
|  Merchant ENSv2 Name  |           |     Attack Proxy      | (MITM Tampering:
|    (Sepolia Testnet)  |           |  (Rewrites payTo)     |  substitutes evil payTo)
+-----------+-----------+           +----------+------------+
            |                                  |
            |                                  v
            |                       +----------+------------+
            | 2. Resolve Profile    |      Buyer Agent      |
            +---------------------->|                       |
                                    |   +---------------+   |
                                    |   |  PayeeGuard   |   | (Pure Verdict Engine)
                                    |   +-------+-------+   |
                                    +-----------|-----------+
                                                |
                                    3. Verdict: PASS / BLOCK / HOLD / UNVERIFIABLE
                                                |
                          +---------------------+---------------------+
                          |                                           |
                    [Verdict == PASS]                       [Verdict != PASS]
                          |                                           |
                          v                                           v
               Signer executes payment                  ABORT: Signer NOT called
               Settles on Hedera (HashScan)             Signer call count = 0
```

---

## Monorepo Layout

```
quoteseal/
├── apps/
│   ├── merchant-dashboard/        # Next.js: onboarding, DNS/.well-known, rotation & World ID UI
│   ├── merchant-api/              # Fastify: x402 seller endpoint, rotation routes, Drizzle ORM
│   ├── buyer-demo/                # Autonomous buyer agent loop + live verdict timeline & HashScan
│   └── attack-proxy/              # MITM proxy intercepting & rewriting 402 payTo headers/body
├── packages/
│   ├── payee-guard/               # CORE: Verdict engine (PASS/HOLD/BLOCK/UNVERIFIABLE) + T1–T11
│   ├── ens-profile/               # ENSv2 records reader/writer & Zod validation
│   ├── rotation-controller/       # Off-chain client for smart contract timelocked rotations
│   ├── world-auth/                # World ID Agent Pass OIDC operator validation
│   ├── hedera-x402/               # Hedera client/server wrappers & HCS audit logging
│   ├── shared/                    # Types, errors, logger, env helpers
│   └── config/                    # Shared tsconfig, eslint configs
├── contracts/                     # Foundry project (RotationController.sol + tests)
├── tests/                         # Cross-package E2E attack simulations (T1 to T11)
├── docs/                          # Specs, threat model, architecture
├── pnpm-workspace.yaml
└── turbo.json
```

---

## Quickstart & Installation

### Prerequisites
- Node.js >= 22
- pnpm >= 10
- Foundry (`forge`)

### 1. Install Dependencies
```bash
pnpm install
```

### 2. Run Smart Contract Tests (Foundry)
```bash
pnpm forge:test
```
*Output: 8 passed; 0 failed.*

### 3. Run Test Matrix (T1 to T11)
```bash
pnpm test
```

---

## Test Scenarios (T1 to T11)

| ID | Scenario | Expected Verdict | Verified |
|---|---|---|---|
| **T1** | Normal payment, matching ENS profile | **PASS**, signer called, settles on Hedera | Passed |
| **T2** | Proxy rewrites payTo (MITM attack) | **BLOCK**, signer never called (count = 0) | Passed |
| **T3** | Unknown / untrusted merchant | **BLOCK** | Passed |
| **T4** | Look-alike origin domain (`.co` vs `.com`) | **BLOCK** | Passed |
| **T5** | Amount / asset / network drift | **BLOCK** | Passed |
| **T6** | Unannounced payout rotation | **BLOCK** | Passed |
| **T7** | Payment during rotation delay | **HOLD**, no signature | Passed |
| **T8** | Approved rotation after delay | **New payTo passes, old rejected** | Passed |
| **T9** | Denied / unauthorized World ID auth | **No activation, old profile remains** | Passed |
| **T10** | ENS / RPC failure | **UNVERIFIABLE** (fail-closed, count = 0) | Passed |
| **T11** | Stale / replayed 402 offer | **BLOCK**, do not sign stale terms | Passed |

---

## Track Implementations

### 1. ENSv2 Payment Identity
- Merchant records stored on ENSv2 resolver on Sepolia (e.g. `researchpro.eth`).
- Records: `serviceEndpoint`, `hederaNetwork`, `assetId`, `activePayTo`, `maxAmount`, `profileVersion`, `rotationStatus`.
- Role separation: Treasury role proposes rotations; `RotationController.sol` is the only entity authorized to update `activePayTo`.

### 2. Hedera x402 Micropayments & On-Chain Settlement Verification
- **Challenge Creation**: HTTP 402 with `payment-required` header and deterministic challenge binding (`referenceId`).
- **Hedera Testnet Signing**: Buyer signs real `TransferTransaction` via `@hashgraph/sdk` with bound memo (`qs:${referenceId}`) and cryptographic authorization signature over payment terms.
- **Server-Side Verification**: Independent verification via Hedera Mirror Node (`reconcileHederaTransaction`) confirming transaction existence, consensus `SUCCESS`, exact tinybar credit to `payTo`, payer debit, and memo binding.
- **Replay Protection**: Persistent SQLite replay protection (`SqliteReplayProtection`) with atomic check-and-insert ensuring payments cannot be re-used across requests or challenges.
- **Audit Trail**: `submitAuditEventToHcs` hashes security verdicts and rotation milestones to Hedera Consensus Service (HCS).
- **Explorer Verification**: Real transactions verifiable on [HashScan Testnet](https://hashscan.io/testnet/).

### 3. Arkiv Rabdi Shared Risk Intelligence
- **Named Schemas**: `RiskSignal` and canonical mutable `WalletRiskState` on Arkiv Rabdi testnet.
- **Server-Side Publisher**: Authorized server-side writer (`0xAFc9...`) publishes risk records with deterministic idempotency deduplication.
- **Pre-Signing Gate**: PayeeGuard consumes trusted Arkiv risk reader; flagged wallets (`BLOCK`) halt execution before raw signing (`signerCallCount = 0`).
- **Cross-Merchant Detection**: Merchant A reports a suspicious wallet; Merchant B independently queries the trusted record and blocks the simulated payment attempt.
- **Dashboard Interface**: Dedicated `/arkiv` route inspecting live verified risk records, entity keys, and policy status.

### 4. World ID Agent Pass
- OIDC flow (`/world/start`, `/world/callback`) ensuring that only verified human operators can approve payout address rotations.
- Denied, cancelled, and unauthorized attempts are rejected; old profile remains strictly active.

---

## Live Testnet Evidence

| Network | Protocol / Service | Identity / Address | Evidence (TxHash / Entity Key / Explorer) | Status |
|---|---|---|---|---|
| **Hedera Testnet** | Real Payment Settlement | Buyer: `0.0.11338944`<br>Merchant: `0.0.11339189` | Tx ID: `0.0.11338944@1794011311.555510736`<br>Consensus Timestamp: `1794011318.421680160`<br>[HashScan Explorer](https://hashscan.io/testnet/transaction/0.0.11338944%401794011311.555510736) | **VERIFIED LIVE** |
| **Arkiv Rabdi** | RiskSignal Publication | Writer: `0xAFc9b641D89cB5C23D247B2Fbf2622BA879E7e7C` | Entity: `0x1efd40614e776d6b782d69e177494c30adc889cc8def7e275adf39e64df941f0`<br>TxHash: `0x4b461ec0e1f1aaadb50b6304535496d1e8aa481d1b7422f54240dc7392592ca3` | **VERIFIED LIVE** |
| **Arkiv Rabdi** | WalletRiskState Upsert | Writer: `0xAFc9b641D89cB5C23D247B2Fbf2622BA879E7e7C` | Entity: `0xb14aa428576a1d4bdd97062dfc178a1b51040a2de6b7c34f49b531e2f9e9bf1f`<br>TxHash: `0xae7e65df3122b15df89134ce031e81a6a02dc85bf0a134f82c396036547753ee` | **VERIFIED LIVE** |

---

## Honest Limitations

- **Defined Protection Scope**: GuardRail Pay reduces a defined class of **recipient-substitution, unauthorized-rotation, and cross-merchant wallet risk**. It does not stop all payment fraud, compromised governance, malicious onboarding, or stolen buyer keys.
- **Protocol Classification**: The current implementation operates as a custom HTTP 402 protocol with native Hedera Mirror Node on-chain reconciliation and cryptographic intent binding. It is not official x402 V2 facilitator compliance (official facilitator endpoint `testnet.facilitator.x402.org` has no DNS records).
- **Backend Decoupling**: Backend payment verification is modularized in `@quoteseal/hedera-x402`. Full merchant API production route wiring remains decoupled while the backend is under development.
- **Deployment Boundaries**: Deployment targets are local development and public testnets (Hedera Testnet, Arkiv Rabdi Testnet, Ethereum Sepolia). No mainnet deployment is active or intended.
- **Mirror Node Latency**: Mirror Node consensus indexing typically requires 1.5–4 seconds after consensus confirmation. Clients and merchant verification endpoints must account for a pending confirmation state.
- **ENS & World ID**: ENS ownership and domain control are not legal business verification. World ID authentication provides human operator verification; hackathon proofs use local operator validation.

---

## Marketing Site & Product UI

QuoteSeal features a full marketing site and interactive product console inspired by the spatial elegance and physics of [Tuyo](https://tuyo.com) (Awwwards Honorable Mention), with 100% original branding, copywriting, procedural 3D card physics, and motion language.

### Tech Stack
- **Framework**: Next.js 15 (App Router) + TypeScript + Tailwind CSS
- **Motion & Physics**: Framer Motion (spring choreography, masked reveals)
- **Smooth Scroll**: Lenis with custom cubic-bezier deceleration
- **3D Spatial Web**: Interactive 3D CSS perspective & procedural canvas tilt with holographic sheen
- **Shared UI**: Monorepo package `@quoteseal/ui`

### Routes
- `/`: Full 10-section marketing landing page (Hero text reveals, 3D card tilt, sticky phone ENS verification, horizontal payment rail, attack proxy simulation, safe rotation countdown, infinite attack marquee, live rolling odometer).
- `/merchant`: Live Merchant Dashboard with ENS profile inspector, 48-hour timelock countdown ring, World ID rotation proposal wizard, and EAC contract role matrix.
- `/buyer`: Buyer Agent Console with interactive Attack Simulator, live terminal telemetry stream, and real-time verdict audit trail with HashScan links.

### Running Locally
```bash
# Install dependencies
pnpm install

# Run the UI (marketing site + dashboards)
pnpm --filter @quoteseal/merchant-dashboard dev

# Open in your browser
http://localhost:3000
http://localhost:3000/merchant
http://localhost:3000/buyer
```

### Original Assets Notice
All SVGs, vector icons, gradients, 3D card textures, color tokens, and typography selections (`Instrument Serif`, `Manrope`, `IBM Plex Mono`) are 100% original and generated specifically for the QuoteSeal protocol. No assets, images, or copy were copied from Tuyo.

---

## License
MIT
# guardrail-pay
