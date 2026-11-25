import {ccc} from "@ckb-ccc/connector-react";
import {ProtocolData} from "ssri-ckboost/types";
import {getIsolatedRuntime} from "@/lib/ckb/isolated-runtime.mjs";
import {ADMIN_TIPPING_RELEASE} from "../../../contracts/admin-tipping/release-pins.mjs";
import {PERMISSION_REVIEW_RELEASES} from "../ckb/permissions-release-pins.mjs";
import {UPGRADE_OWNER} from "./testnet-permission-upgrade";
import {assertAdminUpgradeQa,confirmAdminRegistryUpgrade,validateAdminRegistryUpgradePlan,type AdminRegistryUpgradeConfirmation} from "./testnet-admin-upgrade";
import {buildAdminFinancialCodePlan,validateAdminFinancialBinaries,type AdminFinancialBinaries,type AdminFinancialCodePlan} from "./testnet-admin-financial-upgrade";
import {withProfileDeadline} from "./profile-model";

export const FINANCIAL_REVIEW_IDS=["tippingType","fundingLock","protocolLock"] as const;
export type FinancialReviewId=typeof FINANCIAL_REVIEW_IDS[number];
const TYPE_ID="0x00000000000000000000000000000000000000000000000000545950455f4944";
const MAX_FEE=100_000_000n;
const owner=ccc.Script.from(UPGRADE_OWNER);
const assert:(condition:unknown,message:string)=>asserts condition=(condition,message)=>{if(!condition)throw new Error(message);};
const point=(cell:ccc.Cell)=>`${cell.outPoint.txHash}:${cell.outPoint.index}`;
const sameCell=(a:ccc.Cell,b:ccc.Cell)=>a.outPoint.eq(b.outPoint)&&ccc.hexFrom(a.cellOutput.toBytes())===ccc.hexFrom(b.cellOutput.toBytes())&&a.outputData===b.outputData;

export function validateFinancialReviewFile(id:FinancialReviewId,input:Uint8Array):ccc.Hex {
  const data=ccc.bytesFrom(input),view=new DataView(data.buffer,data.byteOffset,data.byteLength);
  assert(data.length===ADMIN_TIPPING_RELEASE.byteLengths[id]&&ccc.hashCkb(data)===ADMIN_TIPPING_RELEASE.dataHashes[id],`The ${id} file does not match the reviewed Registry-bound release size and hash.`);
  assert(data.length>=24&&data[0]===0x7f&&data[1]===0x45&&data[2]===0x4c&&data[3]===0x46&&data[4]===2&&data[5]===1&&view.getUint16(16,true)===2&&view.getUint16(18,true)===243&&view.getUint32(20,true)===1,"Expected the reviewed little-endian RISC-V ELF executable.");
  return ccc.hexFrom(data);
}
export interface FinancialReviewSnapshot {
  protocolCell:ccc.Cell;oldProtocolCode:ccc.Cell;fundingCells:ccc.Cell[];
  registryCode:AdminRegistryUpgradeConfirmation;registryState:AdminRegistryUpgradeConfirmation|null;
  registryConfirmed:boolean;ownerMatches:boolean;liveBalanceShannons:string;
  capacityIncreaseShannons:string;minimumChangeShannons:string;feeBudgetShannons:string;
  registryOutstandingShannons:string;additionalCapacityEstimateShannons:string;
  blockedReasons:string[];checkedAt:string;
}
/** Public reads only. This helper has no signer and cannot prepare a wallet,
 * sign, send, deploy, mutate a runtime or select a non-QA protocol. */
