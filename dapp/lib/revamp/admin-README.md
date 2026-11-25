# Admin redesign implementation

Design and engineering specifications: [Admin pages](https://www.figma.com/design/nxsPSskHMjrxLYW8AWTf5N/CKBoost-Redesign?node-id=1384-81497).

## Overview delivery

`/revamp/admin` is the new Overview. The top navigation and wallet menu expose
Admin console only for a wallet found in the current protocol Cell's
`admin_lock_hash_vec`. The route independently checks that identity; a menu
item is not authorization. Account, client and protocol changes hide previous
results, and delayed reads cannot restore a previous account's dashboard.

The page uses the existing current-cell business providers, shared query
client, HTTPS read client, semantic Light/Dark tokens and exact Figma artwork.
It does not mount the legacy full transaction-history/provider tree.

Current records, funding and period metrics have separate state and retries.
Weekly, Quarterly and Yearly mean rolling 7, 90 and 365 days, each compared
with the preceding equal interval. Coverage is shown on the page:

- New users require an exact full User type's creation transaction, canonical
  body hash, recomputed TypeID, resolved inputs, matching output lock and a
  confirmed block timestamp. The current User Cell's update time is never
  substituted for registration. Counts cover currently live profiles,
  deduplicated by wallet; deleted profiles are not reconstructed. The query
  has a 40-profile budget, bounded concurrency and a deadline; exceeding it
  shows unknown rather than a partial count.
- Campaigns created uses `created_at` from current canonical campaign records.
  Deleted campaigns are outside this snapshot. Current counts are not a
  complete historical ledger.
- Quest participants stays unknown until a complete history/index can prove
  unique participating wallets in the selected interval. Editable/deletable
  current submission records cannot provide that proof.
- Campaign funding matches each full campaign type hash in FundingLock args;
  shared tip funding matches the full protocol type hash. Untyped CKB
  capacity and configured UDT amounts are separate. Typed-cell storage
  capacity is not added to available CKB funding. Asset scripts, decimals and
  Uint128 values retain their exact identities and precision.
- Funding graphs require actual historical observations. Missing series
  displays an unavailable state, never the Figma sample curve or a fabricated
  flat balance history.
- Recorded activity uses actual record update, creation or grant timestamps.
  It does not turn campaign start dates into approval dates or copy proposal
  creation time into a missing payout time. Its coverage is explicitly a
  current-record view, not a complete administrative event ledger.

Need Action links open the existing campaign approval route or a specific tip
on the working tipping page. They do not sign automatically. A non-granted
tip remains reviewable even when listed in `tippings_approved`; an Admin who
already supported a tip is not told they can support it twice.

The remaining main tabs link to existing workflows during this iteration.
`/platform-admin?tab=campaigns|users|tips|rewards|achievements|protocol` selects
the corresponding legacy panel and preserves the other query values. The
wallet menu retains Protocol settings so advanced configuration stays
accessible. This does not claim that those legacy panels match the new design
or that their previously inactive buttons have been implemented.

The legacy platform statistics endpoint now returns its full scope and fails
instead of caching incomplete input/transaction/header reads. Its original
response fields, definitions and 24-hour cache remain compatible. Its legacy
`newUsers` measure is not used as the new Overview's registration metric.

## Remaining modules and actual capability gaps

| Module | Existing capability to retain | Work required by the finalized specification |
| --- | --- | --- |
| Campaigns | Current Admin approval and campaign schedule/approval state | New status/count table, default Under review, return/filter preservation and confirmation refresh. Suspension and approval reversal are explicitly outside this release. |
| Users | Protocol-signed Admin/Organizer access changes and Telegram data | New search, coexisting verification tags and ordering. Admin-initiated manual verification of another user's profile needs a real attestation/delegation design; the old button only logs, and an Admin input cannot unlock that user's wallet Cell. |
| Tipping | Proposal creation, existing approval/endorsement, shared funding and shortfall calculation | New standalone details/history, settings and deposit views. The current contract rejects UDT payout and skips expiry enforcement. A dedicated Tip approver registry has no current schema field; it must not silently revoke Organizer access. |
| Rewards & Recognition | Developer-managed achievement definitions, receiver records and activity bonus settings | Protocol-scoped claim eligibility/attestation, confirmed claim transaction provenance and real reward-period persistence. The old reward-period create handler is a form/log stub, not a persistence or publishing implementation. |
| Personal profile follow-up | Wallet-scoped profile, campaign/Points history and claimed-badge reads | Recorded join/create/approval/mint events need verified history. Safe eligible-badge claims remain disabled until the eligibility service is correctly scoped and configured. |

UI source changes cannot establish these missing chain capabilities. Future
permission or schema changes need a separately reviewed contract migration:
preserve existing Cell identities and data where compatible, version the data
when layouts change, and test both old and new records on the isolated QA
protocol before requesting a wallet upgrade signature. No contract deployment,
role change, live-site publication or wallet transaction is performed by
building or opening this Overview.

## Verification

Focused tests exercise access/scope changes, late reads, canonical registration
proof, BigInt funding, pending-tip coverage, unknown history, period selection,
navigation and error/retry behavior. Visual fixtures use actual components
with clearly marked supplied data in a fresh isolated browser; they do not
connect to a user's wallet. The normal build still has its existing
`ignoreBuildErrors` setting, so build success is reported separately from the
project's pre-existing TypeScript diagnostics.
