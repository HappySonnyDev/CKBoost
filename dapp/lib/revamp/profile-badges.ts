import { ccc } from "@ckb-ccc/connector-react";
import { ConnectedTypeID, ProtocolData } from "ssri-ckboost/types";
import { toAchievementEntries } from "@/lib/ckb/achievement-cells";
import { normalizePermissionHash } from "./campaign-permissions";
import { runDiscoveryRequest } from "./discovery-loader";

export interface ProfileBadgeIdentity {
  address: string;
  lockHash: string;
}

export interface ProfileBadge {
  id: string;
  title: string;
  /** Metadata has not been fetched; do not infer a description or artwork from a title. */
  description: string | null;
  image: { kind: "none" };
  classification: "first-submission" | "telegram-verification" | "other";
  metadataNeventId: string;
  claimed: boolean;
  /** Unix milliseconds. A receiver record proves claimed even if its date is invalid. */
  claimedAt: number | null;
  /** null means eligibility is unknown, rather than ineligible. */
  claimable: boolean | null;
}

export const BADGE_ELIGIBILITY_UNAVAILABLE =
  "Badge eligibility is unavailable: the existing eligibility service does not isolate achievement definitions by protocol. Badge claiming is disabled here.";

export interface ProfileBadgeResult {
  badges: ProfileBadge[];
  eligibilityUnavailableReason: string | null;
}

export function profileBadgeScope(protocolCell: ccc.Cell) {
  const type = protocolCell.cellOutput.type;
  const protocolTypeHash = normalizePermissionHash(type?.hash());
  if (!type || !protocolTypeHash) throw new Error("The current protocol is unavailable.");
  const data = ProtocolData.decode(protocolCell.outputData);
  const codes = data.protocol_config.script_code_hashes;
  const achievementCodeHash = normalizePermissionHash(ccc.hexFrom(codes.ckb_boost_achievement_type_code_hash));
  const userCodeHash = normalizePermissionHash(ccc.hexFrom(codes.ckb_boost_user_type_code_hash));
  if (!achievementCodeHash || !userCodeHash) throw new Error("The protocol's badge configuration is unavailable.");
  return {
    protocolTypeHash: protocolTypeHash as ccc.Hex,
    achievementCodeHash: achievementCodeHash as ccc.Hex,
    userCodeHash: userCodeHash as ccc.Hex,
    // Data changes invalidate pending reads even while the protocol's identity stays the same.
    key: `${protocolTypeHash}:${ccc.hashCkb(protocolCell.outputData)}`,
  };
}

function hasProtocolType(cell: ccc.Cell, codeHash: ccc.Hex, protocolHash: ccc.Hex): boolean {
  const type = cell.cellOutput.type;
  if (!type || type.hashType !== "type" || type.codeHash.toLowerCase() !== codeHash.toLowerCase()) return false;
  try {
    const connected = ConnectedTypeID.decode(type.args);
    return ccc.hexFrom(ConnectedTypeID.encode(connected)).toLowerCase() === type.args.toLowerCase() &&
      ccc.hexFrom(connected.connected_key).toLowerCase() === protocolHash.toLowerCase();
  } catch {
    return false;
  }
}

function grantedAtMilliseconds(value: unknown): number | null {
  try {
    const raw = BigInt(ccc.numFrom(value as ccc.NumLike));
    const milliseconds = raw >= 1_000_000_000_000n ? raw : raw * 1_000n;
    if (milliseconds <= 0n || milliseconds > 8_640_000_000_000_000n) return null;
    return Number(milliseconds);
  } catch {
    return null;
  }
}