export async function readAdminFinancialReview(client:ccc.Client,connectedLock:ccc.ScriptLike|null,isCurrent:()=>boolean=()=>true):Promise<FinancialReviewSnapshot> {
  assertAdminUpgradeQa(client);
  return withProfileDeadline(async signal=>{
    const check=()=>assert(!signal.aborted&&isCurrent(),"The wallet, network or review changed. Retry the read-only review.");
    const read=async<T>(operation:()=>Promise<T>)=>{check();const result=await operation();check();return result;};
    const runtime=getIsolatedRuntime()!,fixed=validateAdminRegistryUpgradePlan(),protocolType=ccc.Script.from(runtime.protocol.typeScript as ccc.ScriptLike);
    assert(protocolType.hash()===ADMIN_TIPPING_RELEASE.protocolTypeHash&&protocolType.eq(fixed.source.protocol.typeScript as ccc.ScriptLike),"The runtime does not identify the exact reviewed QA protocol.");
    const parents=new Map<string,Promise<ccc.Transaction>>();
    async function canonicalCell(indexed:ccc.Cell):Promise<ccc.Cell>{
      let parent=parents.get(indexed.outPoint.txHash);if(!parent){parent=read(()=>client.getTransaction(indexed.outPoint.txHash)).then(response=>{assert(response?.status==="committed"&&response.blockNumber!=null&&response.transaction.hash()===indexed.outPoint.txHash,"A current input has no canonical committed parent transaction.");return ccc.Transaction.fromBytes(response.transaction.toBytes());});parents.set(indexed.outPoint.txHash,parent);}
      const transaction=await parent;check();const index=Number(indexed.outPoint.index),output=transaction.outputs[index],outputData=transaction.outputsData[index];
      assert(output&&outputData!==undefined,"An indexed input points outside its canonical parent.");
      const actual=ccc.Cell.from({outPoint:indexed.outPoint,cellOutput:output,outputData});assert(sameCell(actual,indexed),"Indexed cell bytes disagree with the canonical parent.");
      const live=await read(()=>client.getCellLive(indexed.outPoint,true,true));assert(live&&sameCell(live,actual),"A reviewed code, protocol or funding cell is no longer live.");return actual;
    }
    async function exactType(script:ccc.Script):Promise<ccc.Cell>{
      const result=await read(()=>client.findCellsPaged({script,scriptType:"type",scriptSearchMode:"exact",withData:true},"asc",100));
      assert(result.cells.length===1&&result.cells[0].cellOutput.type?.eq(script),"The exact QA cell is missing or ambiguous; no prefix/shared fallback is allowed.");return canonicalCell(result.cells[0]);
    }
    const protocolCell=await exactType(protocolType),protocol=ProtocolData.decode(protocolCell.outputData),codes=protocol.protocol_config.script_code_hashes;
    assert(protocolCell.cellOutput.lock.eq(fixed.source.protocol.lockScript as ccc.ScriptLike)&&ccc.hexFrom(ProtocolData.encode(protocol))===protocolCell.outputData&&protocol.protocol_config.admin_lock_hash_vec.some(hash=>ccc.hexFrom(hash)===owner.hash()),"The current QA protocol owner, canonical data or Account 1 Admin authority changed.");
    assert(ccc.hexFrom(codes.ckb_boost_protocol_lock_code_hash)==="0xe91b5a78463c293318331c21d372e031eb9ffad87b379fbe0563222fcdd28815"&&ccc.hexFrom(codes.ckb_boost_user_type_code_hash)==="0xecc4b989dc3bfc2f80e22226d14b4b04257e8f4bf3d8298f80619b798e12cb2c"&&ccc.hexFrom(codes.ckb_boost_campaign_type_code_hash)==="0x9004d12f500e558df19c14e08907e014dbfc50ae249500bb5c389f883a1487d2","The dedicated QA protocol lineage changed.");
    const record=runtime.current.testnet.ckboostProtocolLock;assert(record?.typeScript&&record.typeHash===ccc.hexFrom(codes.ckb_boost_protocol_lock_code_hash),"The dedicated QA code runtime pin is unavailable.");
    const oldProtocolCode=await exactType(ccc.Script.from(record.typeScript as ccc.ScriptLike));
    const previousRelease=PERMISSION_REVIEW_RELEASES["protocol-lock"];assert(previousRelease,"Missing reviewed permissions-v2 QA code pin.");
    assert(oldProtocolCode.outPoint.eq({txHash:record.transactionHash,index:record.index})&&oldProtocolCode.cellOutput.lock.eq(owner)&&ccc.hashCkb(oldProtocolCode.outputData)===previousRelease.dataHash&&ccc.bytesFrom(oldProtocolCode.outputData).length===previousRelease.byteLength,"Only the exact Account 1 owned permissions-v2 QA code input may be reviewed.");
    const candidates:ccc.Cell[]=[];let after:string|undefined;const cursors=new Set<string>();
    for(let page=0;page<20;page++){
      const result=await read(()=>client.findCellsPaged({script:owner,scriptType:"lock",scriptSearchMode:"exact",withData:true},"asc",100,after));
      for(const cell of result.cells)if(cell.cellOutput.lock.eq(owner)&&!cell.cellOutput.type&&cell.outputData==="0x")candidates.push(cell);
      assert(candidates.length<=256,"Account 1 funding exceeds the bounded 256-input review; no partial balance is reported.");
      if(result.cells.length<100)break;
      assert(page<19&&result.lastCursor&&!cursors.has(result.lastCursor),"Funding pagination is incomplete. No partial balance is reported.");cursors.add(result.lastCursor);after=result.lastCursor;
    }
    assert(new Set(candidates.map(point)).size===candidates.length,"The funding indexer repeated an Account 1 cell.");
    const fundingCells:ccc.Cell[]=[];
    for(let index=0;index<candidates.length;index+=4)fundingCells.push(...await Promise.all(candidates.slice(index,index+4).map(canonicalCell)));
    const liveBalance=fundingCells.reduce((sum,cell)=>sum+cell.cellOutput.capacity,0n);
    const registryCode=await read(()=>confirmAdminRegistryUpgrade(client,"code",()=>!signal.aborted&&isCurrent()));
    const registryState=registryCode.status==="confirmed"?await read(()=>confirmAdminRegistryUpgrade(client,"state",()=>!signal.aborted&&isCurrent())):null;
    const registryConfirmed=registryCode.status==="confirmed"&&registryState?.status==="confirmed";
    const minimum=(id:FinancialReviewId)=>ccc.CellOutput.from({lock:owner,type:{codeHash:TYPE_ID,hashType:"type",args:`0x${"00".repeat(32)}`}},new Uint8Array(ADMIN_TIPPING_RELEASE.byteLengths[id])).capacity;
    const protocolCapacity=minimum("protocolLock")>oldProtocolCode.cellOutput.capacity?minimum("protocolLock"):oldProtocolCode.cellOutput.capacity;
    const capacityIncrease=protocolCapacity-oldProtocolCode.cellOutput.capacity+minimum("tippingType")+minimum("fundingLock"),change=ccc.CellOutput.from({lock:owner},"0x").capacity;
    const registryOutstanding=(registryCode.status==="confirmed"?0n:fixed.code.outputs[0].capacity+BigInt(fixed.source.code.feeShannons))+(registryState?.status==="confirmed"?0n:fixed.state.outputs[0].capacity+BigInt(fixed.source.state.feeShannons));
    const required=capacityIncrease+change+MAX_FEE+registryOutstanding,ownerMatches=Boolean(connectedLock&&owner.eq(connectedLock));
    const blockedReasons:string[]=[];if(!ownerMatches)blockedReasons.push("Connect Account 1, the exact owner of the dedicated QA code and funding cells.");if(!registryConfirmed)blockedReasons.push("Both fixed Registry stages must be independently confirmed and live before an unsigned financial proposal can be constructed.");if(!fundingCells.length)blockedReasons.push("No live empty untyped Account 1 funding cell is available.");
    return {protocolCell,oldProtocolCode,fundingCells,registryCode,registryState,registryConfirmed,ownerMatches,liveBalanceShannons:liveBalance.toString(),capacityIncreaseShannons:capacityIncrease.toString(),minimumChangeShannons:change.toString(),feeBudgetShannons:MAX_FEE.toString(),registryOutstandingShannons:registryOutstanding.toString(),additionalCapacityEstimateShannons:(required>liveBalance?required-liveBalance:0n).toString(),blockedReasons,checkedAt:new Date().toISOString()};
  },undefined,45_000);
}
export async function prepareAdminFinancialReview(client:ccc.Client,connectedLock:ccc.ScriptLike,binaries:AdminFinancialBinaries,isCurrent:()=>boolean=()=>true):Promise<{snapshot:FinancialReviewSnapshot;plan:AdminFinancialCodePlan}> {
  validateAdminFinancialBinaries(binaries);
  const snapshot=await readAdminFinancialReview(client,connectedLock,isCurrent);
  assert(!snapshot.blockedReasons.length,"Unsigned proposal is blocked: "+snapshot.blockedReasons.join(" "));
  const plan=buildAdminFinancialCodePlan({protocolCell:snapshot.protocolCell,oldProtocolCode:snapshot.oldProtocolCode,fundingCells:snapshot.fundingCells,binaries});
  assert(isCurrent(),"The wallet or review changed. The unsigned proposal was discarded.");return {snapshot,plan};
}
export function exportAdminFinancialReview(plan:AdminFinancialCodePlan,snapshot:FinancialReviewSnapshot){
  assert(snapshot.registryConfirmed&&snapshot.ownerMatches&&plan.status==="unsigned-prepared"&&plan.transaction.hash()===plan.transactionHash,"Only an unchanged fully funded unsigned review may be exported.");
  return {schema:plan.schema,status:plan.status,network:"testnet",protocolTypeHash:ADMIN_TIPPING_RELEASE.protocolTypeHash,registryTypeHash:ADMIN_TIPPING_RELEASE.registryTypeHash,releaseId:ADMIN_TIPPING_RELEASE.releaseId,checkedAt:snapshot.checkedAt,transactionHash:plan.transactionHash,unsignedTransaction:ccc.hexFrom(plan.transaction.toBytes()),feeShannons:plan.feeShannons,additionalCapacityShannons:plan.additionalCapacityShannons,requiredInputCapacityShannons:plan.requiredInputCapacityShannons,capacityIncreaseShannons:plan.capacityIncreaseShannons,minimumChangeShannons:plan.minimumChangeShannons,scripts:Object.fromEntries(FINANCIAL_REVIEW_IDS.map(id=>[id,{codeHash:plan.scripts[id].codeHash,hashType:plan.scripts[id].hashType,args:plan.scripts[id].args}])),scope:"Unsigned code proposal only. Not a deployment, protocol-config transaction, runtime activation or wallet permission. Revalidate current cells and wallet at a later separately authorized signing step.",readOnly:true,didSign:false,didBroadcast:false,didActivate:false};
}
export function assertFinancialReviewUnchanged(previous:FinancialReviewSnapshot,current:FinancialReviewSnapshot,plan:AdminFinancialCodePlan):void {
  assert(current.registryConfirmed&&current.ownerMatches&&sameCell(previous.protocolCell,current.protocolCell)&&sameCell(previous.oldProtocolCode,current.oldProtocolCode),"The QA protocol, Registry confirmation or owned code changed after preparation.");
  const live=new Map(current.fundingCells.map(cell=>[point(cell),cell]));
  assert(previous.fundingCells.every(cell=>live.has(point(cell))&&sameCell(cell,live.get(point(cell))!)),"A reviewed Account 1 funding input changed or was spent. Rebuild the unsigned proposal.");
  assert(plan.transaction.hash()===plan.transactionHash,"The unsigned proposal changed after preparation.");
}
