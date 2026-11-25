import { ccc } from "@ckb-ccc/connector-react";
import { CampaignData, ConnectedTypeID, ProtocolData, UserData } from "ssri-ckboost/types";
import { getLatestDisplayName } from "@/lib/profile/profile-data";
import { extractIdentityDisplayName } from "@/lib/utils/identity";
import { verifyCampaignOwnership } from "./campaign-permissions";
import { discoveryCampaignId, readDiscoveryCampaignBatch, readDiscoveryCampaignExact } from "./discovery-cells";
import { coalesceDiscoveryRead, discoveryAbortError, DiscoveryTimeoutError, loadDiscoveryCampaigns, runDiscoveryRequest } from "./discovery-loader";

export interface ProfileResource<T> { data: T | null; loading: boolean; error: string | null }
export interface ProfileCampaignRow { id: string; title: string; questsSubmitted: number | null; pointsEarned: bigint | null }
export interface ProfileActivityRow { id: string; campaignId: string; campaignTitle: string; questId: number; questTitle?: string; submittedAt: number | null; status: "pending" | "approved" }
export interface ProfileRewardRow { id: string; campaignId: string | null; campaignTitle: string; amount: bigint; assetLabel?: string; transactionHash: string | null; explorerUrl: string | null; occurredAt: number | null }
export interface ProfileIdentity {
  address: string; lockHash: string; userTypeId: string | null; displayName: string | null;
  lastActiveAt: number | null; verifiedTelegram: boolean;
  userCell: ccc.Cell | null; user: ReturnType<typeof UserData.decode> | null;
}
export interface ProfileCampaignData {
  participated: ProfileCampaignRow[]; created: ProfileCampaignRow[]; activities: ProfileActivityRow[];
  reviewerAssigned: boolean;
  /** Current accepted quest awards, including Points not yet claimed. Not wallet balance or lifetime history. */
  approvedPoints: bigint;
}
export interface ProfileReadScope {
  client: ccc.Client; protocolCell: ccc.Cell; protocol: ReturnType<typeof ProtocolData.decode>;
  protocolHash: ccc.Hex; walletLock: ccc.Script; lockHash: ccc.Hex; address: string; network: "mainnet" | "testnet";
}
export const PROFILE_PAGE_SIZE = 100;
export const PROFILE_MAX_PAGES = 20;
export const PROFILE_MAX_CAMPAIGNS = 300;
const hashPattern = /^0x[0-9a-f]{64}$/i;
const hash = (value: unknown): ccc.Hex => {
  const result = typeof value === "string" ? value : ccc.hexFrom(value as ccc.BytesLike);
  if (!hashPattern.test(result)) throw new Error("A profile chain identity is invalid.");
  return result.toLowerCase() as ccc.Hex;
};
const point = (cell: ccc.Cell) => `${cell.outPoint.txHash}:${cell.outPoint.index}`;
export function profileTimestamp(value: unknown): number | null {
  try {
    const n = Number(value);
    const milliseconds = n > 1_000_000_000_000 ? n : n * 1000;
    return Number.isSafeInteger(milliseconds) && milliseconds > 0 && milliseconds <= 8_640_000_000_000_000 ? milliseconds : null;
  } catch { return null; }
}
export function profileRoleLabel(scope: ProfileReadScope, reviewerAssigned = false): string {
  if (scope.protocol.protocol_config.admin_lock_hash_vec.some(value => hash(value) === scope.lockHash)) return "Admin";
  if (scope.protocol.endorsers_whitelist.some(value => hash(value.endorser_lock_hash) === scope.lockHash)) return "Organizer";
  // A positive assignment is evidence. We never invent a global reviewer grant.
  return reviewerAssigned ? "Reviewer" : "Member";
}
export function makeProfileReadScope(client: ccc.Client, protocolCell: ccc.Cell, address: ccc.Address, network: "mainnet" | "testnet"): ProfileReadScope {
  const protocolHash = protocolCell.cellOutput.type?.hash();
  if (!protocolHash) throw new Error("The current protocol has no type identity.");
  return { client, protocolCell, protocol: ProtocolData.decode(protocolCell.outputData), protocolHash,
    walletLock: address.script, lockHash: address.script.hash(), address: address.toString(), network };
}
function request<T>(scope: ProfileReadScope, key: string, read: () => Promise<T>, signal?: AbortSignal) {
  return runDiscoveryRequest(scope.client, () => coalesceDiscoveryRead(scope.client, `profile:${key}`, read), { signal });
}
/** Bounded, terminal pagination: never report a partial wallet balance/count as complete. */
export async function readProfilePages(scope: ProfileReadScope, search: Parameters<ccc.Client["findCellsPaged"]>[0], key: string, signal?: AbortSignal): Promise<ccc.Cell[]> {
  const rows: ccc.Cell[] = [], seen = new Set<string>();
  let after: string | undefined;
  for (let page = 0; page < PROFILE_MAX_PAGES; page++) {
    const cursor = after;
    const result = await request(scope, `${key}:${cursor ?? "first"}`, () => scope.client.findCellsPaged(search, "asc", PROFILE_PAGE_SIZE, cursor), signal);
    if (signal?.aborted) throw discoveryAbortError();
    for (const cell of result.cells) {
      const id = point(cell);
      if (seen.has(id)) throw new Error("The indexer repeated a profile cell. Retry the query.");
      seen.add(id); rows.push(cell);
    }
    if (result.cells.length < PROFILE_PAGE_SIZE) return rows;
    if (!result.lastCursor || result.lastCursor === after) throw new Error("The indexer did not finish the profile query. Retry the query.");
    after = result.lastCursor;
  }
  throw new Error("This profile exceeds the current query limit. Counts and balances are unavailable.");
}
function connected(cell: ccc.Cell, code: ccc.Hex, protocolHash: ccc.Hex): {type_id: ccc.Hex} | null {
  const type = cell.cellOutput.type;
  if (!type || type.hashType !== "type" || type.codeHash.toLowerCase() !== code.toLowerCase()) return null;
  const value = ConnectedTypeID.decode(type.args);
  if (hash(value.connected_key) !== protocolHash.toLowerCase()) return null;
  if (ccc.hexFrom(ConnectedTypeID.encode(value)).toLowerCase() !== type.args.toLowerCase()) throw new Error("Noncanonical profile type identity.");
  return { type_id: hash(value.type_id) };
}
export async function readProfileIdentity(scope: ProfileReadScope, signal?: AbortSignal): Promise<ProfileIdentity> {
  const code = hash(scope.protocol.protocol_config.script_code_hashes.ckb_boost_user_type_code_hash);
  const cells = (await readProfilePages(scope, {
    script: scope.walletLock, scriptType: "lock", scriptSearchMode: "exact", withData: true,
    filter: { script: { codeHash: code, hashType: "type", args: "0x" } },
  }, `user:${scope.protocolHash}:${code}:${scope.lockHash}`, signal)).filter(cell => cell.cellOutput.lock.eq(scope.walletLock) && connected(cell, code, scope.protocolHash));
  let userCell: ccc.Cell | null = cells[0] ?? null;
  if (cells.length > 1) {
    const ranked = await Promise.all(cells.map(async cell => {
      const transaction = await request(scope, `transaction:${cell.outPoint.txHash}`, () => scope.client.getTransaction(cell.outPoint.txHash), signal);
      if (transaction?.blockNumber == null) throw new Error("A current user profile could not be placed in a block. Retry before selecting it.");
      return { cell, block: BigInt(transaction.blockNumber) };
    }));
    ranked.sort((a, b) => a.block === b.block ? 0 : a.block > b.block ? -1 : 1);
    if (ranked[0].block === ranked[1].block) throw new Error("Multiple user profiles were found in the latest block. The current profile is ambiguous.");
    userCell = ranked[0].cell;
  }
  const user = userCell ? UserData.decode(userCell.outputData) : null;
  return { address: scope.address, lockHash: scope.lockHash, userCell, user,
    userTypeId: userCell ? connected(userCell, code, scope.protocolHash)!.type_id : null,
    displayName: user ? getLatestDisplayName(user.profile_data) ?? extractIdentityDisplayName(user.verification_data.identity_verification_data) : null,
    lastActiveAt: user ? profileTimestamp(user.last_activity_timestamp) : null,
    verifiedTelegram: Boolean(user && BigInt(user.verification_data.telegram_personal_chat_id) > 0n) };
}
export function profilePointsType(scope: ProfileReadScope): ccc.Script {
  return ccc.Script.from({ codeHash: hash(scope.protocol.protocol_config.script_code_hashes.ckb_boost_points_udt_type_code_hash), hashType: "type", args: scope.protocolHash });
}
export async function readProfilePoints(scope: ProfileReadScope, signal?: AbortSignal): Promise<bigint> {
  const type = profilePointsType(scope);
  const cells = await readProfilePages(scope, { script: scope.walletLock, scriptType: "lock", scriptSearchMode: "exact", withData: true, filter: { script: type } }, `points:${scope.protocolHash}:${type.hash()}:${scope.lockHash}`, signal);
  return cells.reduce((total, cell) => {
    if (!cell.cellOutput.lock.eq(scope.walletLock) || !cell.cellOutput.type?.eq(type)) return total;
    const bytes = ccc.bytesFrom(cell.outputData);
    if (bytes.length < 16) throw new Error("A matching Points cell has invalid balance data.");
    return total + ccc.numLeFromBytes(bytes.slice(0, 16));
  }, 0n);
}
export function buildProfileCampaignData(scope: ProfileReadScope, identity: ProfileIdentity, cells: readonly ccc.Cell[]): ProfileCampaignData {
  const code = hash(scope.protocol.protocol_config.script_code_hashes.ckb_boost_campaign_type_code_hash);
  const submissions = new Map<string, {campaign: string; quest: number; timestamp: number | null}>();
  for (const record of identity.user?.submission_records ?? []) {
    const campaign = hash(record.campaign_type_id), quest = Number(record.quest_id);
    if (!Number.isSafeInteger(quest) || quest < 0) throw new Error("A submission has an invalid quest identity.");
    const key = `${campaign}:${quest}`, timestamp = profileTimestamp(record.submission_timestamp), old = submissions.get(key);
    if (!old || (timestamp ?? 0) >= (old.timestamp ?? 0)) submissions.set(key, {campaign, quest, timestamp});
  }
  const participated: ProfileCampaignRow[] = [], created: ProfileCampaignRow[] = [], activities: ProfileActivityRow[] = [];
  let reviewerAssigned = false, approvedPoints = 0n;
  const seen = new Set<string>();
  for (const cell of cells) {
    const id = discoveryCampaignId(cell, {protocolTypeHash: scope.protocolHash, campaignCodeHash: code});
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const data = CampaignData.decode(cell.outputData);
    const title = data.metadata.title || "Untitled campaign";
    reviewerAssigned ||= data.staff_lock_hash_vec.some(value => hash(value) === scope.lockHash);
    const ownership = verifyCampaignOwnership({campaignTypeId: id, protocolTypeHash: scope.protocolHash, campaignTypeCodeHash: code,
      protocolLockCodeHash: hash(scope.protocol.protocol_config.script_code_hashes.ckb_boost_protocol_lock_code_hash),
      protocolLockHashType: scope.protocolCell.cellOutput.lock.hashType, cell});
    const own = ownership?.ownerLockHash === scope.lockHash;
    let submitted = 0, earned = 0n, acceptedAny = false;
    for (const quest of data.quests) {
      const questId = Number(quest.quest_id), record = submissions.get(`${id}:${questId}`);
      const accepted = Boolean(identity.userTypeId && quest.accepted_submission_user_type_ids.some(value => hash(value) === identity.userTypeId));
      if (record) {
        submitted++;
        activities.push({id: `${id}:${questId}`, campaignId: id, campaignTitle: title, questId, questTitle: quest.metadata.title,
          submittedAt: record.timestamp, status: accepted ? "approved" : "pending"});
      }
      if (accepted) { acceptedAny = true; earned += BigInt(quest.points); }
    }
    // These are current accepted quest awards, not a reconstructed historical ledger.
    const row = {id, title, questsSubmitted: submitted, pointsEarned: earned};
    if (own) created.push(row);
    if (submitted > 0 || acceptedAny) { participated.push(row); approvedPoints += earned; }
  }
  // An unavailable/deleted quest must remain visible as a real submitted record,
  // without inventing approval or reward information from a stale title cache.
  for (const record of submissions.values()) if (!activities.some(row => row.id === `${record.campaign}:${record.quest}`))
    throw new Error("A submitted quest is unavailable. Its current approval and campaign totals cannot be determined.");
  activities.sort((a, b) => (b.submittedAt ?? 0) - (a.submittedAt ?? 0));
  return {participated, created, activities, reviewerAssigned, approvedPoints};
}
export async function withProfileDeadline<T>(read: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, milliseconds = 20_000): Promise<T> {
  if (signal?.aborted) throw discoveryAbortError();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, {once: true});
  if (signal?.aborted) controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => {timedOut = true; controller.abort();}, milliseconds);
  try {
    return await Promise.race([read(controller.signal), new Promise<never>((_, reject) => {
      const fail = () => { const error = timedOut ? new DiscoveryTimeoutError() : discoveryAbortError(); if (timedOut) error.message = "The profile request timed out. Please retry this section."; reject(error); };
      if (controller.signal.aborted) fail();
      else controller.signal.addEventListener("abort", fail, {once: true});
    })]);
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
}
export async function readProfileCampaigns(scope: ProfileReadScope, identity: ProfileIdentity, signal?: AbortSignal): Promise<ProfileCampaignData> {
  const code = hash(scope.protocol.protocol_config.script_code_hashes.ckb_boost_campaign_type_code_hash);
  const ownerLock = ccc.Script.from({codeHash: hash(scope.protocol.protocol_config.script_code_hashes.ckb_boost_protocol_lock_code_hash),
    hashType: scope.protocolCell.cellOutput.lock.hashType, args: ccc.hexFrom(ConnectedTypeID.encode({type_id: scope.lockHash, connected_key: scope.protocolHash}))});
  const ownPromise = readProfilePages(scope, {script: ownerLock, scriptType: "lock", scriptSearchMode: "exact", withData: true,
    filter: {script: {codeHash: code, hashType: "type", args: "0x"}}}, `owned:${scope.protocolHash}:${code}:${scope.lockHash}`, signal);
  const ids = [...new Set([...scope.protocol.campaigns_approved.map(hash), ...(identity.user?.submission_records ?? []).map(record => hash(record.campaign_type_id))])];
  if (ids.length > PROFILE_MAX_CAMPAIGNS) throw new Error("This profile needs more campaigns than the current query limit. Campaign totals are unavailable.");
  const campaignScope = {protocolTypeHash: scope.protocolHash, campaignCodeHash: code};
  const recordsPromise = loadDiscoveryCampaigns<ccc.Cell>({ids, signal,
    fetchBatch: (requested, onRecord) => readDiscoveryCampaignBatch({client: scope.client, scope: campaignScope, ids: requested, signal, onRecord}),
    fetchCampaign: async id => { const cell = await readDiscoveryCampaignExact(scope.client, campaignScope, id, signal); if (!cell) throw new Error("A campaign referenced by this profile is unavailable. Retry before using totals."); return cell; }});
  const [own, records] = await Promise.all([ownPromise, recordsPromise]);
  if (Object.keys(records.errors).length) throw new Error("Some campaigns could not be loaded. Participation and earned totals are unavailable; retry the campaign query.");
  return buildProfileCampaignData(scope, identity, [...own, ...records.records.map(record => record.cell)]);
}
/** Netlify returns positive wallet deltas, not proof of which quest earned them.
 * Keep provenance unknown instead of matching transactions to submissions by time. */
