# CKBoost redesign

Figma source: [CKBoost Redesign](https://www.figma.com/design/nxsPSskHMjrxLYW8AWTf5N/CKBoost-Redesign?node-id=17-2). The six sections cover discovery, contributor submission, pending-response editing, campaign creation, saved templates, and submission review. State variants share routes and components.

## Routes and isolation

- `/revamp`: approved campaign discovery, search and status/difficulty filters.
- `/revamp/campaign/[campaignTypeId]`: public Overview; `?tab=quests` selects contributor quests.
- `/revamp/campaign/[campaignTypeId]/edit`: campaign and reviewer configuration.
- `/revamp/campaigns/new`: creation, wallet-scoped drafts and templates.
- `/revamp/campaign/[campaignTypeId]/review`: assigned reviewer workspace and quest exports.
- `/revamp/design-system`: scoped Light/Dark controls and typography.
- `/revamp/profile`: connected wallet's profile, Campaigns, Activities and lazy Rewards history, reached from the wallet menu's My profile item.
- `/revamp/profile/badges`: current protocol's claimed badges and explicit eligibility/loading/empty/error states.
- `/revamp/admin`: current platform Admin's Overview, period metrics, pending actions, per-asset funding and recorded activity.

The `(legacy)` route group owns the original Nextra layout and page map; its URLs remain unchanged. The `/revamp` layout does not import that shell or construct its page map. The root keeps one shared wallet/query instance while route-specific business providers load on demand. The new subtree is hidden from legacy navigation and marked noindex. The existing homepage is not replaced.

Next's build config derives a small public current-deployment constant from the authoritative `deployments.json`. Discovery reads that constant instead of importing the full deployment history. The original manager, history and shared server protocol helpers keep their APIs and data; loading the manager binds the same current object so its existing in-memory updates remain visible. This requires no new manual environment configuration and does not change deployment records.

Isolated QA runtimes are an explicit opt-in with a validated public profile, distinct protocol identity, scoped drafts and separate build output. The default configuration continues to use `deployments.json`. Public Testnet and shared Nostr relays remain shared services, not a private sandbox. The shared QA setup below ships a public runtime and launches the app against contracts that are already deployed. Local setup/upgrade operators stay disabled. Only when using those operators with `CKBOOST_ENABLE_TESTNET_SETUP=1` do their loopback-only artifact endpoints require separately verified public manifests at `../../../outputs` and exact pinned ELFs at `../../testnet-release`, including `permissions-v2` for upgrades; both paths are relative to the `dapp` working directory. Those external operator artifacts are not included in a normal checkout, and are not needed by `qa:build` or `qa:start`. Operator artifact loading fails closed if they are missing or mismatched. Loading a profile or artifact does not deploy code or activate a runtime.

Colors use wrapper-scoped `--ckb-` variables and CSS Modules. `ckboost-revamp-theme` never changes the document theme class or the old theme preference. Radix portals use the wrapper container. Exact Figma exports live in `public/assets/revamp`; fonts are local, with the new fonts’ OFL notices. Existing Cabinet Grotesk and UI primitives are reused.

## Role policy

The protocol’s on-chain `endorsers_whitelist` is the administrator-managed Organizer registry. Admin retains its management override and platform-approval authority. A currently granted Organizer may create campaigns, and may edit or assign reviewers only on its verified own campaigns. Metadata alone cannot establish ownership: `verifyCampaignOwnership` verifies the configured campaign type and protocol lock, full campaign ID, protocol connection, and owner lock hash.

Review requires a current platform Admin, the campaign's verified owner with a current Organizer grant, or a Reviewer listed in that campaign's consumed `staff_lock_hash_vec`. Assigned Reviewers receive authority only for their assigned campaigns, without settings, Organizer or platform-approval rights. Contributor writes also require the current identity, platform approval, open schedule, eligibility, valid responses and a still-pending own record. Wallet, protocol, activity and response facts are refreshed at transaction boundaries; unsaved provider draft data is not an authorization source.

The SDK, services, proxy endpoint and contracts enforce input-state grants and a net CKB debit by the authorized lock group for privileged actions. This prevents an unsigned ACP deposit from impersonating its owner. State-cell capacity floors preserve ordinary settings edits, and a proxy-co-signed transaction's raw fields remain unchanged. Native, complete CKB-VM and official ACP-lock regressions are documented in `contracts/auth-tests/README.md`.

Contract authorization changes require a separate deployment/upgrade before an old network gains the new behavior. A local source change or passing frontend test is not proof of live-chain support. Deployment capability checks and their configuration are documented in the creation implementation notes.

## Data and transaction behavior

Home uses a separate HTTPS-first read client, so its public reads do not wait for the wallet client's default WebSocket fallback. One protocol snapshot precedes a bounded, paginated campaign batch. Every result must match the configured campaign type, canonical full ConnectedTypeID, current protocol and approved ID; uncovered IDs use exact lookups with bounded concurrency. A batch page budget never silently drops approved IDs. The wallet signing/sending client is unchanged.

Queries coalesce in-flight requests and retain still-approved cached cards during refresh. Individual campaign cache keys use the actual protocol/type/ID rather than an unrelated protocol-cell outpoint; membership remains bound to the current approval snapshot. Discovery does not wait for protocol transaction history, metrics, tipping or user history. Other new business routes use the original ProtocolProvider in its explicit current-cell mode and construct their scoped campaign services from fresh authorization snapshots, without mounting unrelated user/campaign/tipping/history providers. Legacy routes keep the default full provider tree. Current-cell loading has a deadline, retry and client-scope isolation.

New card covers only resolve near the viewport, share event-ID requests and Blob URLs, use a bounded queue and asynchronous per-event disk cache, and cache failures briefly. They do not rewrite the legacy whole-event localStorage cache. The legacy cover hook is unchanged. Idle Home updates once per minute or at an exact schedule boundary, pauses in hidden tabs, and resynchronizes on focus. New navigation and campaign links do not automatically prefetch unrelated routes.

Creation publishes campaign/quest metadata through the existing verified Nostr storage service, then builds the existing campaign transaction. Required-response flags extend off-chain quest-content v1 only; the on-chain schema is unchanged. An optional hidden HTML comment preserves the IANA campaign time zone. Legacy editors may remove that comment. Published quest identifiers and historical reward/acceptance state are preserved.

Submission and review use real signing, broadcast and confirmation signals. A transaction hash alone never produces a confirmed UI. Unresolved transactions block duplicate sends and can resume confirmation. Response HTML, links and files are rendered as untrusted evidence; exports escape spreadsheet formulas and Markdown. Organizer-authored quest requirements are validated before evidence display/export. Reviewer authorization/freshness reads have 12-second deadlines and the independent submission scan has a 30-second deadline, with retry and stale-scope protection.

Staff proxy signing validates current input assignments and exact Points/CKB/UDT claimable pools before signing. NFT reward approval is explicitly unavailable because the SDK has no corresponding payment builder; those submissions remain readable/exportable. Creation's full description remains required by existing business/contract validation although the Figma label does not mark it required.

Drafts/templates are local and scoped by network, protocol and wallet. Browser Back/Forward cannot reliably use the custom link-exit modal; unmount flushes the latest draft. Templates with asset rewards require the separate quota/funding flow and are explicitly blocked rather than silently dropping or funding assets. Legacy approval timestamps are unavailable; the UI states that limitation.

## Verification

From `dapp`, run `./node_modules/.bin/jest components/revamp/__tests__ lib/revamp/__tests__ netlify/lib/staff-authorization.test.ts netlify/lib/staff-claimable-rewards.test.ts netlify/__tests__/staff-approve-submissions.test.ts netlify/__tests__/staff-approve-submissions.integration.test.ts netlify/__tests__/isolated-protocol-scope.test.ts netlify/__tests__/platform-stats.test.ts --runInBand` for the focused interaction, isolation, role, data, evidence, transaction-boundary and real-codec proxy-handler suites. Run `./node_modules/.bin/jest --runInBand` for the complete dapp suite. The SDK authorization suites run from `packages/ssri-ckboost` with `pnpm exec jest --config sdk-auth.jest.config.cjs --runInBand`.

Run `./node_modules/.bin/tsc --noEmit --incremental false` separately from `NEXT_TELEMETRY_DISABLED=1 ./node_modules/.bin/next build --webpack`. The repository config already sets `typescript.ignoreBuildErrors: true`; build success is not a clean type-check guarantee. The current type check retains 6 pre-existing profile-data and Netlify cache-refresh diagnostics. Two tipping predicate diagnostics were fixed while making the pending-tip workflow scope-safe. Two unused imports from an external CCC checkout were removed for portable local startup.

Browser acceptance compares the supplied desktop frames and checks narrow layouts, Light/Dark, filters and direct-route access. Wallet-signing and on-chain permission behavior require the corresponding contract tests and an upgraded test deployment; no real wallet transaction is executed as part of visual QA.

## Admin Overview implementation

The finalized Admin Overview implementation and remaining capability gaps are
documented in [the admin implementation notes](../../lib/revamp/admin-README.md).

## Personal profile implementation

The profile follows Figma `3247:18057`. Its desktop content is capped at 1440px:
72px side padding, a 320px sidebar, 32px gap and 944px workspace at the design
width. Narrow layouts stack the sidebar and workspace; tables scroll inside
their cards. Light/Dark uses the existing wrapper tokens. Exported cover,
badge artwork and pixel icons remain local assets.

Profile reads use the current protocol and wallet lock. Identity, spendable
Points, campaign/activity data, badges and positive Points transaction history
have independent loading/error/retry states. Changing account, client or
protocol hides previous results. A failed query never becomes a zero balance
or an empty participation history. No legacy full-history provider is mounted.
Rewards history is requested only after selecting Rewards.

“Total points” is the wallet's current spendable Points balance. Campaign
“Points earned” sums its current accepted quest awards; it is not a lifetime
ledger. Activity shows current review status, and “Last active” comes from the
User Cell. UserData has no joined date, so one is not invented. Rewards shows
positive wallet changes among at most 20 matching transactions. The API does
not prove which campaign produced a change. Timestamps are read from matching
block headers only after opening Rewards, with merged requests and at most
four simultaneous reads. Missing or invalid headers leave dates unavailable;
dates are never guessed from submission time. Unresolvable
transaction inputs fail the entire history response instead of overstating
received Points by omitting those inputs.

Name editing reuses the existing on-chain profile recipe and verification
service, requiring explicit wallet interaction. It reports success only after
confirmation and a fresh User Cell containing the new name. Retrying a pending
update checks the same transaction; a read refresh cannot trigger a second
name transaction. The existing verification service must be configured for
this environment; reading a name does not require that service or a private key.

Badge definitions and receiver records are read only from this protocol.
Unclaimed definitions have **unknown** eligibility because the legacy
eligibility/attestation service does not scope its selection by protocol.
The new route does not call that service or enable badge claims. It displays
an unavailable state instead of “0 claimable” or “all caught up” in that case.
Known milestone titles use their Figma artwork; custom claimed badges retain
their actual title. No badge definitions or claims are created by opening a
profile. The original `/profile` and its existing reward/identity flows remain
available. This iteration does not upgrade contracts, alter roles or deploy a
site.

Focused profile tests cover identity changes, partial reads, bigint totals,
name confirmation/rejection, sorting, keyboard tabs, clipboard feedback and
unknown badge eligibility. The broader revamp regression suite also exercises
existing campaign and permission behavior. Browser fixtures use isolated test
data outside app routes and never connect to or sign with a user's wallet.

## Shared Testnet QA setup

This selects the same QA protocol used for the four-account acceptance flow.
It is a shared protocol on public CKB Testnet, not a new local blockchain or an
independent sandbox for each developer. Activity and response content may be
published to public Nostr relays. Use test content and your own test wallet.

Prerequisites:

- macOS or Linux shell; on Windows use WSL. Native Windows command launching is not supported by these scripts.
- Node **22.13+**; the verified local version is **22.19.0**.
- pnpm **9.15.9**.
- Docker running, with Linux/amd64 support, including emulation on ARM hosts.
- Internet access for package installation, Docker images and public Testnet.

Check `node --version` and `pnpm --version` first. If needed, install the pinned
package manager with `npm install --global pnpm@9.15.9`; the QA preparation
command rejects other pnpm versions rather than rewriting the lockfiles.

Docker must already be running. Clone the fork's development branch and start
the complete QA stack in **one foreground terminal**:

```sh
git clone --branch codex/ckboost-revamp https://github.com/HappySonnyDev/CKBoost.git
cd CKBoost/dapp
pnpm qa
```

Open <http://localhost:9004/revamp> after startup completes. The existing
Profile/claim interface is at <http://localhost:9004/profile>.

`pnpm qa` checks the fixed ports **9004, 9005, 9994, 9090 and 9091** before local
preparation/build writes. It prepares repository-local dependencies with frozen
lockfiles, compiles their TypeScript sources, syncs TinyMCE, starts its own pinned
SSRI executor and compatibility bridge, builds with the validated QA runtime,
then starts the app and local functions. No contract deployment, wallet signing
or chain write is part of startup. It does not copy anyone's `.env.local` or keys.

Keep that terminal open. **Ctrl+C cleans up only the command's owned children.**
An occupied port or any existing `ckboost-ssri-qa` container causes a refusal;
the launcher does not stop or remove an existing service/container. Fix the
reported conflict yourself before retrying.

First startup installs dependencies and may download the pinned Docker image
and Netlify CLI before building. Every later startup also runs preparation and
build; no skipped-build/cache shortcut is promised. Local dependencies are
prepared with frozen lockfiles and install lifecycle hooks disabled. Rust and
Molecule generation are not needed for this already-deployed environment.

After preparation, `pnpm qa:plan` provides an offline check of the committed
public runtime. Verify these identities in its output:


| Identity | Expected value |
| --- | --- |
| Protocol | `0x4eacaf9b1a120d2bfd99f26fcedfdcfe6ef116484e9b478b0a104a872316e034` |
| Runtime profile | `0x129cd99c43113ab92b4ec5331693c402dd1f40b9269fff6c223ad4d3c201b297` |
| User Type | `0xecc4b989dc3bfc2f80e22226d14b4b04257e8f4bf3d8298f80619b798e12cb2c` |
| Executor | `http://127.0.0.1:9091/` |

### Advanced: manual multi-terminal startup

Use this alternative when you need separate logs or want to run each stage
yourself. Do not run it alongside `pnpm qa`; the same fixed ports and container
name are deliberately exclusive. From `CKBoost/dapp`, prepare once for this
manual run:

```sh
pnpm qa:prepare
pnpm qa:plan
```

In terminal A, start the pinned executor and the required compatibility bridge:

```sh
pnpm qa:ssri:plan
pnpm qa:ssri
```

Keep that process running. It starts the same Linux/amd64 executor image used
for acceptance, pinned by digest, on loopback port 9090. The host bridge on 9091
adapts the installed CCC transaction-context format to that executor. Only the
four read-only SSRI execution methods are allowed; there is no wallet or
transaction-broadcast API. The Docker image's baked Testnet settings are used;
no host credential or wallet directory is mounted.

In terminal B, from `CKBoost/dapp`:

```sh
pnpm qa:check
pnpm qa:build
pnpm qa:start
```

The app uses ports 9004, 9005 and 9994; SSRI uses 9090 and 9091. Occupied ports
cause an error rather than stopping another process. Netlify CLI **27.20.0** is
invoked through `pnpm dlx`, so its first start may download the pinned CLI. These
local commands do not publish a Netlify site. Keep both terminals open and stop
each owned foreground process with Ctrl+C when finished.

`qa:check` checks local prerequisites and executor reachability; it is not a new
live-chain acceptance result. The build and server use the same derived public
environment. Per-machine paths and build records stay in `.qa-local/`, and
Next output stays in `.next-isolated-129cd99c4311/`. Neither directory belongs
in Git. Do not replace `deployments.json`, copy another machine's generated
Netlify config, or enable the deployment workbench to join this environment.

The committed `config/qa/ckboost-testnet.json` contains public on-chain identities
and deployment provenance, including historical creation manifests. Its
`current` records select the upgraded QA code. Initialization data is not a
snapshot of today's roles or campaigns: the app loads current business state
from the chain. Do not hand-edit its ancestry or profile hash. A later QA code
upgrade requires a newly validated profile and a matching build.

Connecting a wallet does not grant a role. Use your own Testnet funds and ask the
QA platform administrator for an Organizer grant when needed. Reviewers must be
assigned to the specific campaign by its authorized owner or a platform admin.
The original four acceptance accounts' keys are not included or shared. Browser
drafts and templates are local; only confirmed chain/Nostr state is shared.

Normal `pnpm dev`/`pnpm build` continue to use the original default configuration.
Use `pnpm qa`, or the explicit advanced `qa:*` commands, for this shared QA
environment.

Run `pnpm qa:test` for the portable launcher, dependency preparation, SSRI bridge
and Docker lifecycle tests. These use temporary fixtures and mocked or ephemeral
local services; they do not deploy contracts or sign transactions. After pulling
source changes, run `pnpm qa` again to prepare, build and start with the matching
source. The advanced manual workflow requires those stages explicitly.
