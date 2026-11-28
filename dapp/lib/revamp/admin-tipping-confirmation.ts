import {ccc} from "@ckb-ccc/connector-react";
import {ConnectedTypeID,TippingData} from "ssri-ckboost/types";
import {withProfileDeadline,type ProfileReadScope} from "./profile-model";
import {adminTipAssets,adminTipId,assertTippingProtocolScope,assertProtocolTipActorSpend,readProtocolTip,readProtocolTipDepositDelta,readProtocolTipTransactionInputs} from "./admin-tipping-model";

export type AdminTipPendingReceiptV1={schema:"ckboost-admin-tip-pending/v1";action:string;transactionHash:ccc.Hex};
export type AdminTipPendingReceiptV2={schema:"ckboost-admin-tip-pending/v2";action:string;transactionHash:ccc.Hex;transactionHex:ccc.Hex};
export type AdminTipPendingReceipt=AdminTipPendingReceiptV1|AdminTipPendingReceiptV2;
export const ADMIN_TIP_PUBLIC_TRANSACTION_LIMIT=1_100_000;
const boundedText=(value:unknown):value is string=>typeof value==="string"&&value.length<=ADMIN_TIP_PUBLIC_TRANSACTION_LIMIT&&new TextEncoder().encode(value).byteLength<=ADMIN_TIP_PUBLIC_TRANSACTION_LIMIT;
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
  if(!boundedText(raw))throw new Error("The saved tipping receipt is oversized.");
  const value=JSON.parse(raw) as AdminTipPendingReceipt;
  const v2=value?.schema==="ckboost-admin-tip-pending/v2";
  if(!value||Array.isArray(value)||Object.keys(value).sort().join(",")!==(v2?"action,schema,transactionHash,transactionHex":"action,schema,transactionHash")||(!v2&&value.schema!=="ckboost-admin-tip-pending/v1")||!v2&&raw.length>2048||typeof value.action!=="string"||value.action.length>512||!new RegExp(`^${HASH}$`).test(value.transactionHash))throw new Error("The saved tipping receipt is invalid. Inspect it before signing again.");
  parseAdminTipAction(value.action);
  if(v2){const tx=transactionFromHex(value.transactionHex);if(tx.hash()!==value.transactionHash)throw new Error("The saved public transaction does not match its receipt hash.");return {schema:"ckboost-admin-tip-pending/v2",action:value.action,transactionHash:value.transactionHash,transactionHex:value.transactionHex};}
  return {schema:"ckboost-admin-tip-pending/v1",action:value.action,transactionHash:value.transactionHash};
}
const fail=(message:string):never=>{throw new Error(message);};
function transactionFromHex(value:unknown):ccc.Transaction {
  if(typeof value!=="string"||value.length>ADMIN_TIP_PUBLIC_TRANSACTION_LIMIT||!/^0x(?:[0-9a-f]{2})+$/.test(value))return fail("A bounded canonical public transaction hex value is required.");
  const tx=ccc.Transaction.fromBytes(value);
  if(ccc.hexFrom(tx.toBytes())!==value||tx.outputs.length!==tx.outputsData.length)return fail("The public transaction bytes are not canonical or have mismatched output data.");
  return tx;
}
/** Capture the actual public bytes at the final client submission boundary.
 * This is evidence, not a claim of signature validity or node acceptance.
 * The caller must durably persist the returned receipt before submitting. */
