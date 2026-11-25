import {ccc} from "@ckb-ccc/connector-react";
import {ConnectedTypeID, ProtocolData, UserData, type ProtocolDataLike} from "ssri-ckboost/types";
import {getLatestDisplayName} from "@/lib/profile/profile-data";
import {extractIdentityDisplayName} from "@/lib/utils/identity";
import {isOverviewAdmin, readAdminUserBirth} from "./admin-overview-model";
import {profileTimestamp, readProfilePages, type ProfileIdentity, type ProfileReadScope} from "./profile-model";

export type AdminUserRole = "member" | "organizer" | "platform-admin";
export type AdminUserVerification = "all" | "telegram" | "manual" | "unverified";
export interface AdminUserRecord {
  id: ccc.Hex; typeHash: ccc.Hex; cell: ccc.Cell; user: ReturnType<typeof UserData.decode>;
  address: string; lockHash: ccc.Hex; displayName: string | null; role: AdminUserRole;
  telegram: boolean; manual: boolean | null; lastActiveAt: number | null;
  recordedPoints: bigint; questsSubmitted: number; campaignsParticipated: number;
}
export interface AdminUsersRegistrySnapshot {
  protocolTypeHash: string; available: boolean; unavailableReason: string | null;
  attestations: Array<{userTypeHash: string; walletLockHash: string; verified: boolean; verifiedAt: number | null; verifiedByLockHash: string; transactionHash: string}>;
}
export interface AdminUserVerificationPayload {
  schema: "ckboost-admin-user-verification/v1"; protocolTypeHash: ccc.Hex; userTypeId: ccc.Hex; userTypeHash: ccc.Hex; walletLockHash: ccc.Hex;
  expectedUserOutPoint: {txHash: ccc.Hex; index: string}; expectedUserDataHash: ccc.Hex; verified: true;
}
export interface AdminUsersRegistryAdapter {
  read(scope: ProfileReadScope, signal?: AbortSignal): Promise<AdminUsersRegistrySnapshot>;
  /** Resolve only after commitment and fresh, identity-bound registry readback. */
  save(scope: ProfileReadScope, signer: ccc.Signer, payload: AdminUserVerificationPayload, isCurrent: () => Promise<void>): Promise<{transactionHash: string}>;
}
export const ADMIN_USERS_PAGE_SIZE = 20;
const hash = (value: ccc.BytesLike): ccc.Hex => {const result = ccc.hexFrom(value).toLowerCase(); if (!/^0x[0-9a-f]{64}$/.test(result)) throw new Error("A complete 32-byte identity is required."); return result as ccc.Hex;};
export function assertUsersAdmin(scope: ProfileReadScope) {if (!isOverviewAdmin(scope)) throw new Error("Only a current platform Admin can manage users.");}
export function adminUserRole(scope: ProfileReadScope, lockHash: string): AdminUserRole {
  if (scope.protocol.protocol_config.admin_lock_hash_vec.some(value => hash(value) === lockHash.toLowerCase())) return "platform-admin";
  return scope.protocol.endorsers_whitelist.some(value => hash(value.endorser_lock_hash) === lockHash.toLowerCase()) ? "organizer" : "member";
}
export function adminUserId(scope: ProfileReadScope, cell: ccc.Cell): ccc.Hex | null {
  const type = cell.cellOutput.type;
  if (!type || type.hashType !== "type" || type.codeHash.toLowerCase() !== hash(scope.protocol.protocol_config.script_code_hashes.ckb_boost_user_type_code_hash)) return null;
  try {const decoded = ConnectedTypeID.decode(type.args); return hash(decoded.connected_key) === scope.protocolHash && ccc.hexFrom(ConnectedTypeID.encode(decoded)) === type.args ? hash(decoded.type_id) : null;} catch {return null;}
}
export function adminUserFromCell(scope: ProfileReadScope, cell: ccc.Cell): AdminUserRecord {
  assertUsersAdmin(scope); const id = adminUserId(scope, cell); if (!id) throw new Error("This User cell belongs to a different protocol.");
  const user = UserData.decode(cell.outputData), lockHash = cell.cellOutput.lock.hash();
  const submissions = new Set(user.submission_records.map(record => `${hash(record.campaign_type_id)}:${record.quest_id}`));
  return {id, typeHash: cell.cellOutput.type!.hash(), cell, user, lockHash, address: ccc.Address.fromScript(cell.cellOutput.lock, scope.client).toString(),
    displayName: getLatestDisplayName(user.profile_data) ?? extractIdentityDisplayName(user.verification_data.identity_verification_data),
    role: adminUserRole(scope, lockHash), telegram: BigInt(user.verification_data.telegram_personal_chat_id) > 0n, manual: null,
    lastActiveAt: profileTimestamp(user.last_activity_timestamp), recordedPoints: BigInt(user.total_points_earned), questsSubmitted: submissions.size,
    campaignsParticipated: new Set(user.submission_records.map(record => hash(record.campaign_type_id))).size};
}
export async function readAdminUsers(scope: ProfileReadScope, signal?: AbortSignal): Promise<AdminUserRecord[]> {
  assertUsersAdmin(scope); const codeHash = hash(scope.protocol.protocol_config.script_code_hashes.ckb_boost_user_type_code_hash);
  const cells = await readProfilePages(scope, {script: {codeHash, hashType: "type", args: "0x"}, scriptType: "type", scriptSearchMode: "prefix", withData: true}, `admin-users:${scope.protocolHash}:${codeHash}`, signal);
  const records = cells.filter(cell => adminUserId(scope, cell)).map(cell => adminUserFromCell(scope, cell));
  if (new Set(records.map(record => record.id)).size !== records.length) throw new Error("Multiple live cells identify the same user. Retry before managing access.");
  return sortAdminUsers(records);
}
export async function readAdminUser(scope: ProfileReadScope, id: string, signal?: AbortSignal): Promise<AdminUserRecord | null> {
  assertUsersAdmin(scope); const userId = hash(id as ccc.Hex), codeHash = hash(scope.protocol.protocol_config.script_code_hashes.ckb_boost_user_type_code_hash);
  const type = ccc.Script.from({codeHash, hashType: "type", args: ccc.hexFrom(ConnectedTypeID.encode({type_id: userId, connected_key: scope.protocolHash}))});
  const cells = (await readProfilePages(scope, {script: type, scriptType: "type", scriptSearchMode: "exact", withData: true}, `admin-user:${scope.protocolHash}:${userId}`, signal)).filter(cell => cell.cellOutput.type?.eq(type));
  if (cells.length > 1) throw new Error("This user has multiple current cells. Retry before managing access.");
  return cells[0] ? adminUserFromCell(scope, cells[0]) : null;
}
export function sortAdminUsers(records: readonly AdminUserRecord[]): AdminUserRecord[] {
  const priority = {"platform-admin": 0, organizer: 1, member: 2};
  return [...records].sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0) || priority[a.role] - priority[b.role] || a.id.localeCompare(b.id));
}
export function filterAdminUsers(records: readonly AdminUserRecord[], search: string, role: AdminUserRole | "all", verification: AdminUserVerification): AdminUserRecord[] {
  const query = search.trim().toLowerCase();
  return sortAdminUsers(records.filter(record => (!query || [record.displayName ?? "", record.address, record.lockHash, record.id].some(value => value.toLowerCase().includes(query))) &&
    (role === "all" || record.role === role) && (verification === "all" || verification === "telegram" && record.telegram || verification === "manual" && record.manual === true || verification === "unverified" && !record.telegram && record.manual === false)));
}
export function applyAdminManualVerifications(scope: ProfileReadScope, records: readonly AdminUserRecord[], registry: AdminUsersRegistrySnapshot | null): AdminUserRecord[] {
  assertUsersAdmin(scope); if (registry && registry.protocolTypeHash.toLowerCase() !== scope.protocolHash) throw new Error("The verification registry belongs to another protocol.");
  return records.map(record => ({...record, manual: !registry?.available ? null : registry.attestations.some(entry => entry.verified && entry.userTypeHash.toLowerCase() === record.typeHash && entry.walletLockHash.toLowerCase() === record.lockHash)}));
}
export function adminTargetProfile(scope: ProfileReadScope, record: AdminUserRecord): {scope: ProfileReadScope; identity: ProfileIdentity} {
  assertUsersAdmin(scope); if (adminUserId(scope, record.cell) !== record.id || record.cell.cellOutput.type!.hash() !== record.typeHash) throw new Error("The user detail identity changed.");
  return {scope: {...scope, walletLock: record.cell.cellOutput.lock, lockHash: record.lockHash, address: record.address}, identity: {address: record.address, lockHash: record.lockHash,
    userTypeId: record.id, userCell: record.cell, user: record.user, displayName: record.displayName, lastActiveAt: record.lastActiveAt, verifiedTelegram: record.telegram}};
}
export async function readAdminUserJoinDates(scope: ProfileReadScope, records: readonly AdminUserRecord[], signal?: AbortSignal): Promise<Record<string, {at: number | null; error: string | null}>> {
  assertUsersAdmin(scope); if (records.length > ADMIN_USERS_PAGE_SIZE) throw new Error("Registration dates must be requested one visible page at a time.");
  const result: Record<string, {at: number | null; error: string | null}> = {}; let index = 0;
  await Promise.all(Array.from({length: Math.min(4, records.length)}, async () => {while (index < records.length) {
    if (signal?.aborted) throw new DOMException("The user date query was cancelled.", "AbortError");
    const record = records[index++]; try {result[record.id] = {at: await readAdminUserBirth(scope, record.cell, signal), error: null};} catch (error) {result[record.id] = {at: null, error: error instanceof Error ? error.message : "Verified registration time is unavailable."};}
  }})); return result;
}
export function makeAdminVerificationPayload(scope: ProfileReadScope, record: AdminUserRecord): AdminUserVerificationPayload {
  assertUsersAdmin(scope); if (adminUserId(scope, record.cell) !== record.id || record.typeHash !== record.cell.cellOutput.type!.hash() || record.lockHash !== record.cell.cellOutput.lock.hash()) throw new Error("The verification target is not the exact current User identity.");
  return {schema: "ckboost-admin-user-verification/v1", protocolTypeHash: scope.protocolHash, userTypeId: record.id, userTypeHash: record.typeHash, walletLockHash: record.lockHash,
    expectedUserOutPoint: {txHash: record.cell.outPoint.txHash, index: record.cell.outPoint.index.toString()}, expectedUserDataHash: ccc.hashCkb(record.cell.outputData), verified: true};
}
export interface AdminAccessPlan {protocolTypeHash: ccc.Hex; protocolOutPoint: string; protocolDataHash: ccc.Hex; walletAddress: string; walletLockHash: ccc.Hex; role: AdminUserRole; changes: string[]; updated: ProtocolDataLike}
export function makeAdminAccessPlan(scope: ProfileReadScope, wallet: ccc.Address, role: AdminUserRole): AdminAccessPlan {
  assertUsersAdmin(scope); if (!["member", "organizer", "platform-admin"].includes(role)) throw new Error("Choose an explicit access role.");
  const target = wallet.script.hash(), updated = ProtocolData.decode(ProtocolData.encode(scope.protocol)) as ProtocolDataLike;
  const admins = scope.protocol.protocol_config.admin_lock_hash_vec.map(hash), organizer = scope.protocol.endorsers_whitelist.some(value => hash(value.endorser_lock_hash) === target);
  const hadAdmin = admins.includes(target); if (hadAdmin && role !== "platform-admin" && new Set(admins).size <= 1) throw new Error("The last platform Admin cannot be removed. Add another Admin first.");
  const changes: string[] = [];
  updated.protocol_config.admin_lock_hash_vec = admins.filter(value => value !== target);
  updated.endorsers_whitelist = updated.endorsers_whitelist.filter(value => hash(value.endorser_lock_hash) !== target);
  if (role === "platform-admin") {updated.protocol_config.admin_lock_hash_vec.push(target); if (!hadAdmin) changes.push("Grant Platform admin access");}
  else if (hadAdmin) changes.push("Revoke Platform admin access");
  if (role === "organizer") {
    const existing = scope.protocol.endorsers_whitelist.find(value => hash(value.endorser_lock_hash) === target);
    updated.endorsers_whitelist.push(existing ?? {endorser_lock_hash: target, endorser_name: "", endorser_description: "", website: "", social_links: [], verified: 0});
    if (!organizer) changes.push("Grant Organizer access");
  } else if (organizer) changes.push("Revoke Organizer access");
  if (!changes.length) throw new Error("This wallet already has exactly the selected role.");
  return {protocolTypeHash: scope.protocolHash, protocolOutPoint: `${scope.protocolCell.outPoint.txHash}:${scope.protocolCell.outPoint.index}`, protocolDataHash: ccc.hashCkb(scope.protocolCell.outputData),
    walletAddress: wallet.toString(), walletLockHash: target, role, changes, updated};
}
