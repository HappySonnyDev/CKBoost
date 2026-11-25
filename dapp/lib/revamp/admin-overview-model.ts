import { ccc } from "@ckb-ccc/connector-react";
import { CampaignData, ConnectedTypeID, TippingData, UserData } from "ssri-ckboost/types";
import { coalesceDiscoveryRead, discoveryAbortError, runDiscoveryRequest } from "./discovery-loader";
import { profileTimestamp, readProfilePages, withProfileDeadline, type ProfileReadScope } from "./profile-model";

export type AdminPeriod = "weekly" | "quarterly" | "yearly";
export interface AdminResource<T> {data: T | null;loading: boolean;error: string | null}
export interface AdminMetric {value: number | bigint | null;deltaPercent: number | null;unavailableReason?: string;retryable?: boolean}
export interface AdminOverviewMetrics {newUsers: AdminMetric;campaignsCreated: AdminMetric;questParticipants: AdminMetric;coverageNote: string}
export interface AdminActionItem {id: string;type: "campaign" | "tipping";title: string;description: string;at: number | null;actionLabel: "Approve" | "Review" | "Endorse";href?: string}
export interface AdminActivityItem {id: string;kind: "campaign" | "tipping" | "user" | "achievement" | "reward";title: string;description: string;at: number | null;href?: string}
export interface AdminFundingAsset {id: string;symbol: string;decimals: number | null;campaignAmount: bigint | null;tippingAmount: bigint | null}
export interface AdminHistoryPoint {at: number;value: bigint}
export interface AdminOverviewFunding {campaignCkbShannons: bigint | null;tippingCkbShannons: bigint | null;assets: AdminFundingAsset[];campaignHistory: AdminHistoryPoint[] | null;tippingHistory: AdminHistoryPoint[] | null;historyUnavailableReason: string}
export interface AdminCampaignRecord {id: ccc.Hex;cell: ccc.Cell;data: ReturnType<typeof CampaignData.decode>}
export interface AdminTippingRecord {id: ccc.Hex;cell: ccc.Cell;data: ReturnType<typeof TippingData.decode>}
export interface AdminCurrentSnapshot {protocolTypeHash: ccc.Hex;campaigns: AdminCampaignRecord[];tippings: AdminTippingRecord[]}
export const ADMIN_BIRTH_MAX_PROFILES = 40;
export const ADMIN_PERIOD_DAYS = {weekly: 7, quarterly: 90, yearly: 365} as const;
const hash = (value: ccc.BytesLike): ccc.Hex => {
  const result = ccc.hexFrom(value).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(result)) throw new Error("An Admin overview identity is invalid.");
  return result as ccc.Hex;
};
export function isOverviewAdmin(scope: ProfileReadScope): boolean {
  return scope.protocolCell.cellOutput.type?.hash().toLowerCase() === scope.protocolHash.toLowerCase() &&
    scope.walletLock.hash().toLowerCase() === scope.lockHash.toLowerCase() &&
    scope.protocol.protocol_config.admin_lock_hash_vec.some(value => hash(value) === scope.lockHash.toLowerCase());
}
function assertAdmin(scope: ProfileReadScope) {if (!isOverviewAdmin(scope)) throw new Error("Only a current platform Admin can open this overview.");}
function assertSnapshot(scope: ProfileReadScope, snapshot: AdminCurrentSnapshot) {
  assertAdmin(scope); if (snapshot.protocolTypeHash !== scope.protocolHash) throw new Error("The overview snapshot belongs to another protocol.");
  const codes = scope.protocol.protocol_config.script_code_hashes;
  if (snapshot.campaigns.some(record => scopedId(record.cell, hash(codes.ckb_boost_campaign_type_code_hash), scope) !== record.id) ||
    snapshot.tippings.some(record => scopedId(record.cell, hash(codes.ckb_boost_tipping_type_code_hash), scope) !== record.id)) throw new Error("An overview record does not match its complete protocol identity.");
}
function request<T>(scope: ProfileReadScope, key: string, read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return withProfileDeadline(() => coalesceDiscoveryRead(scope.client, `admin-overview:${key}`, () => runDiscoveryRequest(scope.client, read)), signal, 12_000);
}
/** A shared code hash is insufficient: require canonical full ConnectedTypeID
 * and the exact current protocol before decoding business data. */
