import { ccc } from "@ckb-ccc/connector-react";
import { AchievementDataVec, ConnectedTypeID, UserData } from "ssri-ckboost/types";
import { getLatestDisplayName } from "@/lib/profile/profile-data";
import { extractIdentityDisplayName } from "@/lib/utils/identity";
import { profileTimestamp, readProfilePages, type ProfileReadScope } from "./profile-model";

export interface AdminAchievementClaim {
  id: string; receiverTypeHash: ccc.Hex; grantedAt: number | null; grantedAtRaw: string;
  name: string | null; address: string | null; lockHash: ccc.Hex | null; isCurrentWallet: boolean;
}
export interface AdminAchievement {
  id: string; title: string; metadataNeventId: string; cell: ccc.Cell; index: number;
  classification: "telegram-verification" | "first-submission" | "other";
  claims: AdminAchievementClaim[];
}
export interface AdminRewardsAsset {
  id: string; kind: "ckb" | "points" | "udt"; symbol: string; decimals: number;
  typeScript?: {codeHash: ccc.Hex; hashType: ccc.HashType; args: ccc.Hex};
}
export interface AdminRewardTier {fromRank: number; toRank: number; shareBps: number}
export type AdminRewardVerification = "none" | "telegram" | "manual" | "any";
export interface AdminRewardPeriod {
  id: string; name: string; startAtMs: number; endAtMs: number; timeZone: string;
  asset: AdminRewardsAsset; totalAmount: string; tiers: AdminRewardTier[];
  eligibility: {minimumPoints: string; minimumApprovedQuests: number; verification: AdminRewardVerification};
}
export interface AdminRewardPeriodDraft {
  name: string; start: string; end: string; timeZone: string; assetId: string; totalAmount: string;
  shares: [string, string, string, string]; minimumPoints: string; minimumApprovedQuests: string; verification: AdminRewardVerification;
}
export type AdminRewardValidation = Record<string, string>;
export const ADMIN_REWARD_TIERS = [{fromRank:1,toRank:1},{fromRank:2,toRank:2},{fromRank:3,toRank:3},{fromRank:4,toRank:10}] as const;
const U128_MAX = (1n << 128n) - 1n;

export function rewardsHash(value: ccc.BytesLike): ccc.Hex {
  const hex = ccc.hexFrom(value).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hex)) throw new Error("A Rewards chain identity is invalid.");
  return hex as ccc.Hex;
}
export function assertRewardsAdmin(scope: ProfileReadScope) {
  if (scope.protocolCell.cellOutput.type?.hash().toLowerCase() !== scope.protocolHash.toLowerCase() ||
    scope.walletLock.hash().toLowerCase() !== scope.lockHash.toLowerCase() ||
    !scope.protocol.protocol_config.admin_lock_hash_vec.some(value => rewardsHash(value) === scope.lockHash.toLowerCase())) {
    throw new Error("Only a current platform administrator can manage Rewards & Recognition.");
  }
}
export function rewardsConnectedCell(cell: ccc.Cell, codeHash: ccc.Hex, protocolHash: ccc.Hex): boolean {
  const type = cell.cellOutput.type;
  if (!type || type.codeHash.toLowerCase() !== codeHash.toLowerCase() || type.hashType !== "type") return false;
  try {
    const connected = ConnectedTypeID.decode(type.args);
    return rewardsHash(connected.connected_key) === protocolHash.toLowerCase() && ccc.hexFrom(ConnectedTypeID.encode(connected)).toLowerCase() === type.args.toLowerCase();
  } catch {return false;}
}

/** Published means the exact full achievement type is registered by this
 * protocol. Shared bytecode alone is never a published badge definition. */
