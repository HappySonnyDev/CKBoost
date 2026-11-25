import {ccc} from "@ckb-ccc/connector-react";
import {ConnectedTypeID,ProtocolData,TippingData,type TippingDataLike} from "ssri-ckboost/types";
import {isOverviewAdmin,type AdminTippingRecord} from "./admin-overview-model";
import {profileTimestamp,readProfilePages,withProfileDeadline,type ProfileReadScope} from "./profile-model";
import {encodeAdminRegistry,registryHash,type AdminTipSettings} from "./admin-registry-model";
import {formatRewardAmount,parseRewardAmount,type AdminRewardsAsset} from "./admin-rewards-model";
import {udtRegistry} from "@/lib/services/udt-registry";
import {coalesceDiscoveryRead,runDiscoveryRequest} from "./discovery-loader";
import {declaredAdminTipCapability,ADMIN_TIP_PAIRING_REQUIRED} from "./admin-tipping-capability";
import type {AdminTipCapability} from "./admin-tipping-capability";
import type {AdminRegistrySnapshot} from "./admin-registry-service";

export interface AdminTipReward {asset:AdminRewardsAsset;amount:bigint;precisionKnown:boolean}
export interface AdminTipPerson {lockHash:ccc.Hex;name:string|null;address:string|null}
export interface AdminTipRow extends AdminTippingRecord {
  title:string;summary:string;createdAt:number|null;proposer:AdminTipPerson;recipient:AdminTipPerson;
  rewards:AdminTipReward[];requiredApprovals:number;supporters:ccc.Hex[];
  status:"pending"|"endorsing"|"granted"|"expired";expiresAt:number|null;
}
export interface AdminTipPool {ckb:bigint;udts:Array<{asset:AdminRewardsAsset;amount:bigint;precisionKnown:boolean}>;cells:ccc.Cell[]}
export interface AdminTipHistory {id:string;kind:"created"|"approved"|"endorsed"|"granted";actorLockHash:ccc.Hex|null;at:number;transactionHash:ccc.Hex}
export interface AdminTipDraft {title:string;recipient:string;summary:string;rewards:Array<{assetId:string;amount:string}>}
export interface AdminTipSettingsDraft {expirationDays:string;approverLockHashes:string[];thresholdsCkb:string[]}
export const ADMIN_TIP_REGISTRY_UPGRADE_REQUIRED=ADMIN_TIP_PAIRING_REQUIRED;
/** Declaration is only a prerequisite. Writes additionally verify every live
 * executable and the exact registry with readAdminTipCapability. */
export function adminTipRegistryCapability(scope:ProfileReadScope):{available:boolean;unavailableReason:string|null} {return declaredAdminTipCapability(scope);}
export function assertTippingProtocolScope(scope:ProfileReadScope) {
  if(scope.protocolCell.cellOutput.type?.hash()!==scope.protocolHash||ccc.hexFrom(ProtocolData.encode(scope.protocol))!==scope.protocolCell.outputData||scope.walletLock.hash()!==scope.lockHash||scope.client.addressPrefix!==(scope.network==="testnet"?"ckt":"ckb"))throw new Error("The tipping scope does not match its canonical protocol, wallet and network.");
}
export function assertTippingAdmin(scope:ProfileReadScope) {assertTippingProtocolScope(scope);if (!isOverviewAdmin(scope)) throw new Error("Only current platform administrators can manage tip proposals.");}
/** This is a detail-only role. A whitelist entry is effective only after the
 * caller obtains the actual complete code/registry capability proof. */
