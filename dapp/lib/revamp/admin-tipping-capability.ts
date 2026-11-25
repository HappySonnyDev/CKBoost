import {ccc} from "@ckb-ccc/connector-react";
import {ADMIN_TIP_RELEASE_PINS,type AdminTipReleasePin} from "@/lib/ckb/admin-tipping-release-pins";
import {getIsolatedRuntime,ISOLATED_QA_PINS} from "@/lib/ckb/isolated-runtime.mjs";
import {readProfilePages,withProfileDeadline,type ProfileReadScope} from "./profile-model";
import {decodeAdminRegistry,registryHash} from "./admin-registry-model";
import type {AdminRegistrySnapshot} from "./admin-registry-service";
import type {AdminTippingExecutionPolicy} from "@/lib/services/tipping-service";

const TYPE_ID="0x00000000000000000000000000000000000000000000000000545950455f4944";
const QA_LOCK="0xe91b5a78463c293318331c21d372e031eb9ffad87b379fbe0563222fcdd28815";
export const ADMIN_TIP_PAIRING_REQUIRED="Independent tip settings require the paired, reviewed Tipping/Funding contract and SDK deployment. The current VM still uses protocol settings; saving is disabled until exact code and registry capability evidence is installed.";
export interface AdminTipDeploymentManifest {
  schema:"ckboost-admin-tipping-deployment/v1";network:"testnet";releaseId:string;
  protocolTypeHash:ccc.Hex;registryTypeHash:ccc.Hex;
  scripts:Record<"tippingType"|"fundingLock"|"protocolLock",ccc.ScriptLike>;
}
export interface AdminTipCapability {available:boolean;unavailableReason:string|null;manifest:AdminTipDeploymentManifest|null}
/** A local flag or a new registry is not evidence of a deployed VM upgrade.
 * Only a source-pinned reviewed release can even start the code-cell checks. */
export function declaredAdminTipCapability(scope:ProfileReadScope,raw=process.env.NEXT_PUBLIC_CKBOOST_ADMIN_TIPPING,pins:readonly AdminTipReleasePin[]=ADMIN_TIP_RELEASE_PINS):AdminTipCapability {
  if(!raw)return {available:false,unavailableReason:ADMIN_TIP_PAIRING_REQUIRED,manifest:null};
  if(raw.length>16384)throw new Error("Oversized Admin tipping deployment manifest");
  const runtime=getIsolatedRuntime();if(!runtime||scope.network!=="testnet"||runtime.protocol.typeHash!==scope.protocolHash)throw new Error("Admin tipping V2 is limited to the exact isolated QA protocol");
  const manifest=JSON.parse(raw) as AdminTipDeploymentManifest;
  const pin=pins.find(pin=>pin.releaseId===manifest.releaseId);
  if(!pin||manifest.schema!=="ckboost-admin-tipping-deployment/v1"||manifest.network!=="testnet"||registryHash(manifest.protocolTypeHash)!==scope.protocolHash||pin.protocolTypeHash!==scope.protocolHash||pin.registryTypeHash!==registryHash(manifest.registryTypeHash))throw new Error("This Admin tipping release and registry were not reviewed for this protocol");
  const fields={tippingType:"ckb_boost_tipping_type_code_hash",fundingLock:"ckb_boost_funding_lock_code_hash",protocolLock:"ckb_boost_protocol_lock_code_hash"} as const;
  for(const name of ["tippingType","fundingLock","protocolLock"] as const){
    const script=ccc.Script.from(manifest.scripts[name]);
    if(script.codeHash!==TYPE_ID||script.hashType!=="type"||ccc.bytesFrom(script.args).length!==32||ccc.hexFrom(scope.protocol.protocol_config.script_code_hashes[fields[name]])!==script.hash())throw new Error("A V2 code identity does not match the current protocol");
    if(name==="protocolLock"&&script.hash()!==QA_LOCK)throw new Error("Only the dedicated QA Protocol Lock can be upgraded");
    if(name!=="protocolLock"&&ISOLATED_QA_PINS.some((shared:{codeHash:string})=>shared.codeHash===script.hash()))throw new Error("Shared historical Tip/Funding code cannot be installed as independent V2 code");
    registryHash(pin.dataHashes[name]);
  }
  return {available:true,unavailableReason:null,manifest};
}
/** Full live code/data identity proof, independent of an environment flag. */
export async function readAdminTipCapability(scope:ProfileReadScope,registry:AdminRegistrySnapshot,signal?:AbortSignal):Promise<AdminTipCapability> {
  const declared=declaredAdminTipCapability(scope);if(!declared.available||!declared.manifest)return declared;
  const manifest=declared.manifest,pin=ADMIN_TIP_RELEASE_PINS.find(pin=>pin.releaseId===manifest.releaseId)!;
  if(!registry.available||!registry.cell||!registry.data||registry.cell.cellOutput.type?.hash()!==manifest.registryTypeHash||!registry.cell.cellOutput.lock.eq(registry.cell.cellOutput.type!)||registry.data.protocolTypeHash!==scope.protocolHash)throw new Error("The reviewed tipping policy registry is not the current exact registry");
  await Promise.all((["tippingType","fundingLock","protocolLock"] as const).map(async name=>{
    const type=ccc.Script.from(manifest.scripts[name]);
    const cells=(await readProfilePages(scope,{script:type,scriptType:"type",scriptSearchMode:"exact",withData:true},`admin-tip-capability:${scope.protocolHash}:${type.hash()}`,signal)).filter(cell=>cell.cellOutput.type?.eq(type));
    if(cells.length!==1||ccc.hashCkb(cells[0].outputData)!==pin.dataHashes[name])throw new Error(`The ${name} executable is missing, ambiguous or differs from the reviewed release`);
    const live=await withProfileDeadline(()=>scope.client.getCellLive(cells[0].outPoint),signal);
    if(!live||!live.outPoint.eq(cells[0].outPoint)||!live.cellOutput.type?.eq(type)||ccc.hashCkb(live.outputData)!==pin.dataHashes[name])throw new Error(`The reviewed ${name} executable is no longer live`);
  }));
  return declared;
}
/** Signed time is an application policy assertion. CKB has no trustless VM
 * wall clock/upper-bound expiry opcode; this does not claim otherwise. */
export async function makeAdminTipExecutionPolicy(scope:ProfileReadScope,registry:AdminRegistrySnapshot,signal?:AbortSignal):Promise<AdminTippingExecutionPolicy|null> {
  const capability=await readAdminTipCapability(scope,registry,signal);if(!capability.available)return null;
  const header=await scope.client.getTipHeader(),now=Date.now(),at=header?Number(header.timestamp):NaN;
  if(!Number.isSafeInteger(at)||Math.abs(now-at)>600_000)throw new Error("The latest Testnet header or local clock is too stale to sign a tip approval");
  const data=decodeAdminRegistry(registry.cell!.outputData);if(data.protocolTypeHash!==scope.protocolHash)throw new Error("Foreign tipping registry");
  return {protocolTypeHash:scope.protocolHash,registryTypeHash:capability.manifest!.registryTypeHash,registryCell:registry.cell!,declaredAtMs:BigInt(Math.max(now,at))};
}
