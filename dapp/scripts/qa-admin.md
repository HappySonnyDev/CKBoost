# Isolated QA Admin upgrade

The ordinary `pnpm qa` / `qa.mjs` workflow uses the published, confirmed v4 profile in `config/qa/ckboost-testnet-admin-v4.json`, hash `4faf44b759bbcd6218fdb86acb3a27b28c1d41a867c21a60d0b169745563ee06`, for the same independent public Testnet protocol. No activation command is needed for teammates. The original `config/qa/ckboost-testnet.json` remains the immutable v3 parent (`129c…b297`) used to verify the upgrade lineage. Node 22.13+ is required.

The commands below are optional release acceptance tools. They never sign transactions, broadcast, estimate scripts, stop services, or deploy the website. Prepare checkout dependencies before running them.

The local `/revamp/testnet-admin-upgrade` page is available only in the explicit isolated QA runtime. Account 1 reviews and signs the Registry code and state as two separate transactions. Signing saves the actual public signed bytes; broadcasting requires another explicit click. The state stage requires the exact code transaction to be committed and its code output currently live. A changed code body requires a new linked Registry identity and recompilation of the financial candidates. Saved attempts are checked for confirmation, never automatically sent or signed again.

After the Registry stages, the separate `/revamp/testnet-admin-financial-sign` workbench explicitly loads and verifies the three pinned ELF files. Review, sign-and-save, broadcast-once and check-confirmation are separate actions for both the code batch and protocol update. Refresh restores signed receipts; a recorded broadcast attempt cannot be sent or signed again. This workbench never activates a runtime.

The financial code batch and protocol configuration update must actually be committed. Candidate plans and source pins are insufficient. From `dapp`, replace the placeholders below with the actual transaction hashes:

```sh
node scripts/qa-admin.mjs confirm --financial-tx 0x<actual-three-code-batch-hash> --protocol-tx 0x<actual-protocol-update-hash>
```

This uses only fixed public Testnet `get_*` RPC methods, with a 30-second round budget and four concurrent reads. It replays canonical full transaction bodies and actual input parents, checks pinned ELF bytes and all current live release outputs, verifies the exact protocol delta, and completely checks the old QA Tip, shared Funding and per-Campaign Funding namespaces. Any remaining old financial cell blocks generation. It never burns or migrates old cells. An unverified round writes only a public audit record.

A successful round writes public evidence under `.qa-local/admin-upgrade/`, and a compact bundle and runtime under `.qa-local/admin-upgrade/confirmed/<profile-hash>/`. It does not select or run that runtime. The published v4 file contains the actual confirmed release provenance; negative tests also use explicitly synthetic fixtures.

To select a confirmed profile locally, supply the complete profile hash printed by confirmation:

```sh
node scripts/qa-admin.mjs activate 0x<confirmed-profile-hash>
node scripts/qa-admin.mjs plan
node scripts/qa-admin.mjs check
node scripts/qa-admin.mjs build
node scripts/qa-admin.mjs start
```

`activate` rechecks the initial release's live outputs before writing this checkout's optional local selection. It leaves both published profile files and existing processes unchanged. Later Registry edits legitimately consume the initial state output: ordinary `pnpm qa` continues to validate the published provenance offline, while business services prove the current Registry successor, code and authority dynamically. Do not rerun initial-release activation as a daily startup requirement.

The optional Admin launcher and the published launcher keep separate generated metadata and build receipts (`.qa-local/<hash>` and `.qa-local/published-<hash>`). Their exact profile-derived Next dist can be shared; a matching BUILD_ID and identical environment are required before start. Ports 9004/9005/9994 must be free and the compatible local SSRI stack at 127.0.0.1:9091 must already be running. Existing services are never reused or killed.

This remains shared public Testnet and shared public Nostr infrastructure. Local build/profile isolation is not a private chain or private content service. Runtime validation checks source consistency offline; the confirmer establishes inclusion and liveness only at its read time, and local selection rechecks them.