export function isProtocolTipApprover(scope:ProfileReadScope,registry:AdminRegistrySnapshot,capability:AdminTipCapability):boolean {
  assertTippingProtocolScope(scope);
  return Boolean(capability.available&&capability.manifest&&capability.manifest.protocolTypeHash===scope.protocolHash&&registry.available&&registry.cell&&registry.data&&registry.data.protocolTypeHash===scope.protocolHash&&encodeAdminRegistry(registry.data)===registry.cell.outputData&&registry.cell.cellOutput.type?.hash()===capability.manifest.registryTypeHash&&registry.cell.cellOutput.lock.eq(registry.cell.cellOutput.type!)&&registry.data.tipping.approverLockHashes.includes(scope.lockHash));
}
export function assertProtocolTipSupport(scope:ProfileReadScope,record:AdminTippingRecord,registry:AdminRegistrySnapshot,capability:AdminTipCapability):void {
  assertTippingProtocolScope(scope);if(adminTipId(scope,record.cell)!==record.id)throw new Error("The proposal does not belong to this protocol.");
  if(isOverviewAdmin(scope))return;
  if(!isProtocolTipApprover(scope,registry,capability))throw new Error("This wallet is not a current verified tip approver.");
  if(!record.data.supporter_lock_hashes.length)throw new Error("The first approval must be given by a current platform Admin.");
}
export function adminTipAssets(scope:ProfileReadScope):AdminRewardsAsset[] {
  const codes=scope.protocol.protocol_config.script_code_hashes;
  const points=ccc.Script.from({codeHash:ccc.hexFrom(codes.ckb_boost_points_udt_type_code_hash),hashType:"type",args:scope.protocolHash});
  const assets:AdminRewardsAsset[]=[{id:"points",kind:"points",symbol:"Points",decimals:0,typeScript:{codeHash:points.codeHash,hashType:points.hashType,args:points.args}},{id:"ckb",kind:"ckb",symbol:"CKB",decimals:8}];
  for (const script of codes.accepted_udt_type_scripts) {
    const type=ccc.Script.from(script), token=udtRegistry.getTokenByScriptHash(type.hash());
    if (type.eq(points) || assets.some(asset=>asset.id===type.hash()) || !token || token.network!==scope.network) continue;
    assets.push({id:type.hash(),kind:"udt",symbol:token.symbol,decimals:token.decimals,typeScript:{codeHash:type.codeHash,hashType:type.hashType,args:type.args}});
  }
  return assets;
}
export function canonicalAdminTipAsset(scope:ProfileReadScope, asset:AdminRewardsAsset):AdminRewardsAsset {
  assertTippingAdmin(scope);return canonicalProtocolTipAsset(scope,asset);
}
export function canonicalProtocolTipAsset(scope:ProfileReadScope, asset:AdminRewardsAsset):AdminRewardsAsset {
  assertTippingProtocolScope(scope);const configured=adminTipAssets(scope).find(value=>value.id===asset.id);
  if(!configured||configured.kind!==asset.kind||configured.decimals!==asset.decimals||configured.kind!=="ckb"&&(!configured.typeScript||!asset.typeScript||!ccc.Script.from(configured.typeScript).eq(asset.typeScript)))throw new Error("The selected asset does not match this protocol's complete configured asset identity.");
  return configured;
}
/** A deposit is a net increase in the exact pool, not a recycled pool output.
 * All inputs come from canonical parent transactions; require this Admin's
 * plain native capacity spend and, for UDTs, its own exact asset net spend. */
