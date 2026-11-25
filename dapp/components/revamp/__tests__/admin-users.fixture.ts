import type {AdminUsersState} from "../admin-users";
import type {AdminUserRecord, AdminAccessPlan} from "@/lib/revamp/admin-users-model";
const h = (letter: string) => `0x${letter.repeat(64)}` as `0x${string}`;
const resource = <T,>(data: T | null) => ({data, loading: false, error: null});
/** Synthetic presentation data only. No wallet, RPC, signer or service is used. */
export function adminUsersPresentationFixture(): AdminUsersState {
  const at = Date.parse("2026-11-18T01:18:00Z");
  const rows = [
    {displayName: "Fiber Builder", role: "platform-admin", telegram: true, manual: false, recordedPoints: 1240n},
    {displayName: "Cell Explorer", role: "member", telegram: false, manual: false, recordedPoints: 330n},
    {displayName: "Script Lab", role: "organizer", telegram: true, manual: false, recordedPoints: 800n},
    {displayName: "Route Tester", role: "member", telegram: true, manual: true, recordedPoints: 95n},
  ].map((value, i) => ({...value, id: h(String(i + 1)), typeHash: h(String(i + 5)), lockHash: h(String(i + 5)), address: `ckt1qrfrwcdnvssswdwpn3s9v8fp87emat306ctjwsm3nmlkjg8qyza2cqgqq9zuyhnp0wmjejcpznmn7srdduvxa5r4xgr7wmxq${i}`, lastActiveAt: at - i * 1000, campaignsParticipated: 3, questsSubmitted: 6, cell: {}, user: {}} as AdminUserRecord));
  const campaigns = {participated: [{id: h("a"), title: "Build on CKB: Campaign #7", questsSubmitted: 2, pointsEarned: 250n}, {id: h("b"), title: "Build your first CKB script", questsSubmitted: 3, pointsEarned: 400n}, {id: h("c"), title: "CKB Wallet Walkthrough", questsSubmitted: 1, pointsEarned: 100n}], created: [{id: h("b"), title: "Build your first CKB script", questsSubmitted: 3, pointsEarned: 400n}], activities: [{id: "one", campaignId: h("a"), campaignTitle: "Build on CKB: Campaign #7", questId: 1, questTitle: "Build a transaction", submittedAt: at, status: "approved" as const}, {id: "two", campaignId: h("b"), campaignTitle: "Build your first CKB script", questId: 2, questTitle: "Review the Cell Model", submittedAt: at - 1000, status: "pending" as const}], reviewerAssigned: false, approvedPoints: 750n};
  return {access: "allowed", error: null, viewerLockHash: rows[0].lockHash, protocolTypeHash: h("f"), users: resource(rows), visible: rows, filteredCount: rows.length, page: 0, pageSize: 20, search: "", role: "all", verification: "all", onSearch: () => {}, onRole: () => {}, onVerification: () => {}, onPage: () => {},
    joined: resource(Object.fromEntries(rows.map((row, i) => [row.id, {at: i === 0 ? null : at - 86400000, error: i === 0 ? "Creation time unavailable" : null}]))), target: rows[0], campaigns: resource(campaigns), points: resource(1240n), badges: resource({badges: [{id: "tg", title: "Telegram Verification", description: null, image: {kind: "none" as const}, classification: "telegram-verification" as const, metadataNeventId: "nevent-fixture", claimed: true, claimedAt: at, claimable: null}, {id: "first", title: "First Submission", description: null, image: {kind: "none" as const}, classification: "first-submission" as const, metadataNeventId: "nevent-fixture", claimed: true, claimedAt: at, claimable: null}], eligibilityUnavailableReason: null}), rewards: resource([{id: "reward", campaignId: null, campaignTitle: "Positive Points change", amount: 100n, transactionHash: h("d"), explorerUrl: `https://pudge.explorer.nervos.org/transaction/${h("d")}`, occurredAt: at}]),
    manualAvailable: false, manualLoading: false, manualUnavailableReason: "Manual verification awaits the final scoped Admin registry deployment.", operation: null,
    previewAccess: async (wallet, role) => ({protocolTypeHash: h("f"), protocolOutPoint: `${h("e")}:0`, protocolDataHash: h("d"), walletAddress: wallet, walletLockHash: rows[0].lockHash, role, changes: ["Revoke Platform admin access", "Revoke Organizer access"], updated: {}} as AdminAccessPlan),
    changeAccess: async () => {}, verifyIdentity: async () => {}, onConnect: () => {}, onRetry: () => {}, onRetryDates: () => {}, onRetryCampaigns: () => {}, onRetryPoints: () => {}, onRetryBadges: () => {}, onRetryRewards: () => {}, onTabChange: () => {},
  };
}
