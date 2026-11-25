import {ccc} from "@ckb-ccc/connector-react";
import type {AdminRewardPeriod} from "./admin-rewards-model";

export const ADMIN_REGISTRY_MAGIC = "CKBADMIN";
export const ADMIN_REGISTRY_MAX_BYTES = 131_072;
export const ADMIN_REGISTRY_MAX_ENTRIES = 512;
export interface AdminManualAttestation {
  userTypeId: ccc.Hex; userTypeHash: ccc.Hex; walletLockHash: ccc.Hex;
  verified: true; verifiedAt: number; verifiedByLockHash: ccc.Hex;
  userOutPoint: {txHash: ccc.Hex; index: string}; userDataHash: ccc.Hex;
}
export interface AdminTipSettings {
  expirationSeconds: string;
  approverLockHashes: ccc.Hex[];
  thresholdsShannons: string[];
}
export interface AdminRegistryData {
  schema: "ckboost-admin-registry/v1";
  protocolTypeHash: ccc.Hex;
  revision: string;
  tipping: AdminTipSettings;
  attestations: AdminManualAttestation[];
  periods: AdminRewardPeriod[];
}
export function registryHash(value: unknown): ccc.Hex {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value) || /^0x0{64}$/i.test(value)) throw new Error("A complete, nonzero chain identity is required.");
  return value.toLowerCase() as ccc.Hex;
}
export function registryUint(value: unknown, bits: number): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("Registry quantities must be canonical decimal integers.");
  const result = BigInt(value); if (result >= 1n << BigInt(bits)) throw new Error(`Registry value exceeds Uint${bits}.`); return result;
}
/** Stable JSON is only the metadata tail; all financial settings have an exact
 * binary representation that can be read by the on-chain validators. */