export async function readAdminAchievements(scope: ProfileReadScope, signal?: AbortSignal): Promise<AdminAchievement[]> {
  assertRewardsAdmin(scope);
  const registered = new Set(scope.protocol.protocol_config.achievement_type_hashes.map(rewardsHash));
  if (!registered.size) return [];
  const code = rewardsHash(scope.protocol.protocol_config.script_code_hashes.ckb_boost_achievement_type_code_hash);
  const cells = await readProfilePages(scope, {script:{codeHash:code,hashType:"type",args:"0x"},scriptType:"type",scriptSearchMode:"prefix",withData:true}, `admin-rewards:definitions:${scope.protocolHash}:${code}`, signal);
  const found = new Map<string, ccc.Cell>();
  for (const cell of cells) {
    if (!rewardsConnectedCell(cell, code, scope.protocolHash)) continue;
    const typeHash = cell.cellOutput.type!.hash().toLowerCase();
    if (!registered.has(typeHash as ccc.Hex)) continue;
    if (found.has(typeHash)) throw new Error("Multiple live cells identify the same published achievement registry.");
    found.set(typeHash, cell);
  }
  if (found.size !== registered.size) throw new Error("Some registered achievement definitions are unavailable. Retry before using claim totals.");
  const result: AdminAchievement[] = [];
  for (const [typeHash, cell] of found) {
    const entries = AchievementDataVec.decode(cell.outputData);
    if (ccc.hexFrom(AchievementDataVec.encode(entries)) !== cell.outputData.toLowerCase()) throw new Error("A published achievement definition is not canonical.");
    const titles = new Set<string>();
    entries.forEach((entry,index) => {
      if (!entry.achievement_title.trim() || titles.has(entry.achievement_title)) throw new Error("Published achievement titles must identify distinct definitions in their registry.");
      titles.add(entry.achievement_title);
      const id = `${typeHash}:${index}`;
      result.push({id,title:entry.achievement_title,metadataNeventId:entry.achievement_metadata,cell,index,
        classification:entry.achievement_title === "Telegram Verification" ? "telegram-verification" : entry.achievement_title === "First Submission" ? "first-submission" : "other",
        claims:entry.receiver_user_record_vec.map((record,recordIndex) => ({
          id:`${id}:${recordIndex}`,receiverTypeHash:rewardsHash(record.receiver_user_type_hash),grantedAt:profileTimestamp(record.granted_at),grantedAtRaw:BigInt(record.granted_at).toString(),
          name:null,address:null,lockHash:null,isCurrentWallet:false,
        })),
      });
    });
  }
  return result;
}

/** User labels are optional enrichment; missing/deleted users never fabricate a
 * wallet. A receiver is matched by its complete canonical User type hash. */
export async function readAdminAchievementUsers(scope: ProfileReadScope, achievements: readonly AdminAchievement[], signal?: AbortSignal): Promise<Map<string,{name:string|null;address:string;lockHash:ccc.Hex}>> {
  assertRewardsAdmin(scope);
  const wanted = new Set(achievements.flatMap(badge => badge.claims.map(claim => claim.receiverTypeHash)));
  if (!wanted.size) return new Map();
  const code = rewardsHash(scope.protocol.protocol_config.script_code_hashes.ckb_boost_user_type_code_hash);
  const cells = await readProfilePages(scope,{script:{codeHash:code,hashType:"type",args:"0x"},scriptType:"type",scriptSearchMode:"prefix",withData:true},`admin-rewards:users:${scope.protocolHash}:${code}`,signal);
  const result = new Map<string,{name:string|null;address:string;lockHash:ccc.Hex}>();
  for (const cell of cells) {
    if (!rewardsConnectedCell(cell,code,scope.protocolHash)) continue;
    const typeHash = cell.cellOutput.type!.hash();
    if (!wanted.has(typeHash)) continue;
    if (result.has(typeHash)) throw new Error("A claim receiver has multiple live profiles; its wallet is ambiguous.");
    const user = UserData.decode(cell.outputData);
    result.set(typeHash,{name:getLatestDisplayName(user.profile_data) ?? extractIdentityDisplayName(user.verification_data.identity_verification_data),
      address:new ccc.Address(cell.cellOutput.lock,scope.network === "mainnet" ? "ckb" : "ckt").toString(),lockHash:cell.cellOutput.lock.hash()});
  }
  return result;
}