function scopedId(cell: ccc.Cell, code: ccc.Hex, scope: ProfileReadScope): ccc.Hex | null {
  const type = cell.cellOutput.type;
  if (!type || type.hashType !== "type" || type.codeHash.toLowerCase() !== code) return null;
  try {
    const connected = ConnectedTypeID.decode(type.args);
    if (hash(connected.connected_key) !== scope.protocolHash || ccc.hexFrom(ConnectedTypeID.encode(connected)).toLowerCase() !== type.args.toLowerCase()) return null;
    return hash(connected.type_id);
  } catch {return null;}
}
async function typedCells(scope: ProfileReadScope, code: ccc.Hex, signal?: AbortSignal): Promise<ccc.Cell[]> {
  assertAdmin(scope);
  return (await readProfilePages(scope, {script: {codeHash: code, hashType: "type", args: "0x"}, scriptType: "type", scriptSearchMode: "prefix", withData: true}, `admin:${scope.protocolHash}:${code}`, signal)).filter(cell => scopedId(cell, code, scope));
}
export async function readAdminCurrentSnapshot(scope: ProfileReadScope, signal?: AbortSignal): Promise<AdminCurrentSnapshot> {
  assertAdmin(scope);
  const codes = scope.protocol.protocol_config.script_code_hashes;
  const [campaignCells, tippingCells] = await Promise.all([
    typedCells(scope, hash(codes.ckb_boost_campaign_type_code_hash), signal), typedCells(scope, hash(codes.ckb_boost_tipping_type_code_hash), signal),
  ]);
  const campaigns = campaignCells.map(cell => ({id: scopedId(cell, hash(codes.ckb_boost_campaign_type_code_hash), scope)!, cell, data: CampaignData.decode(cell.outputData)}));
  const tippings = tippingCells.map(cell => ({id: scopedId(cell, hash(codes.ckb_boost_tipping_type_code_hash), scope)!, cell, data: TippingData.decode(cell.outputData)}));
  if (new Set(campaigns.map(record => record.id)).size !== campaigns.length || new Set(tippings.map(record => record.id)).size !== tippings.length) throw new Error("Multiple current cells identify the same overview record. Retry before using totals.");
  return {protocolTypeHash: scope.protocolHash, campaigns, tippings};
}
export function adminNeedActions(scope: ProfileReadScope, snapshot: AdminCurrentSnapshot): AdminActionItem[] {
  assertSnapshot(scope, snapshot);
  const approvedCampaigns = new Set(scope.protocol.campaigns_approved.map(hash));
  return [
    ...snapshot.campaigns.filter(record => !approvedCampaigns.has(record.id)).map(record => ({id: record.id, type: "campaign" as const, title: record.data.metadata.title || "Untitled campaign", description: "Not in the current platform approval list. Review the campaign before approving.", at: profileTimestamp(record.data.created_at), actionLabel: "Review" as const, href: `/revamp/admin/campaigns/${record.id}`})),
    // Platform inclusion is not equivalent to distribution: approved proposals
    // may still need endorsements. Review is a navigation action, never a claim
    // that this Admin can endorse again or that expiry/funding checks passed.
    ...snapshot.tippings.filter(record => record.data.status !== "granted").map(record => ({id: record.id, type: "tipping" as const, title: record.data.metadata.contribution_title || "Untitled tip proposal",
      description: `Recorded status: ${record.data.status}. ${record.data.supporter_lock_hashes.length} supporter record(s). ${record.data.supporter_lock_hashes.some(value => hash(value) === scope.lockHash) ? "This Admin has already supported it." : "This Admin is not recorded as a supporter."} Check its current endorsements, expiry and funding in the review page.`,
      at: profileTimestamp(record.data.metadata.creation_timestamp), actionLabel: "Review" as const, href: `/revamp/admin/tipping/${record.id}`})),
  ].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}