export function makeAdminTipReceipt(action:string,actualTx:ccc.TransactionLike):AdminTipPendingReceiptV2 {
  parseAdminTipAction(action);
  const encoded=actualTx as {toBytes?:()=>Uint8Array};
  const tx=typeof encoded.toBytes==="function"?transactionFromHex(ccc.hexFrom(encoded.toBytes())):publicTransaction(actualTx);
  return parseAdminTipReceipt(JSON.stringify({schema:"ckboost-admin-tip-pending/v2",action,transactionHash:tx.hash(),transactionHex:ccc.hexFrom(tx.toBytes())})) as AdminTipPendingReceiptV2;
}
type PublicObject=Record<string,unknown>;
function fields(value:unknown,allowed:readonly string[],required:readonly string[]=allowed):PublicObject {
  if(!value||typeof value!=="object"||Array.isArray(value))return fail("Expected an explicit public transaction object.");
  const object=value as PublicObject;
  if(Object.keys(object).some(key=>!allowed.includes(key))||required.some(key=>!Object.hasOwn(object,key)))return fail("Unexpected or missing public transaction fields.");
  return object;
}
function list(value:unknown):unknown[]{if(!Array.isArray(value))return fail("A public transaction array is missing.");return value;}
function publicTransaction(value:unknown):ccc.Transaction {
  if(typeof value==="string")return transactionFromHex(value);
  const object=fields(value,["version","cell_deps","header_deps","inputs","outputs","outputs_data","witnesses","hash","cellDeps","headerDeps","outputsData"],[]);
  const snake=Object.hasOwn(object,"cell_deps"),names=snake?["version","cell_deps","header_deps","inputs","outputs","outputs_data","witnesses"]:["version","cellDeps","headerDeps","inputs","outputs","outputsData","witnesses"];
  fields(object,[...names,"hash"],names);
  const point=(value:unknown)=>{const p=fields(value,snake?["tx_hash","index"]:["txHash","index"]);return {txHash:p[snake?"tx_hash":"txHash"] as ccc.Hex,index:p.index as ccc.NumLike};};
  const script=(value:unknown)=>{const s=fields(value,snake?["code_hash","hash_type","args"]:["codeHash","hashType","args"]);return {codeHash:s[snake?"code_hash":"codeHash"] as ccc.Hex,hashType:s[snake?"hash_type":"hashType"] as ccc.HashType,args:s.args as ccc.Hex};};
  const output=(value:unknown)=>{const o=fields(value,["capacity","lock","type"],["capacity","lock"]);return {capacity:o.capacity as ccc.NumLike,lock:script(o.lock),type:o.type==null?undefined:script(o.type)};};
  if(list(object.outputs).length!==list(object[snake?"outputs_data":"outputsData"]).length)return fail("The public transaction has mismatched output data.");
  const tx=ccc.Transaction.from({version:object.version as ccc.NumLike,
    cellDeps:list(object[snake?"cell_deps":"cellDeps"]).map(value=>{const d=fields(value,snake?["out_point","dep_type"]:["outPoint","depType"]),kind=d[snake?"dep_type":"depType"];if(!(snake?["code","dep_group"]:["code","depGroup"]).includes(kind as string))return fail("Invalid public cell dependency type.");return {outPoint:point(d[snake?"out_point":"outPoint"]),depType:(kind==="dep_group"?"depGroup":kind) as ccc.DepType};}),
    headerDeps:list(object[snake?"header_deps":"headerDeps"]) as ccc.Hex[],
    inputs:list(object.inputs).map(value=>{const keys=snake?["since","previous_output"]:["since","previousOutput"],i=fields(value,snake?keys:[...keys,"cellOutput","outputData"],keys);
      // CCC console serialization may include cached parent metadata. It is
      // public but not part of the raw transaction hash or any authority proof.
      if(!snake){if(i.cellOutput!=null)output(i.cellOutput);if(i.outputData!=null&&!(typeof i.outputData==="string"&&/^0x(?:[0-9a-f]{2})*$/.test(i.outputData)))return fail("Invalid cached public input data.");}
      return {since:i.since as ccc.NumLike,previousOutput:point(i[snake?"previous_output":"previousOutput"])};}),
    outputs:list(object.outputs).map(output),
    outputsData:list(object[snake?"outputs_data":"outputsData"]) as ccc.Hex[],witnesses:list(object.witnesses) as ccc.Hex[]});
  // Newer CCC versions automatically raise an output to its occupied minimum
  // in Transaction.from. Evidence parsing must preserve the *provided* body,
  // including an invalid capacity, rather than silently repair its raw hash.
  list(object.outputs).forEach((value,index)=>{tx.outputs[index].capacity=ccc.numFrom((value as PublicObject).capacity as ccc.NumLike);});
  const canonical=transactionFromHex(ccc.hexFrom(tx.toBytes()));
  if(object.hash!==undefined&&object.hash!==canonical.hash())return fail("The supplied public transaction hash field differs from its canonical body.");
  return canonical;
}
/** Only explicit public serialization shapes are unwrapped. Never search
 * arbitrary log properties, error strings or nested private exports. */