/** Read only: no eligibility POST, wallet signature, transaction building or claim. */
export async function readProfileBadges({ client, protocolCell, identity, isCurrent = () => true }: {
  client: ccc.Client;
  protocolCell: ccc.Cell;
  identity: ProfileBadgeIdentity;
  isCurrent?: () => boolean;
}): Promise<ProfileBadgeResult> {
  const assertCurrent = () => {
    if (!isCurrent()) throw new Error("The wallet or protocol changed.");
  };
  assertCurrent();
  const scope = profileBadgeScope(protocolCell);
  const lockHash = normalizePermissionHash(identity.lockHash);
  const address = await ccc.Address.fromString(identity.address, client);
  assertCurrent();
  if (!lockHash || address.script.hash().toLowerCase() !== lockHash) throw new Error("The current wallet identity could not be verified.");

  // The service is framework independent; the legacy dashboard/providers need not mount.
  const { AchievementService } = await import("@/lib/services/achievement-service");
  assertCurrent();
  const service = new AchievementService(client, scope.achievementCodeHash);
  const achievementCell = await service.getAchievementCell(scope.protocolTypeHash);
  assertCurrent();
  if (!hasProtocolType(achievementCell, scope.achievementCodeHash, scope.protocolTypeHash)) {
    throw new Error("The badge definitions do not belong to the current protocol.");
  }
  const entries = toAchievementEntries(achievementCell);
  if (entries.length === 0) return { badges: [], eligibilityUnavailableReason: null };

  // Only this wallet's canonical User type connected to this protocol can match a receiver.
  // Avoid the legacy latest-user helper's fallback to an arbitrary first cell on RPC failure.
  const userCells: ccc.Cell[] = [], seen = new Set<string>();
  let cursor: string | undefined, complete = false;
  for (let page = 0; page < 20; page++) {
    assertCurrent();
    const result = await runDiscoveryRequest(client, () => client.findCellsPaged({
      script: address.script, scriptType: "lock", scriptSearchMode: "exact", withData: true,
      filter: { script: { codeHash: scope.userCodeHash, hashType: "type", args: "0x" } },
    }, "asc", 100, cursor));
    assertCurrent();
    for (const cell of result.cells) {
      const point = `${cell.outPoint.txHash}:${cell.outPoint.index}`;
      if (seen.has(point)) throw new Error("The badge receiver query repeated a cell. Please retry.");
      seen.add(point);
      if (cell.cellOutput.lock.hash().toLowerCase() === lockHash && hasProtocolType(cell, scope.userCodeHash, scope.protocolTypeHash)) userCells.push(cell);
    }
    if (result.cells.length < 100) { complete = true; break; }
    if (!result.lastCursor || result.lastCursor === cursor) throw new Error("The badge receiver query did not finish. Please retry.");
    cursor = result.lastCursor;
  }
  if (!complete) throw new Error("The badge receiver query exceeds the current limit. Its status is unavailable.");
  assertCurrent();
  let userCell = userCells[0];
  if (userCells.length > 1) {
    const ranked: Array<{cell: ccc.Cell; height: bigint}> = [];
    for (const cell of userCells) {
      const transaction = await runDiscoveryRequest(client, () => client.getTransaction(cell.outPoint.txHash));
      assertCurrent();
      if (!transaction || transaction.blockNumber === undefined || transaction.blockNumber === null) {
        throw new Error("The current badge receiver could not be determined.");
      }
      const height = BigInt(transaction.blockNumber);
      ranked.push({cell, height});
    }
    ranked.sort((a, b) => a.height === b.height ? 0 : a.height > b.height ? -1 : 1);
    if (ranked[0].height === ranked[1].height) throw new Error("Multiple badge receiver profiles exist in the latest block. The current profile is ambiguous.");
    userCell = ranked[0].cell;
  }
  const userTypeHash = userCell?.cellOutput.type?.hash().toLowerCase();
  const achievementTypeHash = achievementCell.cellOutput.type!.hash();
  const badges: ProfileBadge[] = entries.map((entry, index) => {
    const record = userTypeHash ? entry.records.find(receiver => ccc.hexFrom(receiver.receiver_user_type_hash).toLowerCase() === userTypeHash) : undefined;
    return {
      id: `${achievementTypeHash}:${index}`,
      title: entry.title,
      description: null,
      image: { kind: "none" },
      classification: entry.title === "First Submission" ? "first-submission" : entry.title === "Telegram Verification" ? "telegram-verification" : "other",
      metadataNeventId: entry.metadataNeventId,
      claimed: Boolean(record),
      claimedAt: record ? grantedAtMilliseconds(record.granted_at) : null,
      claimable: record ? false : null,
    };
  });
  assertCurrent();
  return { badges, eligibilityUnavailableReason: badges.some(badge => !badge.claimed) ? BADGE_ELIGIBILITY_UNAVAILABLE : null };
}
