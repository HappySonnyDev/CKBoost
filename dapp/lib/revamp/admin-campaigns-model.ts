import {ccc} from "@ckb-ccc/connector-react";
import {CampaignData, ConnectedTypeID} from "ssri-ckboost/types";
import {verifyCampaignOwnership} from "./campaign-permissions";
import {getDiscoveryStatus, matchesDiscoveryStatus, type CampaignDiscoveryStatus} from "./campaign-discovery";
import {profileTimestamp, readProfilePages, type ProfileReadScope} from "./profile-model";
import {isOverviewAdmin, type AdminCampaignRecord} from "./admin-overview-model";

export type AdminCampaignStatus = "under-review" | CampaignDiscoveryStatus;
export type AdminCampaignFilter = AdminCampaignStatus | "all";
export type AdminCampaignSort = "name" | "quests" | "organizer" | "created" | "start";
export type AdminCampaignQuery = {status: AdminCampaignFilter; search: string; sort: AdminCampaignSort; direction: "asc" | "desc"; page: number};
export type AdminCampaignRow = {id: string; title: string; questCount: number; organizerName: string; ownerLockHash: string | null; createdAt: number | null; startAt: number | null; endAt: number | null; status: AdminCampaignStatus; record: AdminCampaignRecord};
export const ADMIN_CAMPAIGNS_PAGE_SIZE = 10;
export const ADMIN_CAMPAIGN_FILTERS: readonly AdminCampaignFilter[] = ["under-review", "all", "active", "upcoming", "completed", "ending-soon"];
const sorts: readonly AdminCampaignSort[] = ["name", "quests", "organizer", "created", "start"];
const hash = (value: ccc.BytesLike) => ccc.hexFrom(value).toLowerCase();
export const ADMIN_CAMPAIGN_LABELS: Record<AdminCampaignFilter, string> = {"under-review": "Under review", all: "All campaigns", active: "Active", upcoming: "Upcoming", completed: "Completed", "ending-soon": "Ending soon"};
export function parseAdminCampaignQuery(query: URLSearchParams): AdminCampaignQuery {
  const status = query.get("status"), sort = query.get("sort"), page = Number(query.get("page") || 1);
  return {status: ADMIN_CAMPAIGN_FILTERS.includes(status as AdminCampaignFilter) ? status as AdminCampaignFilter : "under-review", search: (query.get("q") ?? "").slice(0, 200), sort: sorts.includes(sort as AdminCampaignSort) ? sort as AdminCampaignSort : "start", direction: query.get("direction") === "desc" ? "desc" : "asc", page: Number.isSafeInteger(page) && page > 0 ? Math.min(page, 100_000) : 1};
}
export function adminCampaignQueryString(query: AdminCampaignQuery): string {
  const params = new URLSearchParams(); params.set("status", query.status);
  if (query.search) params.set("q", query.search); if (query.sort !== "start") params.set("sort", query.sort); if (query.direction !== "asc") params.set("direction", query.direction); if (query.page > 1) params.set("page", String(query.page));
  return params.toString();
}
export function adminCampaignReturnQuery(value: string | null): string {return adminCampaignQueryString(parseAdminCampaignQuery(new URLSearchParams(value ?? "")));}
export function adminCampaignDetailHref(id: string, query: AdminCampaignQuery): string {return `/revamp/admin/campaigns/${encodeURIComponent(id)}?from=${encodeURIComponent(adminCampaignQueryString(query))}`;}
export function adminCampaignRows(scope: ProfileReadScope, records: readonly AdminCampaignRecord[], now = Date.now()): AdminCampaignRow[] {
  if (!isOverviewAdmin(scope)) throw new Error("Current platform Admin access is required.");
  const approved = new Set(scope.protocol.campaigns_approved.map(hash));
  return records.map(record => {
    const type = record.cell.cellOutput.type, codes = scope.protocol.protocol_config.script_code_hashes;
    if (!type || type.hashType !== "type" || hash(type.codeHash) !== hash(codes.ckb_boost_campaign_type_code_hash)) throw new Error("A campaign has an unexpected code identity.");
    const connected = ConnectedTypeID.decode(type.args);
    if (hash(connected.connected_key) !== scope.protocolHash || hash(connected.type_id) !== record.id || ccc.hexFrom(ConnectedTypeID.encode(connected)).toLowerCase() !== type.args.toLowerCase()) throw new Error("A campaign does not match this complete protocol identity.");
    const data = CampaignData.decode(record.cell.outputData);
    const owner = verifyCampaignOwnership({campaignTypeId: record.id, protocolTypeHash: scope.protocolHash, campaignTypeCodeHash: hash(codes.ckb_boost_campaign_type_code_hash), protocolLockCodeHash: hash(codes.ckb_boost_protocol_lock_code_hash), protocolLockHashType: scope.protocolCell.cellOutput.lock.hashType, cell: record.cell});
    const ownerLockHash = owner?.ownerLockHash ?? null;
    const organizer = scope.protocol.endorsers_whitelist.find(value => hash(value.endorser_lock_hash) === ownerLockHash);
    const startAt = profileTimestamp(data.starting_time), endAt = profileTimestamp(data.ending_time);
    if (startAt == null || endAt == null || endAt <= startAt) throw new Error(`Campaign ${data.metadata.title || record.id} has an invalid schedule.`);
    const status = !approved.has(record.id) ? "under-review" : getDiscoveryStatus({startDate: startAt, endDate: endAt}, now);
    return {id: record.id, title: data.metadata.title || "Untitled campaign", questCount: data.quests.length, organizerName: organizer?.endorser_name || "Unknown organizer", ownerLockHash, createdAt: profileTimestamp(data.created_at), startAt, endAt, status, record: {...record, data}};
  });
}
export function adminCampaignCounts(rows: readonly AdminCampaignRow[]) {return {total: rows.length, underReview: rows.filter(row => row.status === "under-review").length, active: rows.filter(row => row.status === "active" || row.status === "ending-soon").length, completed: rows.filter(row => row.status === "completed").length};}
export function selectAdminCampaignRows(rows: readonly AdminCampaignRow[], query: AdminCampaignQuery) {
  const search = query.search.trim().toLowerCase();
  const filtered = rows.filter(row => (query.status === "all" || (query.status === "under-review" ? row.status === "under-review" : row.status !== "under-review" && matchesDiscoveryStatus(row.status, query.status))) && (!search || [row.title, row.organizerName, row.ownerLockHash ?? "", row.id].some(value => value.toLowerCase().includes(search))));
  // Keep unapproved rows outside all schedule filters, regardless of their dates.
  const matching = filtered.filter(row => query.status !== "under-review" || row.status === "under-review");
  matching.sort((a, b) => {
    let value = query.sort === "name" ? a.title.localeCompare(b.title, "en") : query.sort === "organizer" ? a.organizerName.localeCompare(b.organizerName, "en") : query.sort === "quests" ? a.questCount - b.questCount : (query.sort === "created" ? a.createdAt ?? 0 : a.startAt ?? 0) - (query.sort === "created" ? b.createdAt ?? 0 : b.startAt ?? 0);
    if (query.direction === "desc") value = -value;
    return value || a.id.localeCompare(b.id);
  });
  const pages = Math.max(1, Math.ceil(matching.length / ADMIN_CAMPAIGNS_PAGE_SIZE)), page = Math.min(query.page, pages);
  return {rows: matching.slice((page - 1) * ADMIN_CAMPAIGNS_PAGE_SIZE, page * ADMIN_CAMPAIGNS_PAGE_SIZE), total: matching.length, pages, page};
}
export async function readAdminCampaigns(scope: ProfileReadScope, signal?: AbortSignal): Promise<AdminCampaignRecord[]> {
  if (!isOverviewAdmin(scope)) throw new Error("Current platform Admin access is required.");
  const code = hash(scope.protocol.protocol_config.script_code_hashes.ckb_boost_campaign_type_code_hash), seen = new Set<string>();
  const cells = await readProfilePages(scope, {script: {codeHash: code, hashType: "type", args: "0x"}, scriptType: "type", scriptSearchMode: "prefix", withData: true}, `admin-campaigns:${scope.protocolHash}:${code}`, signal);
  const records: AdminCampaignRecord[] = [];
  for (const cell of cells) {
    const type = cell.cellOutput.type; if (!type || type.codeHash !== code || type.hashType !== "type") continue;
    let link:ReturnType<typeof ConnectedTypeID.decode>; try {link = ConnectedTypeID.decode(type.args);} catch {continue;} if (hash(link.connected_key) !== scope.protocolHash) continue;
    if (ccc.hexFrom(ConnectedTypeID.encode(link)).toLowerCase() !== type.args.toLowerCase()) throw new Error("A campaign type identity is noncanonical.");
    const id = hash(link.type_id) as ccc.Hex; if (seen.has(id)) throw new Error("Multiple live cells identify the same campaign. Retry the complete query."); seen.add(id);
    records.push({id, cell, data: CampaignData.decode(cell.outputData)});
  }
  return records;
}