export function registryCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(registryCanonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${registryCanonical((value as Record<string,unknown>)[key])}`).join(",")}}`;
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
  throw new Error("Registry metadata must contain safe JSON values.");
}
function unique(values: readonly string[], label: string) {if (values.length > ADMIN_REGISTRY_MAX_ENTRIES || new Set(values).size !== values.length) throw new Error(`${label} must be unique and bounded.`);}
export function validateAdminRegistry(value: AdminRegistryData): AdminRegistryData {
  if (!value || value.schema !== "ckboost-admin-registry/v1") throw new Error("Unsupported Admin registry version.");
  registryHash(value.protocolTypeHash); registryUint(value.revision,64);
  if (!value.tipping || !Array.isArray(value.tipping.approverLockHashes) || !Array.isArray(value.tipping.thresholdsShannons) || !Array.isArray(value.attestations) || !Array.isArray(value.periods)) throw new Error("Invalid Admin registry collections.");
  const expiry = registryUint(value.tipping.expirationSeconds,64); if (expiry > 3650n * 86400n) throw new Error("Tip validity exceeds the supported ten-year range.");
  const approvers = value.tipping.approverLockHashes.map(registryHash); unique(approvers,"Tip approvers");
  const thresholds = value.tipping.thresholdsShannons.map(amount => registryUint(amount,128));
  if (thresholds.length > 32 || thresholds.some((amount,index) => amount === 0n || index > 0 && amount <= thresholds[index-1])) throw new Error("Approval thresholds must be positive and strictly increasing.");
  unique(value.attestations.map(entry => registryHash(entry.userTypeHash)),"Manual verifications");
  for (const entry of value.attestations) {
    registryHash(entry.userTypeId); registryHash(entry.walletLockHash); registryHash(entry.verifiedByLockHash); registryHash(entry.userDataHash); registryHash(entry.userOutPoint?.txHash);
    if (entry.verified !== true || !Number.isSafeInteger(entry.verifiedAt) || entry.verifiedAt <= 0 || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(entry.userOutPoint.index) || BigInt(entry.userOutPoint.index) > 0xffffffffn) throw new Error("Invalid manual verification evidence.");
  }
  unique(value.periods.map(period => period.id),"Reward periods");
  for (const period of value.periods) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(period.id) || typeof period.name !== "string" || !period.name.trim() || period.name.length > 200 || !Number.isSafeInteger(period.startAtMs) || !Number.isSafeInteger(period.endAtMs) || period.startAtMs < 0 || period.endAtMs <= period.startAtMs) throw new Error("Invalid reward period schedule.");
    try {new Intl.DateTimeFormat("en",{timeZone:period.timeZone}).format(0);} catch {throw new Error("Invalid reward period timezone.");}
    const amount = registryUint(period.totalAmount,128); if (!amount) throw new Error("A reward period requires a positive asset amount.");
    if (!period.asset || !["ckb","points","udt"].includes(period.asset.kind) || !Number.isInteger(period.asset.decimals) || period.asset.decimals < 0 || period.asset.decimals > 36 || typeof period.asset.id !== "string" || typeof period.asset.symbol !== "string" || !period.asset.symbol.trim()) throw new Error("Invalid reward asset.");
    if (period.asset.kind !== "ckb") {if (!period.asset.typeScript) throw new Error("Typed rewards require their complete script."); ccc.Script.from(period.asset.typeScript);}
    if (!Array.isArray(period.tiers) || period.tiers.length !== 4 || period.tiers.reduce((sum,tier) => sum + tier.shareBps,0) !== 10000) throw new Error("Reward allocation must total exactly 100%.");
    const ranks = [[1,1],[2,2],[3,3],[4,10]];
    period.tiers.forEach((tier,index) => {if (tier.fromRank !== ranks[index][0] || tier.toRank !== ranks[index][1] || !Number.isInteger(tier.shareBps) || tier.shareBps < 0 || amount * BigInt(tier.shareBps) % 10000n !== 0n) throw new Error("Invalid reward tier or indivisible allocation.");});
    registryUint(period.eligibility.minimumPoints,128);
    if (!Number.isInteger(period.eligibility.minimumApprovedQuests) || period.eligibility.minimumApprovedQuests < 0 || period.eligibility.minimumApprovedQuests > 0xffffffff || !["none","telegram","manual","any"].includes(period.eligibility.verification)) throw new Error("Invalid reward eligibility.");
  }
  return value;
}
function concat(parts: Uint8Array[]): Uint8Array {const bytes = new Uint8Array(parts.reduce((sum,part) => sum + part.length,0)); let offset = 0; for (const part of parts) {bytes.set(part,offset); offset += part.length;} return bytes;}
const le = (value: bigint | number, size: number) => ccc.numLeToBytes(value,size);
export function encodeAdminRegistry(value: AdminRegistryData): ccc.Hex {
  validateAdminRegistry(value);
  const json = ccc.bytesFrom(registryCanonical({attestations:value.attestations,periods:value.periods}),"utf8");
  const bytes = concat([ccc.bytesFrom(ADMIN_REGISTRY_MAGIC,"utf8"),le(1,4),ccc.bytesFrom(value.protocolTypeHash),le(BigInt(value.revision),8),le(BigInt(value.tipping.expirationSeconds),8),
    le(value.tipping.thresholdsShannons.length,4),...value.tipping.thresholdsShannons.map(amount => le(BigInt(amount),16)),
    le(value.tipping.approverLockHashes.length,4),...value.tipping.approverLockHashes.map(hash => ccc.bytesFrom(hash)),le(json.length,4),json]);
  if (bytes.length > ADMIN_REGISTRY_MAX_BYTES) throw new Error("Admin registry exceeds its supported size. A reviewed registry migration is required.");
  return ccc.hexFrom(bytes);
}
export function decodeAdminRegistry(input: ccc.BytesLike): AdminRegistryData {
  const bytes = ccc.bytesFrom(input); if (bytes.length > ADMIN_REGISTRY_MAX_BYTES) throw new Error("Oversized Admin registry.");
  let offset = 0;
  function take(size: number) {if (!Number.isSafeInteger(size) || size < 0 || offset + size > bytes.length) throw new Error("Truncated Admin registry."); const result = bytes.slice(offset,offset+size); offset += size; return result;}
  const num = (size: number) => ccc.numLeFromBytes(take(size));
  if (ccc.bytesTo(take(8),"utf8") !== ADMIN_REGISTRY_MAGIC || num(4) !== 1n) throw new Error("Unsupported Admin registry encoding.");
  const protocolTypeHash = ccc.hexFrom(take(32)), revision = num(8).toString(), expirationSeconds = num(8).toString();
  const thresholdCount = Number(num(4)); if (thresholdCount > 32) throw new Error("Too many approval rules.");
  const thresholdsShannons = Array.from({length:thresholdCount},() => num(16).toString());
  const approverCount = Number(num(4)); if (approverCount > ADMIN_REGISTRY_MAX_ENTRIES) throw new Error("Too many tip approvers.");
  const approverLockHashes = Array.from({length:approverCount},() => ccc.hexFrom(take(32)));
  const length = Number(num(4)); let metadata: {attestations:AdminManualAttestation[];periods:AdminRewardPeriod[]};
  try {metadata = JSON.parse(ccc.bytesTo(take(length),"utf8"));} catch {throw new Error("Invalid Admin registry metadata.");}
  if (offset !== bytes.length || Object.keys(metadata).sort().join(",") !== "attestations,periods") throw new Error("Unexpected Admin registry fields or trailing bytes.");
  const value: AdminRegistryData = {schema:"ckboost-admin-registry/v1",protocolTypeHash,revision,tipping:{expirationSeconds,thresholdsShannons,approverLockHashes},...metadata};
  validateAdminRegistry(value);
  if (encodeAdminRegistry(value) !== ccc.hexFrom(bytes)) throw new Error("Noncanonical Admin registry.");
  return value;
}