export async function readProfileRewards(scope: ProfileReadScope, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<ProfileRewardRow[]> {
  const controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener("abort", abort, {once: true});
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, 12_000);
  try {
    const response = await fetcher(`/.netlify/functions/reward-history?${new URLSearchParams({address: scope.address, limit: "20"})}`, {signal: controller.signal});
    if (!response.ok) throw new Error("Points transaction history could not be loaded. Retry Rewards.");
    const payload = await response.json();
    const type = profilePointsType(scope);
    if (payload.address !== scope.address || hash(payload.protocolTypeHash) !== scope.protocolHash || !ccc.Script.from(payload.pointsTypeScript).eq(type) || !Array.isArray(payload.transactions)) throw new Error("The reward history does not match this wallet and protocol.");
    if (payload.transactions.length > 20) throw new Error("The reward history exceeded the requested limit.");
    const records: Array<{height: string | null;row: ProfileRewardRow}> = payload.transactions.map((tx: {txHash: string; netPoints: string; blockNumber?: string | null}) => {
      const txHash = hash(tx.txHash);
      if (typeof tx.netPoints !== "string" || !/^\d+$/.test(tx.netPoints) || BigInt(tx.netPoints) <= 0n) throw new Error("The reward history contains an invalid Points amount.");
      if (tx.blockNumber != null && (typeof tx.blockNumber !== "string" || !/^(?:0x[0-9a-f]+|\d+)$/i.test(tx.blockNumber))) throw new Error("The reward history contains an invalid block number.");
      return {height: tx.blockNumber == null ? null : BigInt(tx.blockNumber).toString(), row: {
        id: txHash, campaignId: null, campaignTitle: "Points received", amount: BigInt(tx.netPoints), assetLabel: "Points", transactionHash: txHash,
        explorerUrl: `https://${scope.network === "testnet" ? "testnet." : ""}explorer.nervos.org/transaction/${txHash}`, occurredAt: null,
      } satisfies ProfileRewardRow};
    });
    const heights = [...new Set(records.map(record => record.height).filter((height): height is string => height !== null))];
    const timestamps = new Map<string, number | null>();
    await Promise.all(heights.map(async height => {
      try {
        // CCC headers expose timestamp in milliseconds. Do not infer dates from
        // submission times or assume the first transaction's date for a batch.
        // Coalesce before entering the queue, including jobs not yet started.
        // Observers can cancel independently; the shared transport keeps its
        // global pool slot until it settles, bounded to four physical reads.
        const header = await withProfileDeadline(() => coalesceDiscoveryRead(scope.client, `profile-header:${height}`,
          () => runDiscoveryRequest(scope.client, () => scope.client.getHeaderByNumber(BigInt(height)))), controller.signal, 12_000);
        if (!header || ccc.numFrom(header.number) !== BigInt(height)) return;
        const timestamp = Number(ccc.numFrom(header.timestamp));
        if (Number.isSafeInteger(timestamp) && timestamp > 0 && timestamp <= 8_640_000_000_000_000) timestamps.set(height, timestamp);
      } catch { /* An unavailable header leaves only this transaction's date unknown. */ }
    }));
    if (signal?.aborted) throw discoveryAbortError();
    return records.map(({height, row}) => ({...row, occurredAt: height === null ? null : timestamps.get(height) ?? null}));
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}