export function parseRewardAmount(value: string, decimals: number, allowZero = false): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36 || !/^\d+(?:\.\d+)?$/.test(value.trim())) throw new Error("Enter a valid non-negative decimal amount.");
  const [integer,fraction=""] = value.trim().split(".");
  if (fraction.length > decimals) throw new Error(`Use at most ${decimals} decimal places.`);
  const amount = BigInt(integer) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals,"0") || "0");
  if (amount < 0n || !allowZero && amount === 0n || amount > U128_MAX) throw new Error("The amount must fit Uint128 and be positive.");
  return amount;
}
export function formatRewardAmount(value: bigint | string, decimals: number): string {
  const amount = BigInt(value), digits = amount.toString().padStart(decimals+1,"0");
  if (!decimals) return digits;
  const fraction = digits.slice(-decimals).replace(/0+$/,"");
  return `${digits.slice(0,-decimals)}${fraction?`.${fraction}`:""}`;
}
export function periodStatus(period: Pick<AdminRewardPeriod,"startAtMs"|"endAtMs">, now: number): "upcoming" | "active" | "completed" {
  return now < period.startAtMs ? "upcoming" : now >= period.endAtMs ? "completed" : "active";
}
export async function readAdminRewardsAssets(scope:ProfileReadScope):Promise<AdminRewardsAsset[]>{
  assertRewardsAdmin(scope);
  const {udtRegistry}=await import("@/lib/services/udt-registry");
  const points=ccc.Script.from({codeHash:rewardsHash(scope.protocol.protocol_config.script_code_hashes.ckb_boost_points_udt_type_code_hash),hashType:"type",args:scope.protocolHash});
  const result:AdminRewardsAsset[]=[{id:"ckb",kind:"ckb",symbol:"CKB",decimals:8},{id:points.hash(),kind:"points",symbol:"Points",decimals:0,typeScript:{codeHash:points.codeHash,hashType:points.hashType,args:points.args}}];
  const seen=new Set(result.map(asset=>asset.id));
  for(const raw of scope.protocol.protocol_config.script_code_hashes.accepted_udt_type_scripts){
    const script=ccc.Script.from(raw),id=script.hash(),token=udtRegistry.getTokenByScriptHash(id);
    if(seen.has(id)||!token||token.network!==scope.network||!Number.isInteger(token.decimals)||token.decimals<0||token.decimals>36)continue;
    seen.add(id);result.push({id,kind:"udt",symbol:token.symbol,decimals:token.decimals,typeScript:{codeHash:script.codeHash,hashType:script.hashType,args:script.args}});
  }
  return result;
}
export function newAdminRewardPeriodDraft(): AdminRewardPeriodDraft {
  return {name:"",start:"",end:"",timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",assetId:"ckb",totalAmount:"",shares:["40","25","15","20"],minimumPoints:"0",minimumApprovedQuests:"0",verification:"none"};
}

export async function validateAdminRewardPeriod(draft: AdminRewardPeriodDraft, assets: readonly AdminRewardsAsset[], id: string): Promise<{errors:AdminRewardValidation;period:AdminRewardPeriod|null}> {
  const errors: AdminRewardValidation = {};
  if (!draft.name.trim() || draft.name.trim().length > 120) errors.name="Enter a period name of 1–120 characters.";
  const asset=assets.find(item=>item.id===draft.assetId);
  if (!asset) errors.assetId="Choose a configured reward asset.";
  let total=0n;
  try {if(asset)total=parseRewardAmount(draft.totalAmount,asset.decimals);}catch(error){errors.totalAmount=error instanceof Error?error.message:"Enter a positive prize pool.";}
  const shares=draft.shares.map((value,index)=>{try{const bps=parseRewardAmount(value,2);if(bps>10000n)throw Error();return Number(bps);}catch{errors[`share${index}`]="Enter a positive share of up to 100%.";return 0;}});
  if (!Object.keys(errors).some(key=>key.startsWith("share")) && shares.reduce((sum,value)=>sum+value,0)!==10000) errors.shares="Reward shares must total exactly 100%.";
  if (total>0n) shares.forEach((share,index)=>{if(total*BigInt(share)%10000n!==0n)errors[`share${index}`]="This share produces a fractional base-unit reward. Adjust the prize pool or share.";});
  let minimumPoints=0n, minimumApprovedQuests=0;
  try{minimumPoints=parseRewardAmount(draft.minimumPoints,0,true);}catch{errors.minimumPoints="Enter non-negative whole Points within Uint128.";}
  if (!/^\d+$/.test(draft.minimumApprovedQuests)||BigInt(draft.minimumApprovedQuests)>4294967295n) errors.minimumApprovedQuests="Enter a non-negative whole quest count within Uint32.";
  else minimumApprovedQuests=Number(draft.minimumApprovedQuests);
  if (!["none","telegram","manual","any"].includes(draft.verification)) errors.verification="Choose an account verification rule.";
  let startAtMs=0,endAtMs=0;
  const {creationUnixTime}=await import("./creation-content");
  try{startAtMs=creationUnixTime(draft.start,draft.timeZone)*1000;}catch{errors.start="Choose an unambiguous start time in the selected time zone.";}
  try{endAtMs=creationUnixTime(draft.end,draft.timeZone)*1000;}catch{errors.end="Choose an unambiguous end time in the selected time zone.";}
  if (!errors.start&&!errors.end&&endAtMs<=startAtMs) errors.end="End time must be after start time.";
  if (Object.keys(errors).length||!asset)return{errors,period:null};
  return {errors,period:{id,name:draft.name.trim(),startAtMs,endAtMs,timeZone:draft.timeZone,asset,totalAmount:total.toString(),
    tiers:ADMIN_REWARD_TIERS.map((rank,index)=>({...rank,shareBps:shares[index]})),eligibility:{minimumPoints:minimumPoints.toString(),minimumApprovedQuests,verification:draft.verification}}};
}

export function validateActivityBonus(days: string, points: string): {seconds: bigint;points:bigint} {
  if (!/^\d+$/.test(days)||BigInt(days)<=0n||BigInt(days)*86400n>(1n<<64n)-1n) throw new Error("Enter positive whole days within the supported interval.");
  return {seconds:BigInt(days)*86400n,points:parseRewardAmount(points,0)};
}
