import {ccc} from "@ckb-ccc/connector-react";
import {ConnectedTypeID,TippingData} from "ssri-ckboost/types";
import type {ProfileReadScope} from "./profile-model";
import {adminTipAssets,adminTipId,assertTippingProtocolScope,assertProtocolTipActorSpend,readProtocolTip,readProtocolTipDepositDelta,readProtocolTipTransactionInputs} from "./admin-tipping-model";

export type AdminTipPendingReceipt={schema:"ckboost-admin-tip-pending/v1";action:string;transactionHash:ccc.Hex};
type Action={kind:"support";id:ccc.Hex;previous:ccc.OutPoint}|{kind:"fund";assetId:string;amount:bigint}|{kind:"create";fingerprint:ccc.Hex};
const HASH="0x[0-9a-f]{64}";
export function parseAdminTipAction(action:string):Action {
  let match=new RegExp(`^support:(${HASH}):(${HASH}):(0x[0-9a-f]+|[0-9]+)$`).exec(action);
  if(match){const index=BigInt(match[3]);if(index>0xffffffffn)throw new Error("Invalid saved proposal index.");return {kind:"support",id:match[1] as ccc.Hex,previous:ccc.OutPoint.from({txHash:match[2],index})};}
  match=new RegExp(`^fund:(ckb|${HASH}):([0-9]+)$`).exec(action);
  if(match){const amount=BigInt(match[2]);if(amount<=0n||amount>0xffffffffffffffffffffffffffffffffn)throw new Error("Invalid saved funding amount.");return {kind:"fund",assetId:match[1],amount};}
  match=new RegExp(`^create:(${HASH})$`).exec(action);if(match)return {kind:"create",fingerprint:match[1] as ccc.Hex};
  throw new Error("The saved tipping action is unsupported. Inspect it before signing again.");
}
export function parseAdminTipReceipt(raw:string):AdminTipPendingReceipt {
  if(raw.length>2048)throw new Error("The saved tipping receipt is oversized.");
  const value=JSON.parse(raw) as AdminTipPendingReceipt;
  if(!value||Object.keys(value).sort().join(",")!=="action,schema,transactionHash"||value.schema!=="ckboost-admin-tip-pending/v1"||typeof value.action!=="string"||value.action.length>512||!new RegExp(`^${HASH}$`).test(value.transactionHash))throw new Error("The saved tipping receipt is invalid. Inspect it before signing again.");
  parseAdminTipAction(value.action);
  return {schema:value.schema,action:value.action,transactionHash:value.transactionHash};
}
const immutable=(next:ReturnType<typeof TippingData.decode>,before:ReturnType<typeof TippingData.decode>)=>ccc.hexFrom(TippingData.encode({...next,supporter_lock_hashes:before.supporter_lock_hashes,status:before.status,granted_at:before.granted_at}));
/** Bounded by the caller's AbortSignal/deadline. This performs only public reads:
 * no signer, wallet, send, retry-broadcast or privilege requirement exists here. */