export function adminRecordedActivity(scope: ProfileReadScope, snapshot: AdminCurrentSnapshot): AdminActivityItem[] {
  assertSnapshot(scope, snapshot);
  // These are current record timestamps, explicitly not reconstructed approvals
  // or a complete ledger of historical transactions.
  return [
    ...snapshot.campaigns.map(record => ({id: `campaign:${record.id}`, kind: "campaign" as const, title: record.data.metadata.title || "Untitled campaign", description: "Campaign record · recorded last update", at: profileTimestamp(record.data.metadata.last_updated), href: `/revamp/campaign/${record.id}`})),
    ...snapshot.tippings.map(record => ({id: `tipping:${record.id}`, kind: "tipping" as const, title: record.data.metadata.contribution_title || "Untitled tip proposal", description: record.data.status === "granted" ? "Tip record · recorded grant" : "Tip proposal record · recorded creation", at: profileTimestamp(record.data.status === "granted" ? record.data.granted_at : record.data.metadata.creation_timestamp), href: `/revamp/admin/tipping/${record.id}`})),
  ].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, 20);
}
export async function readAdminFunding(scope: ProfileReadScope, snapshot: AdminCurrentSnapshot, signal?: AbortSignal): Promise<AdminOverviewFunding> {
  assertSnapshot(scope, snapshot);
  const codes = scope.protocol.protocol_config.script_code_hashes, fundingCode = hash(codes.ckb_boost_funding_lock_code_hash);
  const campaignHashes = new Set(snapshot.campaigns.map(record => record.cell.cellOutput.type!.hash().toLowerCase()));
  const accepted = new Set(scope.protocol.protocol_config.script_code_hashes.accepted_udt_type_scripts.map(script => ccc.Script.from(script).hash().toLowerCase()));
  const pointsType = ccc.Script.from({codeHash: hash(codes.ckb_boost_points_udt_type_code_hash), hashType: "type", args: scope.protocolHash});
  accepted.add(pointsType.hash().toLowerCase());
  const cells = await readProfilePages(scope, {script: {codeHash: fundingCode, hashType: "type", args: "0x"}, scriptType: "lock", scriptSearchMode: "prefix", withData: true}, `admin-funding:${scope.protocolHash}:${fundingCode}`, signal);
  let campaignCkbShannons = 0n, tippingCkbShannons = 0n;
  const assets = new Map<string, AdminFundingAsset>();
  const {udtRegistry} = await import("@/lib/services/udt-registry");
  for (const cell of cells) {
    const lock = cell.cellOutput.lock;
    if (lock.codeHash.toLowerCase() !== fundingCode || lock.hashType !== "type") continue;
    const campaign = campaignHashes.has(lock.args.toLowerCase()), tipping = lock.args.toLowerCase() === scope.protocolHash;
    if (!campaign && !tipping) continue;
    const type = cell.cellOutput.type;
    if (!type) {if (campaign) campaignCkbShannons += cell.cellOutput.capacity; else tippingCkbShannons += cell.cellOutput.capacity; continue;}
    const id = type.hash().toLowerCase(), isPoints = type.eq(pointsType), token = udtRegistry.getTokenByScriptHash(id);
    const trustedToken = token?.network === scope.network ? token : undefined;
    const knownAmount = accepted.has(id), bytes = ccc.bytesFrom(cell.outputData);
    if (knownAmount && bytes.length < 16) throw new Error("A configured funding asset has invalid amount data. Funding totals are unavailable.");
    const previous = assets.get(id) ?? {id, symbol: isPoints ? "Points" : trustedToken?.symbol ?? `Asset ${id.slice(0, 10)}…`, decimals: isPoints ? 0 : trustedToken?.decimals ?? null, campaignAmount: knownAmount ? 0n : null, tippingAmount: knownAmount ? 0n : null};
    if (knownAmount) {
      const amount = ccc.numLeFromBytes(bytes.slice(0, 16));
      if (campaign) previous.campaignAmount = previous.campaignAmount! + amount; else previous.tippingAmount = previous.tippingAmount! + amount;
    }
    assets.set(id, previous);
  }
  return {campaignCkbShannons, tippingCkbShannons, assets: [...assets.values()], campaignHistory: null, tippingHistory: null,
    historyUnavailableReason: "Current untyped CKB capacity and configured UDT balances only. Historical balance series are unavailable; typed-cell storage capacity is not spendable CKB funding."};
}
function metric(timestamps: readonly number[], now: number, days: number): AdminMetric {
  const width = days * 86400000, start = now - width, previousStart = start - width;
  const value = timestamps.filter(time => time >= start && time <= now).length;
  const previous = timestamps.filter(time => time >= previousStart && time < start).length;
  return {value, deltaPercent: previous > 0 ? (value - previous) * 100 / previous : null};
}
/** Prove a live User type's birth, not its latest update block. Every parent is
 * loaded from its canonical transaction; the full type must be absent in inputs.
 * TypeID recomputation additionally prevents an indexer update from masquerading
 * as creation even when its claimed ascending history is incomplete. */