export async function readAdminTipDepositDelta(scope:ProfileReadScope,transaction:ccc.Transaction,asset:AdminRewardsAsset,signal?:AbortSignal):Promise<bigint> {
  assertTippingAdmin(scope);return readProtocolTipDepositDelta(scope,transaction,asset,signal);
}
export async function readProtocolTipTransactionInputs(scope:ProfileReadScope,transaction:ccc.Transaction,signal?:AbortSignal):Promise<ccc.Cell[]> {
  assertTippingProtocolScope(scope);
  const hashes=[...new Set(transaction.inputs.map(input=>input.previousOutput.txHash))];if(hashes.length>100)throw new Error("Transaction evidence exceeds the 100-parent proof budget.");
  const parents=new Map(await Promise.all(hashes.map(async hash=>{
    const parent=await withProfileDeadline(()=>coalesceDiscoveryRead(scope.client,`admin-tip-parent:${hash}`,()=>runDiscoveryRequest(scope.client,()=>scope.client.getTransaction(hash),{signal})),signal);
    if(signal?.aborted)throw new Error("The confirmation check expired.");
    if(!parent||parent.status!=="committed"||parent.transaction.hash()!==hash)throw new Error("A deposit input parent could not be verified.");return [hash,parent.transaction] as const;
  })));
  return transaction.inputs.map(input=>{const parent=parents.get(input.previousOutput.txHash)!,index=Number(input.previousOutput.index),cellOutput=parent.outputs[index],outputData=parent.outputsData[index];if(!cellOutput||outputData===undefined)throw new Error("A transaction input points outside its canonical parent.");return ccc.Cell.from({outPoint:input.previousOutput,cellOutput,outputData});});
}
export function assertProtocolTipActorSpend(scope:ProfileReadScope,transaction:ccc.Transaction,inputs:readonly ccc.Cell[]):void {
  const ownInputs=inputs.filter(cell=>cell.cellOutput.lock.eq(scope.walletLock)),ownOutputs=transaction.outputs.filter(output=>output.lock.eq(scope.walletLock));
  if(!ownInputs.some(cell=>!cell.cellOutput.type&&cell.outputData==="0x")||ownInputs.reduce((sum,cell)=>sum+cell.cellOutput.capacity,0n)<=ownOutputs.reduce((sum,output)=>sum+output.capacity,0n))throw new Error("The transaction does not prove this wallet's signed native capacity spend.");
}
/** Confirmation-only public evidence reader; it grants no permission to fund. */
export async function readProtocolTipDepositDelta(scope:ProfileReadScope,transaction:ccc.Transaction,asset:AdminRewardsAsset,signal?:AbortSignal):Promise<bigint> {
  const configured=canonicalProtocolTipAsset(scope,asset); if(configured.kind==="points")throw new Error("Points cannot be deposited into the tip pool.");
  const lock=ccc.Script.from({codeHash:ccc.hexFrom(scope.protocol.protocol_config.script_code_hashes.ckb_boost_funding_lock_code_hash),hashType:"type",args:scope.protocolHash});
  const inputs=(await readProtocolTipTransactionInputs(scope,transaction,signal)).map(cell=>({output:cell.cellOutput,outputData:cell.outputData}));
  const outputs=transaction.outputs.map((output,index)=>({output,outputData:transaction.outputsData[index]}));
  const amount=(cell:{output:ccc.CellOutput;outputData:ccc.Hex})=>{
    if(configured.kind==="ckb")return !cell.output.type&&cell.outputData==="0x"?cell.output.capacity:0n;
    if(!cell.output.type?.eq(configured.typeScript!))return 0n; if(ccc.bytesFrom(cell.outputData).length!==16)throw new Error("The deposit contains malformed matching asset data."); return ccc.numLeFromBytes(cell.outputData);
  };
  const actorInputs=inputs.filter(cell=>cell.output.lock.eq(scope.walletLock)),actorOutputs=outputs.filter(cell=>cell.output.lock.eq(scope.walletLock));
  if(!actorInputs.some(cell=>!cell.output.type&&cell.outputData==="0x")||actorInputs.reduce((sum,cell)=>sum+cell.output.capacity,0n)<=actorOutputs.reduce((sum,cell)=>sum+cell.output.capacity,0n))throw new Error("The deposit does not prove this Admin's signed native capacity spend.");
  const delta=outputs.filter(cell=>cell.output.lock.eq(lock)).reduce((sum,cell)=>sum+amount(cell),0n)-inputs.filter(cell=>cell.output.lock.eq(lock)).reduce((sum,cell)=>sum+amount(cell),0n);
  if(configured.kind!=="ckb"&&actorInputs.reduce((sum,cell)=>sum+amount(cell),0n)-actorOutputs.reduce((sum,cell)=>sum+amount(cell),0n)<delta)throw new Error("The deposited asset was not supplied by this Admin wallet.");
  return delta;
}
export function legacyTipSettings(scope:ProfileReadScope):AdminTipSettings {
  return {expirationSeconds:ccc.numFrom(scope.protocol.tipping_config.expiration_duration).toString(),thresholdsShannons:scope.protocol.tipping_config.approval_requirement_thresholds.map(value=>ccc.numFrom(value).toString()).sort((a,b)=>BigInt(a)<BigInt(b)?-1:1),approverLockHashes:scope.protocol.endorsers_whitelist.map(value=>registryHash(ccc.hexFrom(value.endorser_lock_hash)))};
}
export function adminTipId(scope:ProfileReadScope,cell:ccc.Cell):ccc.Hex|null {
  const type=cell.cellOutput.type;
  if (!type||type.hashType!=="type"||type.codeHash!==ccc.hexFrom(scope.protocol.protocol_config.script_code_hashes.ckb_boost_tipping_type_code_hash)) return null;
  try {const id=ConnectedTypeID.decode(type.args);return ccc.hexFrom(id.connected_key)===scope.protocolHash&&ccc.hexFrom(ConnectedTypeID.encode(id))===type.args?registryHash(ccc.hexFrom(id.type_id)):null;}catch{return null;}
}
export async function readAdminTips(scope:ProfileReadScope,id?:string,signal?:AbortSignal):Promise<AdminTippingRecord[]> {
  assertTippingAdmin(scope);
  return readTips(scope,id,signal);
}
/** Public chain read, scoped to one exact proposal; never enumerates Users or
 * changes the administrative role of its caller. */