export async function confirmAdminTipReceipt(scope:ProfileReadScope,receipt:AdminTipPendingReceipt,options:{confirmationTarget:number;signal?:AbortSignal;assertCurrent?:()=>Promise<void>}):Promise<{kind:Action["kind"];result:string}> {
  if(!Number.isSafeInteger(options.confirmationTarget)||options.confirmationTarget<0)throw new Error("Invalid tipping confirmation depth.");
  assertTippingProtocolScope(scope);parseAdminTipReceipt(JSON.stringify(receipt));const action=parseAdminTipAction(receipt.action),signal=options.signal;
  async function read<T>(operation:()=>Promise<T>):Promise<T>{if(signal?.aborted)throw new Error("The confirmation check expired.");await options.assertCurrent?.();if(signal?.aborted)throw new Error("The confirmation check expired.");const result=await operation();if(signal?.aborted)throw new Error("The confirmation check expired.");await options.assertCurrent?.();return result;}
  const response=await read(()=>scope.client.getTransaction(receipt.transactionHash));
  if(!response||response.status!=="committed")throw new Error(response?.status==="rejected"?"The node rejected this transaction. Its saved receipt is retained; nothing was sent again.":"The transaction is pending or unavailable. Its receipt is retained; nothing was sent again.");
  if(response.transaction.hash()!==receipt.transactionHash||response.blockNumber==null)throw new Error("The saved transaction body or committed block cannot be verified.");
  const tx=response.transaction,header=await read(()=>scope.client.getHeaderByNumber(response.blockNumber!));
  if(!header||header.number!==response.blockNumber||response.blockHash&&response.blockHash!==header.hash)throw new Error("The committed transaction's block could not be independently verified.");
  if(options.confirmationTarget>0){const tip=await read(()=>scope.client.getTipHeader());if(!tip||tip.number<response.blockNumber||tip.number-response.blockNumber+1n<BigInt(options.confirmationTarget))throw new Error("The transaction is committed but still awaiting the configured confirmation depth.");}
  const inputs=await read(()=>readProtocolTipTransactionInputs(scope,tx,signal));assertProtocolTipActorSpend(scope,tx,inputs);
  if(action.kind==="fund"){
    const asset=adminTipAssets(scope).find(value=>value.id===action.assetId&&value.kind!=="points");if(!asset)throw new Error("The saved funding asset is not configured in this protocol.");
    const delta=await read(()=>readProtocolTipDepositDelta(scope,tx,asset,signal));if(delta<action.amount)throw new Error("The transaction does not prove the saved funding amount in this exact pool.");return {kind:"fund",result:tx.hash()};
  }
  let id:ccc.Hex,before:ReturnType<typeof TippingData.decode>,type:ccc.Script,lock:ccc.Script,next:ReturnType<typeof TippingData.decode>;
  if(action.kind==="support"){
    const previous=inputs.filter(cell=>cell.outPoint.eq(action.previous));if(previous.length!==1||adminTipId(scope,previous[0])!==action.id)throw new Error("The transaction did not consume the saved exact proposal input.");
    const old=previous[0];id=action.id;type=old.cellOutput.type!;lock=old.cellOutput.lock;before=TippingData.decode(old.outputData);
    const outputs=tx.outputs.flatMap((output,index)=>output.type?.eq(type)?[index]:[]);if(outputs.length!==1)throw new Error("The saved approval has no unique exact proposal output.");
    const index=outputs[0];if(!tx.outputs[index].lock.eq(lock)||tx.outputs[index].capacity<old.cellOutput.capacity)throw new Error("The approval changed the proposal's owner or storage capacity.");
    next=TippingData.decode(tx.outputsData[index]);
    if(before.status==="granted"||next.supporter_lock_hashes.length!==before.supporter_lock_hashes.length+1||before.supporter_lock_hashes.some((hash,index)=>ccc.hexFrom(hash)!==ccc.hexFrom(next.supporter_lock_hashes[index]))||ccc.hexFrom(next.supporter_lock_hashes.at(-1)!)!==scope.lockHash||new Set(next.supporter_lock_hashes.map(value=>ccc.hexFrom(value))).size!==next.supporter_lock_hashes.length||immutable(next,before)!==old.outputData||!["approved","granted"].includes(next.status))throw new Error("The approval does not prove this wallet's single endorsement and unchanged proposal payload.");
  }else{
    const outputs=tx.outputs.flatMap((output,index)=>{const cell=ccc.Cell.from({outPoint:{txHash:tx.hash(),index},cellOutput:output,outputData:tx.outputsData[index]});return adminTipId(scope,cell)?[cell]:[];});
    if(outputs.length!==1)throw new Error("The creation has no unique exact proposal output.");
    const cell=outputs[0];id=adminTipId(scope,cell)!;type=cell.cellOutput.type!;lock=cell.cellOutput.lock;next=TippingData.decode(cell.outputData);before=next;
    if(!tx.inputs[0]||ccc.hashTypeId(tx.inputs[0],cell.outPoint.index)!==id||ccc.hexFrom(next.proposer_lock_hash)!==scope.lockHash||next.supporter_lock_hashes.length||next.status!=="created"||ccc.numFrom(next.granted_at)!==0n||ccc.hashCkb(TippingData.encode({...next,metadata:{...next.metadata,creation_timestamp:0n}}))!==action.fingerprint)throw new Error("The committed creation does not match this wallet's saved proposal fingerprint.");
  }
  const owner=ConnectedTypeID.decode(lock.args);
  if(lock.hashType!=="type"||lock.codeHash!==ccc.hexFrom(scope.protocol.protocol_config.script_code_hashes.ckb_boost_protocol_lock_code_hash)||ccc.hexFrom(owner.connected_key)!==scope.protocolHash||ccc.hexFrom(owner.type_id)!==ccc.hexFrom(before.proposer_lock_hash))throw new Error("The proposal's full owner lock is not bound to this protocol.");
  const current=(await read(()=>readProtocolTip(scope,id,signal)))[0];
  if(!current||!current.cell.cellOutput.type?.eq(type)||!current.cell.cellOutput.lock.eq(lock)||immutable(current.data,before)!==ccc.hexFrom(TippingData.encode(before))||next.supporter_lock_hashes.some((hash,index)=>ccc.hexFrom(current.data.supporter_lock_hashes[index]??"0x")!==ccc.hexFrom(hash)))throw new Error("The current exact proposal does not retain the confirmed action.");
  const live=await read(()=>scope.client.getCellLive(current.cell.outPoint,true));
  if(!live||!live.outPoint.eq(current.cell.outPoint)||!live.cellOutput.type?.eq(type)||!live.cellOutput.lock.eq(lock)||live.cellOutput.capacity!==current.cell.cellOutput.capacity||live.outputData!==current.cell.outputData)throw new Error("The current confirmed proposal is no longer live. Retry the read-only check.");
  return {kind:action.kind,result:id};
}
