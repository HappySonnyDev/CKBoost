# Isolated QA Admin upgrade

The ordinary `pnpm qa` / `qa.mjs` workflow retains the committed v3 profile. These commands opt into a separate, confirmed v4 profile for the same public Testnet protocol. They never sign transactions, broadcast, estimate scripts, stop services, or deploy the website. Node 22.13+ and the prepared checkout dependencies are required.

The local `/revamp/testnet-admin-upgrade` page is available only in the explicit isolated QA runtime. Account 1 reviews and signs the Registry code and state as two separate transactions. Signing saves the actual public signed bytes; broadcasting requires another explicit click. The state stage requires the exact code transaction to be committed and its code output currently live. A changed code body requires a new linked Registry identity and recompilation of the financial candidates. Saved attempts are checked for confirmation, never automatically sent or signed again.

After the Registry stages, the separately reviewed financial code batch and protocol configuration update must actually be committed. Candidate plans and source pins are insufficient. From `dapp`, replace the placeholders below with the actual transaction hashes:

```sh
node scripts/qa-admin.mjs confirm --financial-tx 0x<actual-three-code-batch-hash> --protocol-tx 0x<actual-protocol-update-hash>
```

This uses only fixed public Testnet `get_*` RPC methods, with a 30-second round budget and four concurrent reads. It replays canonical full transaction bodies and actual input parents, checks pinned ELF bytes and all current live release outputs, verifies the exact protocol delta, and completely checks the old QA Tip, shared Funding and per-Campaign Funding namespaces. Any remaining old financial cell blocks generation. It never burns or migrates old cells. An unverified round writes only a public audit record.

A successful round writes public evidence under `.qa-local/admin-upgrade/`, and a compact bundle and runtime under `.qa-local/admin-upgrade/confirmed/<profile-hash>/`. It does not select or run that runtime. There is currently no confirmed v4 artifact in the repository; tests use explicitly synthetic evidence.

To select a confirmed profile locally, supply the complete profile hash printed by confirmation:

```sh
node scripts/qa-admin.mjs activate 0x<confirmed-profile-hash>
node scripts/qa-admin.mjs plan
node scripts/qa-admin.mjs check
node scripts/qa-admin.mjs build
node scripts/qa-admin.mjs start
```

`activate` rechecks current chain proof before writing this checkout's local selection. It leaves `config/qa/ckboost-testnet.json` and existing processes unchanged. The Admin launcher uses its own profile directory, Next dist, public environment and build receipt; build and start must match exactly. Ports 9004/9005/9994 must be free and the compatible local SSRI stack at 127.0.0.1:9091 must already be running. Existing services are never reused or killed.

This remains shared public Testnet and shared public Nostr infrastructure. Local build/profile isolation is not a private chain or private content service. Runtime validation checks source consistency offline; the confirmer establishes inclusion and liveness only at its read time, and local selection rechecks them.