function importedTransaction(text:string):ccc.Transaction {
  if(!boundedText(text)||!text.trim())return fail("Import the bounded public transaction body for this saved attempt.");
  const trimmed=text.trim();if(trimmed.startsWith("0x"))return transactionFromHex(trimmed);
  let value:unknown=JSON.parse(trimmed);
  if(value&&typeof value==="object"&&!Array.isArray(value)){
    let object=value as PublicObject;
    if(Object.hasOwn(object,"params")){
      fields(object,["jsonrpc","id","method","params"],["method","params"]);
      if(object.method!=="send_transaction"||object.jsonrpc!==undefined&&object.jsonrpc!=="2.0"||!Array.isArray(object.params)||object.params.length<1||object.params.length>2||object.params.length===2&&!['default','passthrough','well_known_scripts'].includes(object.params[1] as string))return fail("Only an explicit public send_transaction request may supply params[0].");
      value=object.params[0];
    }else{
      if(Object.hasOwn(object,"result")){fields(object,["jsonrpc","id","result"],["result"]);if(object.jsonrpc!==undefined&&object.jsonrpc!=="2.0")return fail("Invalid public RPC envelope.");value=object.result;}
      if(value&&typeof value==="object"&&!Array.isArray(value)&&Object.hasOwn(value,"transaction")){object=fields(value,["transaction","tx_status","cycles","fee","min_replace_fee"],["transaction"]);value=object.transaction;}
    }
  }
  return publicTransaction(value);
}
export interface AdminTipInvalidCapacityProof {
  schema:"ckboost-admin-tip-invalid-capacity/v1";network:ProfileReadScope["network"];protocolTypeHash:ccc.Hex;walletLockHash:ccc.Hex;
  action:string;transactionHash:ccc.Hex;tipId:ccc.Hex;tipOutputIndex:number;nodeStatus:"unknown"|"rejected";
  deficits:Array<{outputIndex:number;providedCapacityShannons:string;requiredCapacityShannons:string;deficitShannons:string}>;
  diagnosticReceipt:AdminTipPendingReceiptV2;didSign:false;didBroadcast:false;didClear:false;
}
/** Read-only proof of an immutable occupied-capacity defect. Unknown RPC status
 * alone is never rejection proof. This function neither clears nor sends. */