export async function readProtocolTip(scope:ProfileReadScope,id:string,signal?:AbortSignal):Promise<AdminTippingRecord[]> {
  assertTippingProtocolScope(scope);return readTips(scope,registryHash(id),signal);
}
async function readTips(scope:ProfileReadScope,id?:string,signal?:AbortSignal):Promise<AdminTippingRecord[]> {
  const codeHash=ccc.hexFrom(scope.protocol.protocol_config.script_code_hashes.ckb_boost_tipping_type_code_hash);
  const args=id?ccc.hexFrom(ConnectedTypeID.encode({type_id:registryHash(id),connected_key:scope.protocolHash})):"0x";
  const cells=await readProfilePages(scope,{script:{codeHash,hashType:"type",args},scriptType:"type",scriptSearchMode:id?"exact":"prefix",withData:true},`admin-tips:${scope.protocolHash}:${id??"all"}`,signal);
  const result=cells.filter(cell=>adminTipId(scope,cell)).map(cell=>({id:adminTipId(scope,cell)!,cell,data:TippingData.decode(cell.outputData)}));
  if (new Set(result.map(item=>item.id)).size!==result.length) throw new Error("Multiple live cells identify one proposal. Reload before reviewing.");
  return result.sort((a,b)=>(profileTimestamp(b.data.metadata.creation_timestamp)??0)-(profileTimestamp(a.data.metadata.creation_timestamp)??0));
}
function assetForScript(scope:ProfileReadScope,type:ccc.Script):{asset:AdminRewardsAsset;precisionKnown:boolean} {
  const known=adminTipAssets(scope).find(asset=>asset.typeScript&&type.eq(asset.typeScript));
  return known?{asset:known,precisionKnown:true}:{asset:{id:type.hash(),kind:"udt",symbol:`Asset ${type.hash().slice(0,10)}…`,decimals:0,typeScript:{codeHash:type.codeHash,hashType:type.hashType,args:type.args}},precisionKnown:false};
}
export function tipRewards(scope:ProfileReadScope,rewards:ReturnType<typeof TippingData.decode>["rewards"]):AdminTipReward[] {
  const assets=adminTipAssets(scope),result:AdminTipReward[]=[];
  if(rewards.points_amount>0n)result.push({asset:assets[0],amount:rewards.points_amount,precisionKnown:true});
  if(rewards.ckb_amount>0n)result.push({asset:assets[1],amount:rewards.ckb_amount,precisionKnown:true});
  for(const value of rewards.udt_assets) {const info=assetForScript(scope,ccc.Script.from(value.udt_script));result.push({...info,amount:ccc.numFrom(value.amount)});}
  return result;
}
export function buildAdminTipRows(scope:ProfileReadScope,records:readonly AdminTippingRecord[],settings:AdminTipSettings,people:ReadonlyMap<string,AdminTipPerson>=new Map(),now=Date.now()):AdminTipRow[] {
  assertTippingAdmin(scope);
  return buildProtocolTipRows(scope,records,settings,people,now);
}
export function buildProtocolTipRows(scope:ProfileReadScope,records:readonly AdminTippingRecord[],settings:AdminTipSettings,people:ReadonlyMap<string,AdminTipPerson>=new Map(),now=Date.now()):AdminTipRow[] {
  assertTippingProtocolScope(scope);
  return records.map(record=>{
    if(adminTipId(scope,record.cell)!==record.id)throw new Error("Proposal identity changed.");
    const supporters=record.data.supporter_lock_hashes.map(hash=>registryHash(ccc.hexFrom(hash)));
    if(new Set(supporters).size!==supporters.length)throw new Error("Duplicate supporters make this proposal's progress invalid.");
    const requiredApprovals=1+settings.thresholdsShannons.filter(value=>record.data.rewards.ckb_amount>=BigInt(value)).length;
    const createdAt=profileTimestamp(record.data.metadata.creation_timestamp),duration=BigInt(settings.expirationSeconds),expiration=createdAt===null||duration===0n?null:BigInt(createdAt)+duration*1000n;
    const expiresAt=expiration!==null&&expiration<=BigInt(Number.MAX_SAFE_INTEGER)?Number(expiration):null;
    const proposerHash=registryHash(ccc.hexFrom(record.data.proposer_lock_hash)),recipientHash=registryHash(ccc.hexFrom(record.data.target_lock_hash));
    const granted=record.data.status==="granted";
    if(granted&&(supporters.length<requiredApprovals||!profileTimestamp(record.data.granted_at)))throw new Error("The granted proposal has incomplete approval evidence.");
    return {...record,title:record.data.metadata.contribution_title,summary:record.data.metadata.short_description,createdAt,
      proposer:people.get(proposerHash)??{lockHash:proposerHash,name:null,address:null},recipient:people.get(recipientHash)??{lockHash:recipientHash,name:null,address:null},
      supporters,requiredApprovals,rewards:tipRewards(scope,record.data.rewards),expiresAt,
      status:granted?"granted":expiresAt!==null&&now>=expiresAt?"expired":supporters.length?"endorsing":"pending"};
  });
}
export async function readAdminTipPool(scope:ProfileReadScope,signal?:AbortSignal):Promise<AdminTipPool> {
  assertTippingAdmin(scope);return readProtocolTipPool(scope,signal);
}
export async function readProtocolTipPool(scope:ProfileReadScope,signal?:AbortSignal):Promise<AdminTipPool> {
  assertTippingProtocolScope(scope);const lock=ccc.Script.from({codeHash:ccc.hexFrom(scope.protocol.protocol_config.script_code_hashes.ckb_boost_funding_lock_code_hash),hashType:"type",args:scope.protocolHash});
  const cells=(await readProfilePages(scope,{script:lock,scriptType:"lock",scriptSearchMode:"exact",withData:true},`admin-tip-pool:${scope.protocolHash}:${lock.hash()}`,signal)).filter(cell=>cell.cellOutput.lock.eq(lock));
  const accepted=new Set(scope.protocol.protocol_config.script_code_hashes.accepted_udt_type_scripts.map(script=>ccc.Script.from(script).hash()));
  const udts=new Map<string,AdminTipPool["udts"][number]>();let ckb=0n;
  for(const cell of cells) {const type=cell.cellOutput.type;if(!type){if(cell.outputData!=="0x")continue;ckb+=cell.cellOutput.capacity;continue;}if(!accepted.has(type.hash()))continue;
    const bytes=ccc.bytesFrom(cell.outputData);if(bytes.length!==16)throw new Error("A pool asset has invalid Uint128 data. Pool balances are unavailable.");
    const info=assetForScript(scope,type),previous=udts.get(type.hash());udts.set(type.hash(),{...info,amount:(previous?.amount??0n)+ccc.numLeFromBytes(bytes)});
  }
  // Include configured, known zero balances so switching tokens does not hide
  // supported assets. Their typed cell capacity never counts as spendable CKB.
  for(const asset of adminTipAssets(scope).filter(asset=>asset.kind==="udt"))if(!udts.has(asset.id))udts.set(asset.id,{asset,amount:0n,precisionKnown:true});
  return {ckb,udts:[...udts.values()],cells};
}
export function tipShortfalls(row:AdminTipRow,pool:AdminTipPool):AdminTipReward[] {
  return row.rewards.flatMap(reward=>{if(reward.asset.kind==="points")return [];const available=reward.asset.kind==="ckb"?pool.ckb:pool.udts.find(value=>value.asset.id===reward.asset.id)?.amount??0n;
    let required=reward.amount;if(reward.asset.kind==="ckb"&&available>required){const native=pool.cells.find(cell=>!cell.cellOutput.type&&cell.outputData==="0x");if(native){const reserve=ccc.CellOutput.from({lock:native.cellOutput.lock},"0x").capacity;if(available-required<reserve)required+=reserve;}}
    return required>available?[{...reward,amount:required-available}]:[];});
}
export function tipRewardLabel(reward:AdminTipReward):string {return `${formatRewardAmount(reward.amount,reward.asset.decimals)} ${reward.precisionKnown?reward.asset.symbol:"base units"}`;}
export function validateAdminTipDraft(draft:AdminTipDraft,assets:readonly AdminRewardsAsset[]):Record<string,string> {
  const errors:Record<string,string>={};
  if(!draft.title.trim()||draft.title.length>200)errors.title="Enter a title of 1–200 characters.";
  if(!draft.recipient.trim())errors.recipient="Enter the recipient's complete CKB address.";
  if(!draft.summary.trim()||draft.summary.length>4000)errors.summary="Enter a contribution summary of 1–4,000 characters.";
  const ids=new Set<string>();let positive=false;
  draft.rewards.forEach((reward,index)=>{const asset=assets.find(asset=>asset.id===reward.assetId);if(!asset||ids.has(reward.assetId)){errors[`reward-${index}`]="Choose a supported asset once.";return;}ids.add(reward.assetId);try{const amount=parseRewardAmount(reward.amount,asset.decimals,true);if(asset.kind==="ckb"&&amount>0n&&amount<10_000_000_000n)throw new Error("CKB rewards must be at least 100 CKB.");if(amount>0n)positive=true;}catch(error){errors[`reward-${index}`]=error instanceof Error?error.message:"Invalid reward amount.";}});
  if(!positive)errors.rewards="Add at least one reward with an amount greater than zero.";
  return errors;
}
export async function makeAdminTipData(scope:ProfileReadScope,draft:AdminTipDraft,now=Date.now()):Promise<TippingDataLike> {
  assertTippingAdmin(scope);const assets=adminTipAssets(scope),errors=validateAdminTipDraft(draft,assets);if(Object.keys(errors).length)throw new Error(Object.values(errors)[0]);
  const address=await ccc.Address.fromString(draft.recipient.trim(),scope.client);
  const result:TippingDataLike={target_lock_hash:address.script.hash(),proposer_lock_hash:scope.lockHash,supporter_lock_hashes:[],metadata:{contribution_title:draft.title.trim(),short_description:draft.summary.trim(),long_description:"",contribution_type_tags:[],creation_timestamp:BigInt(now)},rewards:{points_amount:0n,ckb_amount:0n,udt_assets:[],nft_assets:[]},status:"created",granted_at:0n};
  for(const reward of draft.rewards){const asset=assets.find(asset=>asset.id===reward.assetId)!,amount=parseRewardAmount(reward.amount,asset.decimals,true);if(!amount)continue;if(asset.kind==="points")result.rewards.points_amount=amount;else if(asset.kind==="ckb")result.rewards.ckb_amount=amount;else result.rewards.udt_assets.push({udt_script:asset.typeScript!,amount});}
  return result;
}
export function validateTipSettingsDraft(draft:AdminTipSettingsDraft,previous?:AdminTipSettings):AdminTipSettings {
  const preserveCurrent=Boolean(previous&&draft.expirationDays===`current:${previous.expirationSeconds}`);
  if(!preserveCurrent&&!["3","7","14","30","never"].includes(draft.expirationDays))throw new Error("Choose 3, 7, 14 or 30 days, or preserve the exact current validity period.");
  const hashes=draft.approverLockHashes.map(registryHash);if(new Set(hashes).size!==hashes.length)throw new Error("This tip approver has already been added.");
  const values=draft.thresholdsCkb.map(value=>parseRewardAmount(value,8));values.sort((a,b)=>a<b?-1:a>b?1:0);
  if(new Set(values.map(String)).size!==values.length||values.length>32)throw new Error("Approval thresholds must be positive, unique and limited to 32 rules.");
  return {expirationSeconds:preserveCurrent?previous!.expirationSeconds:draft.expirationDays==="never"?"0":(BigInt(draft.expirationDays)*86400n).toString(),approverLockHashes:hashes,thresholdsShannons:values.map(String)};
}
/** Prove history from the exact tip's committed input/output chain. A display
 * timestamp or the latest cell's tx alone cannot identify an approving actor. */
