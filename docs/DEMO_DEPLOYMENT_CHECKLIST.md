# QuoteSeal demo deployment checklist

Stage 1 has no public deployment. Fill this list only with verified values during Stage 2.

| Item | Value | Status | Evidence |
| --- | --- | --- | --- |
| Merchant API public URL | Pending | Not deployed | None |
| Dashboard public URL | Pending | Not deployed | None |
| Arkiv Rabdi chain ID | `7794095` | SDK configuration only | No demo write recorded here |
| Arkiv trusted publisher | Pending | Not configured | None |
| Arkiv RiskSignal entity key | Pending | Not published | None |
| Arkiv WalletRiskState entity key | Pending | Not published | None |
| Arkiv explorer reference | Pending | Not published | None |
| Hedera network | Testnet only | Not executed by Stage 1 | None |
| Hedera transaction ID | Pending | Not submitted | None |
| HashScan evidence | Pending | Not submitted | None |
| Solidity contract addresses | Pending | Not deployed by this stage | None |

Before public use, set a strong `QUOTESEAL_DEMO_ADMIN_KEY`, restrict the runner to operators, configure the Arkiv trusted owner, and test a funded disposable Hedera testnet account. Keep fixture, Arkiv Rabdi, and Hedera testnet evidence separate in the dashboard.