export async function inspectInvalidAdminTipReceipt(scope:ProfileReadScope,receipt:AdminTipPendingReceipt,publicTransactionText?:string,options:{assertCurrent?:()=>void|Promise<void>;signal?:AbortSignal}={}):Promise<AdminTipInvalidCapacityProof> {
  assertTippingProtocolScope(scope);const saved=parseAdminTipReceipt(JSON.stringify(receipt)),action=parseAdminTipAction(saved.action);
  if(action.kind!=="create")throw new Error("Capacity recovery is restricted to the exact saved Tip creation action.");
  const tx=publicTransactionText?.trim()?importedTransaction(publicTransactionText):saved.schema==="ckboost-admin-tip-pending/v2"?transactionFromHex(saved.transactionHex):fail("The legacy receipt has no transaction body. Import its actual public raw transaction first.");
  if(tx.hash()!==saved.transactionHash)throw new Error("The imported public transaction does not match the saved raw transaction hash.");
  if(saved.schema==="ckboost-admin-tip-pending/v2"&&ccc.hexFrom(tx.rawToBytes())!==ccc.hexFrom(transactionFromHex(saved.transactionHex).rawToBytes()))throw new Error("The imported body differs from the saved public transaction.");
  const outputs=tx.outputs.flatMap((output,index)=>{const cell=ccc.Cell.from({outPoint:{txHash:tx.hash(),index},cellOutput:output,outputData:tx.outputsData[index]});return adminTipId(scope,cell)?[cell]:[];});
  if(outputs.length!==1)throw new Error("The imported creation has no unique exact protocol Tip output.");
  const cell=outputs[0],tipId=adminTipId(scope,cell)!,index=Number(cell.outPoint.index),data=TippingData.decode(cell.outputData);
  if(!tx.inputs[0]||ccc.hashTypeId(tx.inputs[0],index)!==tipId||ccc.hexFrom(TippingData.encode(data))!==cell.outputData||ccc.hexFrom(data.proposer_lock_hash)!==scope.lockHash||data.supporter_lock_hashes.length||data.status!=="created"||ccc.numFrom(data.granted_at)!==0n||ccc.numFrom(data.metadata.creation_timestamp)<=0n||ccc.hashCkb(TippingData.encode({...data,metadata:{...data.metadata,creation_timestamp:0n}}))!==action.fingerprint)throw new Error("The imported Tip does not match this wallet's immutable creation fingerprint and fresh TypeID.");
  const owner=ConnectedTypeID.decode(cell.cellOutput.lock.args);
  if(cell.cellOutput.lock.hashType!=="type"||cell.cellOutput.lock.codeHash!==ccc.hexFrom(scope.protocol.protocol_config.script_code_hashes.ckb_boost_protocol_lock_code_hash)||ccc.hexFrom(ConnectedTypeID.encode(owner))!==cell.cellOutput.lock.args||ccc.hexFrom(owner.connected_key)!==scope.protocolHash||ccc.hexFrom(owner.type_id)!==scope.lockHash)throw new Error("The imported proposal owner lock is not exactly bound to this protocol and wallet.");
  const deficits=tx.outputs.flatMap((output,outputIndex)=>{
    const required=ccc.CellOutput.from({lock:output.lock,type:output.type},tx.outputsData[outputIndex]).capacity;
    return output.capacity<required?[{outputIndex,providedCapacityShannons:output.capacity.toString(),requiredCapacityShannons:required.toString(),deficitShannons:(required-output.capacity).toString()}]:[];
  });
  if(!deficits.length)throw new Error("This exact body has no occupied-capacity deficit. Unknown status or a reported error is not terminal rejection proof.");
  const guard=async()=>{if(options.signal?.aborted)throw new Error("The inspection check expired.");await options.assertCurrent?.();if(options.signal?.aborted)throw new Error("The inspection check expired.");};
  await guard();const response=await withProfileDeadline(()=>scope.client.getTransactionNoCache(saved.transactionHash),options.signal,12_000);await guard();
  if(response?.transaction&&response.transaction.hash()!==saved.transactionHash)throw new Error("The uncached node response contains a different transaction body.");
  if(response&&(!["unknown","rejected"].includes(response.status)||response.blockNumber!=null||response.blockHash!=null))throw new Error("The transaction is pending, proposed, committed or otherwise not terminally unavailable. Keep the saved receipt.");
  return {schema:"ckboost-admin-tip-invalid-capacity/v1",network:scope.network,protocolTypeHash:scope.protocolHash,walletLockHash:scope.lockHash,action:saved.action,transactionHash:saved.transactionHash,tipId,tipOutputIndex:index,nodeStatus:response?.status==="rejected"?"rejected":"unknown",deficits,diagnosticReceipt:makeAdminTipReceipt(saved.action,tx),didSign:false,didBroadcast:false,didClear:false};
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