export async function readAdminTipHistory(scope:ProfileReadScope,record:AdminTippingRecord,signal?:AbortSignal):Promise<AdminTipHistory[]> {
  assertTippingAdmin(scope);return readProtocolTipHistory(scope,record,signal);
}
export async function readProtocolTipHistory(scope:ProfileReadScope,record:AdminTippingRecord,signal?:AbortSignal):Promise<AdminTipHistory[]> {
  assertTippingProtocolScope(scope);if(adminTipId(scope,record.cell)!==record.id)throw new Error("Invalid proposal history scope.");
  const type=record.cell.cellOutput.type!;let cursor:ccc.Cell|null=record.cell;const seen=new Set<string>(),history:AdminTipHistory[]=[];
  for(let depth=0;cursor&&depth<64;depth++) {
    const current:ccc.Cell=cursor;if(seen.has(current.outPoint.txHash))throw new Error("A proposal history cycle was detected.");seen.add(current.outPoint.txHash);
    const response:Awaited<ReturnType<ccc.Client["getTransaction"]>>=await withProfileDeadline(()=>scope.client.getTransaction(current.outPoint.txHash),signal);
    if(!response||response.status!=="committed"||response.blockNumber==null||response.transaction.hash()!==current.outPoint.txHash)throw new Error("A proposal history transaction is not confirmed.");
    const tx:ccc.Transaction=response.transaction,index=Number(current.outPoint.index);if(!tx.outputs[index]?.type?.eq(type)||tx.outputsData[index]!==current.outputData)throw new Error("The proposal history output does not match.");
    const header=await withProfileDeadline(()=>scope.client.getHeaderByNumber(response.blockNumber!),signal);if(!header||header.number!==response.blockNumber||response.blockHash&&header.hash!==response.blockHash)throw new Error("The proposal block timestamp could not be proved.");
    const at=Number(header.timestamp);if(!Number.isSafeInteger(at)||at<=0)throw new Error("Invalid proposal block timestamp.");
    const data=TippingData.decode(current.outputData);
    const parents:ccc.Cell[]=await Promise.all(tx.inputs.map(async input=>{const parent=await withProfileDeadline(()=>scope.client.getTransaction(input.previousOutput.txHash),signal);if(!parent||parent.transaction.hash()!==input.previousOutput.txHash)throw new Error("A proposal history input could not be verified.");const output=parent.transaction.outputs[Number(input.previousOutput.index)],outputData=parent.transaction.outputsData[Number(input.previousOutput.index)];if(!output||outputData==null)throw new Error("A proposal history input is missing.");return ccc.Cell.from({outPoint:input.previousOutput,cellOutput:output,outputData});}));
    const previous:ccc.Cell[]=parents.filter(cell=>cell.cellOutput.type?.eq(type));if(previous.length>1)throw new Error("Ambiguous proposal history.");
    const inputData=previous[0]?TippingData.decode(previous[0].outputData):null;
    if(!inputData){if(!tx.inputs[0]||ccc.hashTypeId(tx.inputs[0],index)!==record.id)throw new Error("The earliest history does not prove proposal creation.");history.push({id:`${tx.hash()}:created`,kind:"created",actorLockHash:registryHash(ccc.hexFrom(data.proposer_lock_hash)),at,transactionHash:tx.hash()});cursor=null;continue;}
    const old=new Set(inputData.supporter_lock_hashes.map(value=>ccc.hexFrom(value))),added=data.supporter_lock_hashes.map(value=>registryHash(ccc.hexFrom(value))).filter(value=>!old.has(value));
    if(added.length!==1||data.supporter_lock_hashes.length!==inputData.supporter_lock_hashes.length+1||inputData.supporter_lock_hashes.some((value,i)=>ccc.hexFrom(value)!==ccc.hexFrom(data.supporter_lock_hashes[i])))throw new Error("The historical endorsement change is ambiguous.");
    const actor=added[0],spent=parents.filter(cell=>cell.cellOutput.lock.hash()===actor).reduce((sum,cell)=>sum+cell.cellOutput.capacity,0n),returned=tx.outputs.filter(output=>output.lock.hash()===actor).reduce((sum,output)=>sum+output.capacity,0n);
    if(spent<=returned)throw new Error("The approval actor's signed capacity spend could not be proven.");
    history.push({id:`${tx.hash()}:support`,kind:old.size?"endorsed":"approved",actorLockHash:actor,at,transactionHash:tx.hash()});
    if(data.status==="granted"&&inputData.status!=="granted")history.push({id:`${tx.hash()}:granted`,kind:"granted",actorLockHash:actor,at,transactionHash:tx.hash()});
    cursor=previous[0];
  }
  if(cursor)throw new Error("Proposal history exceeds the 64-update proof budget.");return history.sort((a,b)=>a.at-b.at||(a.kind==="granted"?1:b.kind==="granted"?-1:0));
}