export async function readAdminUserBirth(scope: ProfileReadScope, userCell: ccc.Cell, signal?: AbortSignal): Promise<number> {
  assertAdmin(scope);
  const userCode = hash(scope.protocol.protocol_config.script_code_hashes.ckb_boost_user_type_code_hash);
  const id = scopedId(userCell, userCode, scope), type = userCell.cellOutput.type;
  if (!id || !type) throw new Error("The registration profile is outside this protocol.");
  UserData.decode(userCell.outputData);
  const page = await request(scope, `birth-index:${type.hash()}`, () => scope.client.findTransactionsPaged({script: type, scriptType: "type", scriptSearchMode: "exact", groupByTransaction: true}, "asc", 1), signal);
  const first = page.transactions[0];
  if (!first || page.transactions.length !== 1) throw new Error("The User type creation transaction could not be located.");
  const response = await request(scope, `transaction:${first.txHash}`, () => scope.client.getTransaction(first.txHash), signal);
  if (!response || response.status !== "committed" || response.blockNumber == null || response.transaction.hash().toLowerCase() !== first.txHash.toLowerCase() || response.blockNumber !== first.blockNumber) throw new Error("The User creation transaction is not confirmed canonical evidence.");
  const tx = response.transaction;
  const outputIndices = tx.outputs.flatMap((output, index) => output.type?.eq(type) ? [index] : []);
  if (outputIndices.length !== 1 || !tx.inputs.length) throw new Error("A unique User creation output was not found.");
  const outputIndex = outputIndices[0];
  if (!first.cells.some(cell => !cell.isInput && cell.cellIndex === BigInt(outputIndex)) || !tx.outputs[outputIndex].lock.eq(userCell.cellOutput.lock) || ccc.hashTypeId(tx.inputs[0], outputIndex).toLowerCase() !== id) throw new Error("The historical User type does not prove creation for this wallet.");
  UserData.decode(tx.outputsData[outputIndex]);
  await Promise.all(tx.inputs.map(async input => {
    const parent = await request(scope, `transaction:${input.previousOutput.txHash}`, () => scope.client.getTransaction(input.previousOutput.txHash), signal);
    if (!parent || parent.transaction.hash().toLowerCase() !== input.previousOutput.txHash.toLowerCase()) throw new Error("A registration input parent could not be verified.");
    const output = parent.transaction.outputs[Number(input.previousOutput.index)];
    if (!output || output.type?.eq(type)) throw new Error("The oldest available User transaction is an update, not verified creation.");
  }));
  const header = await request(scope, `header:${response.blockNumber}`, () => scope.client.getHeaderByNumber(response.blockNumber!), signal);
  const milliseconds = header ? Number(header.timestamp) : NaN;
  if (!header || header.number !== response.blockNumber || response.blockHash && header.hash !== response.blockHash || !Number.isSafeInteger(milliseconds) || milliseconds <= 0 || milliseconds > 8_640_000_000_000_000) throw new Error("The registration block time is unavailable.");
  return milliseconds;
}
export async function readAdminOverviewMetrics(scope: ProfileReadScope, snapshot: AdminCurrentSnapshot, period: AdminPeriod, signal?: AbortSignal, now = Date.now()): Promise<AdminOverviewMetrics> {
  assertSnapshot(scope, snapshot);
  if (!(period in ADMIN_PERIOD_DAYS) || !Number.isSafeInteger(now)) throw new Error("Invalid overview period.");
  const creationTimes = snapshot.campaigns.map(record => profileTimestamp(record.data.created_at));
  const campaignsCreated = creationTimes.some(time => time === null) ? {value: null, deltaPercent: null, unavailableReason: "Some campaign creation timestamps are unavailable.", retryable: false} : metric(creationTimes as number[], now, ADMIN_PERIOD_DAYS[period]);
  let newUsers: AdminMetric = {value: null, deltaPercent: null};
  try {
    newUsers = await withProfileDeadline(async birthSignal => {
    const userCode = hash(scope.protocol.protocol_config.script_code_hashes.ckb_boost_user_type_code_hash);
    const cells = await typedCells(scope, userCode, birthSignal);
    if (cells.length > ADMIN_BIRTH_MAX_PROFILES) throw new Error("Registration proof exceeds the current 40-profile request budget.");
    if (new Set(cells.map(cell => cell.cellOutput.type!.hash())).size !== cells.length) throw new Error("The current registration query contains duplicate User type identities.");
    const births = new Map<string, number>();
    let index = 0;
    await Promise.all(Array.from({length: Math.min(4, cells.length)}, async () => {
      while (index < cells.length) {
        if (birthSignal.aborted) throw discoveryAbortError();
        const cell = cells[index++], at = await readAdminUserBirth(scope, cell, birthSignal), lockHash = cell.cellOutput.lock.hash();
        births.set(lockHash, Math.min(births.get(lockHash) ?? Infinity, at));
      }
    }));
    return metric([...births.values()], now, ADMIN_PERIOD_DAYS[period]);
    }, signal, 15_000);
  } catch (error) {newUsers.unavailableReason = error instanceof Error ? error.message : "Verified registration history is unavailable."; newUsers.retryable = true;}
  return {newUsers, campaignsCreated, questParticipants: {value: null, deltaPercent: null, retryable: false,
    unavailableReason: "User submission records can be edited or deleted. Current retained records cannot prove complete period-unique participating wallets."},
    coverageNote: `Rolling ${ADMIN_PERIOD_DAYS[period]} days versus the preceding equal window. Registrations use proven births of currently live profiles, deduplicated by wallet; campaigns use current live records' created_at. Deleted profiles/campaigns are outside this snapshot. No complete participant or balance history is inferred.`};
}
