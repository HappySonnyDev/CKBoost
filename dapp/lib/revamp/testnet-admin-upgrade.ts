import {ccc} from "@ckb-ccc/connector-react";
import {ProtocolData} from "ssri-ckboost/types";
import sourcePlan from "@/config/qa/admin-registry-upgrade-plan.json";
import {getIsolatedRuntime} from "@/lib/ckb/isolated-runtime.mjs";
import {decodeAdminRegistry,encodeAdminRegistry} from "./admin-registry-model";
import {UPGRADE_OWNER,assertUpgradeNetwork} from "./testnet-permission-upgrade";

export type AdminRegistryUpgradeStage="code"|"state";
export type AdminUpgradeGuard=()=>boolean;
export const ADMIN_UPGRADE_PROTOCOL="0x4eacaf9b1a120d2bfd99f26fcedfdcfe6ef116484e9b478b0a104a872316e034";
export const ADMIN_UPGRADE_REGISTRY="0x97e23b14d33e0445c1eac09f1948e2c3652547bfbb7fb7db56978f48baff9690";
export const ADMIN_UPGRADE_CODE_TYPE="0x12a5aa7950a17c8b11d28fdffad7c7cdf699811291437ad87826b422392e39d5";
export const ADMIN_UPGRADE_RELEASE=Object.freeze({byteLength:46600,dataHash:"0x19e35c5c748321bf99de22275e173cefd81278cd33b76d5be1a84136cf638cc7"});
const BODY_HASHES={code:"0x3aed91b51165ae831e4422d017fd280bd78e2247bcd4a1410520fecca39968a8",state:"0xc8113a4525db462182e5260387bb8b392b0c084a8bb2e3eef30f7a48be83ea39"} as const;
const TYPE_ID="0x00000000000000000000000000000000000000000000000000545950455f4944";
const OWNER_HASH="0xf3da4d6310b03c2c62f3ce5d6b1573da3432549b7e2faa78d84e4a6e7b245192";
const MAX_FEE=100000000n;
const assert:(ok:unknown,message:string)=>asserts ok=(ok,message)=>{if(!ok)throw new Error(message);};
const point=(p:ccc.OutPointLike)=>`${ccc.OutPoint.from(p).txHash}:${ccc.OutPoint.from(p).index}`;
const sameOutput=(a:ccc.CellOutput,b:ccc.CellOutput)=>ccc.hexFrom(a.toBytes())===ccc.hexFrom(b.toBytes());
const scriptJson=(s:ccc.Script)=>({codeHash:s.codeHash,hashType:s.hashType,args:s.args});
async function read<T>(promise:Promise<T>):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("The public Testnet read timed out. Retry confirmation; do not sign another transaction.")),12000);})]);}finally{clearTimeout(timer);}}
function current(guard:AdminUpgradeGuard){assert(guard(),"The wallet or operation changed. No further wallet action is allowed.");}
export function assertAdminUpgradeQa(client:ccc.Client){const runtime=getIsolatedRuntime();assert(runtime&&runtime.network==="testnet"&&runtime.protocol.typeHash===ADMIN_UPGRADE_PROTOCOL,"This operator is limited to the explicit isolated QA protocol.");assertUpgradeNetwork(client);}
export function adminUpgradeTransaction(stage:AdminRegistryUpgradeStage){return ccc.Transaction.fromBytes(sourcePlan[stage].unsignedTransaction);}

/** Both complete raw bodies are pinned independently of their JSON summaries.
 * A changed code body changes the linked state identity and must be recompiled. */
export function validateAdminRegistryUpgradePlan(input:unknown=sourcePlan){
  const p=input as typeof sourcePlan;
  assert(p?.schema==="ckboost-qa-admin-registry-operator-plan/v1"&&p.network==="testnet"&&p.protocol.typeHash===ADMIN_UPGRADE_PROTOCOL&&ccc.Script.from(p.protocol.typeScript as ccc.ScriptLike).hash()===ADMIN_UPGRADE_PROTOCOL,"Invalid fixed QA Registry plan scope.");
  assert(ccc.hashCkb(p.protocol.outputData)===p.protocol.dataHash&&ccc.hexFrom(ProtocolData.encode(ProtocolData.decode(p.protocol.outputData)))===p.protocol.outputData,"The public protocol snapshot is not canonical.");
  assert(ccc.Script.from(p.owner.lock as ccc.ScriptLike).eq(UPGRADE_OWNER)&&p.owner.lockHash===OWNER_HASH,"The Registry plan owner changed.");
  const code=ccc.Transaction.fromBytes(p.code.unsignedTransaction),state=ccc.Transaction.fromBytes(p.state.unsignedTransaction);
  for(const [stage,tx] of [["code",code],["state",state]] as const){
    assert(tx.hash()===BODY_HASHES[stage]&&p[stage].transactionHash===BODY_HASHES[stage]&&ccc.hexFrom(tx.toBytes())===p[stage].unsignedTransaction,"The reviewed raw transaction body changed. Stop and regenerate the anchor and consumer releases.");
    assert(tx.inputs.length===1&&tx.inputs[0].since===0n&&tx.outputs.length===2&&tx.outputsData.length===2&&tx.headerDeps.length===0&&tx.version===0n&&tx.toBytes().length<500000,"Unexpected fixed transaction shape.");
    assert(!tx.outputs[1].type&&tx.outputs[1].lock.eq(UPGRADE_OWNER)&&tx.outputsData[1]==="0x","Only exact empty Account 1 change is allowed.");
    const witness=ccc.WitnessArgs.fromBytes(tx.witnesses[0]);assert(tx.witnesses.length===1&&ccc.bytesFrom(witness.lock??"0x").length===85&&ccc.bytesFrom(witness.lock!).every(v=>v===0),"Expected the reviewed unsigned Omnilock placeholder.");
    assert(BigInt(p[stage].feeShannons!)>0n&&BigInt(p[stage].feeShannons!)<=MAX_FEE,"The reviewed fee is invalid.");
  }
  assert(point(code.inputs[0].previousOutput)==="0x950471450fa173fb530a05026bd6a9e8e5bf327ae7f709a49e21a8616a8d92e6:3","The fixed Account 1 input changed.");
  const binary=ccc.bytesFrom(code.outputsData[0]),header=new DataView(binary.buffer,binary.byteOffset,binary.byteLength);
  assert(binary.length===ADMIN_UPGRADE_RELEASE.byteLength&&ccc.hashCkb(binary)===ADMIN_UPGRADE_RELEASE.dataHash&&binary[0]===0x7f&&binary[1]===0x45&&binary[2]===0x4c&&binary[3]===0x46&&binary[4]===2&&binary[5]===1&&header.getUint16(16,true)===2&&header.getUint16(18,true)===243&&header.getUint32(20,true)===1,"The code is not the pinned RISC-V Registry ELF.");
  const codeType=code.outputs[0].type,stateType=state.outputs[0].type;
  assert(codeType&&codeType.codeHash===TYPE_ID&&codeType.hashType==="type"&&codeType.args===ccc.hashTypeId(code.inputs[0],0)&&codeType.hash()===ADMIN_UPGRADE_CODE_TYPE&&code.outputs[0].lock.eq(UPGRADE_OWNER),"The code TypeID or owner changed.");
  assert(code.outputs[0].capacity===ccc.CellOutput.from({lock:UPGRADE_OWNER,type:codeType},binary).capacity&&code.outputs[0].capacity===4672800000000n,"The code occupied capacity changed.");
  assert(point(state.inputs[0].previousOutput)===`${code.hash()}:1`&&stateType&&stateType.hashType==="type"&&stateType.codeHash===codeType.hash()&&stateType.hash()===ADMIN_UPGRADE_REGISTRY&&stateType.args===ccc.hexFrom(ccc.bytesConcat(ccc.bytesFrom(ccc.hashTypeId(state.inputs[0],0)),ccc.bytesFrom(ADMIN_UPGRADE_PROTOCOL)))&&state.outputs[0].lock.eq(stateType),"The future state input, custom Registry type or identical lock changed.");
  const registry=decodeAdminRegistry(state.outputsData[0]);assert(registry.protocolTypeHash===ADMIN_UPGRADE_PROTOCOL&&registry.revision==="0"&&registry.attestations.length===0&&registry.periods.length===0&&encodeAdminRegistry(registry)===state.outputsData[0],"Invalid initial Registry state.");
  assert(state.outputs[0].capacity===ccc.CellOutput.from({lock:stateType,type:stateType},state.outputsData[0]).capacity&&state.outputs[0].capacity===38600000000n,"The state occupied capacity changed.");
  assert(state.cellDeps.some(d=>d.depType==="code"&&point(d.outPoint)===`${code.hash()}:0`)&&state.cellDeps.some(d=>d.depType==="code"&&point(d.outPoint)===point(p.protocol.outPoint)),"The state code or current protocol dependency changed.");
  assert(code.outputs[1].capacity-state.getOutputsCapacity()===BigInt(p.state.feeShannons!),"The state fee summary does not match the raw body.");
  assert(BigInt(p.code.inputCapacityShannons)-code.getOutputsCapacity()===BigInt(p.code.feeShannons!),"The code fee summary does not match the raw body.");
  assert(p.anchors.registryTypeHash===ADMIN_UPGRADE_REGISTRY&&p.anchors.codeTypeHash===ADMIN_UPGRADE_CODE_TYPE&&ccc.Script.from(p.anchors.registryTypeScript as ccc.ScriptLike).eq(stateType)&&ccc.Script.from(p.anchors.codeTypeScript as ccc.ScriptLike).eq(codeType),"The Registry anchor summary changed.");
  return {source:p,code,state,registry,registryType:stateType,codeType};
}
async function owner(signer:ccc.Signer,guard:AdminUpgradeGuard){current(guard);assertAdminUpgradeQa(signer.client);const address=await read(signer.getRecommendedAddressObj());current(guard);assert(address.script.eq(UPGRADE_OWNER),"Connect Account 1 (CKB address ending 2rlz). This operator cannot spend another wallet's capacity.");}
async function freshProtocol(client:ccc.Client,guard:AdminUpgradeGuard){
  current(guard);assertAdminUpgradeQa(client);const {source}=validateAdminRegistryUpgradePlan();
  const cell=await read(client.getCellLive(source.protocol.outPoint));current(guard);
  assert(cell&&cell.cellOutput.type?.hash()===ADMIN_UPGRADE_PROTOCOL&&cell.cellOutput.lock.eq(source.protocol.lockScript as ccc.ScriptLike)&&cell.cellOutput.capacity===BigInt(source.protocol.capacityShannons)&&ccc.hashCkb(cell.outputData)===source.protocol.dataHash,"The current QA Protocol or authorization changed. Regenerate and review the fixed state plan before signing.");
  const data=ProtocolData.decode(cell.outputData);assert(ccc.hexFrom(ProtocolData.encode(data))===cell.outputData&&data.protocol_config.admin_lock_hash_vec.some(v=>ccc.hexFrom(v)===OWNER_HASH),"Account 1 is not authorized by the actual current QA Protocol.");
  return cell;
}
function canonicalResponse(response:ccc.ClientTransactionResponse|undefined,stage:AdminRegistryUpgradeStage){
  assert(response?.status==="committed"&&response.blockNumber!=null&&response.blockNumber>0n,"The exact transaction is not committed with block evidence.");
  const tx=ccc.Transaction.fromBytes(response.transaction.toBytes());assert(tx.hash()===BODY_HASHES[stage],"The actual committed raw transaction does not match the reviewed fixed body.");
  const expected=adminUpgradeTransaction(stage);assert(ccc.hexFrom(tx.rawToBytes())===ccc.hexFrom(expected.rawToBytes()),"The committed transaction changed its reviewed inputs, outputs or dependencies.");return tx;
}
async function committedStage(client:ccc.Client,stage:AdminRegistryUpgradeStage,guard:AdminUpgradeGuard){
  const response=await read(client.getTransaction(BODY_HASHES[stage]));current(guard);const tx=canonicalResponse(response,stage);
  const live=await read(client.getCellLive({txHash:BODY_HASHES[stage],index:0}));current(guard);
  assert(live&&point(live.outPoint)===`${tx.hash()}:0`&&sameOutput(live.cellOutput,tx.outputs[0])&&live.outputData===tx.outputsData[0],"The exact committed output 0 is not currently live or differs in owner, type, capacity or data.");
  if(stage==="code")assert(ccc.hashCkb(live.outputData)===ADMIN_UPGRADE_RELEASE.dataHash&&ccc.bytesFrom(live.outputData).length===ADMIN_UPGRADE_RELEASE.byteLength,"The live code bytes differ from the pinned Registry release.");
  return {transaction:tx,blockNumber:response!.blockNumber!,live};
}
export type AdminRegistryUpgradeConfirmation={status:"confirmed";stage:AdminRegistryUpgradeStage;transactionHash:ccc.Hex;blockNumber:string;manifest:Record<string,unknown>|null}|{status:"pending"|"unknown"|"rejected";stage:AdminRegistryUpgradeStage;transactionHash:ccc.Hex;message:string};
/** Read-only; requires the actual exact committed body plus current live output.
 * A state export never activates the registry or edits any runtime/profile. */
export async function confirmAdminRegistryUpgrade(client:ccc.Client,stage:AdminRegistryUpgradeStage,guard:AdminUpgradeGuard=()=>true):Promise<AdminRegistryUpgradeConfirmation>{
  current(guard);assertAdminUpgradeQa(client);const plan=validateAdminRegistryUpgradePlan();
  const response=await read(client.getTransaction(BODY_HASHES[stage]));current(guard);
  if(response?.status!=="committed")return {stage,transactionHash:BODY_HASHES[stage],status:response?.status==="rejected"?"rejected":response&&["pending","proposed","sent"].includes(response.status)?"pending":"unknown",message:"Confirmation is not established. Keep the saved transaction and check again; do not sign or deploy another copy."};
  const verified=await committedStage(client,stage,guard);
  let manifest:Record<string,unknown>|null=null;
  if(stage==="state"){
    const code=await committedStage(client,"code",guard);await freshProtocol(client,guard);
    manifest={schema:"ckboost-admin-registry-deployment/v1",network:"testnet",protocolTypeHash:ADMIN_UPGRADE_PROTOCOL,typeScript:scriptJson(plan.registryType),codeTypeScript:scriptJson(plan.codeType),codeDataHash:ADMIN_UPGRADE_RELEASE.dataHash,
      codeDeployment:{transactionHash:code.transaction.hash(),index:"0x0",blockNumber:ccc.numToHex(code.blockNumber),capacityShannons:code.live.cellOutput.capacity.toString(),contractSize:ADMIN_UPGRADE_RELEASE.byteLength,ownerLockScript:UPGRADE_OWNER},
      stateCreation:{transactionHash:verified.transaction.hash(),index:"0x0",blockNumber:ccc.numToHex(verified.blockNumber),capacityShannons:verified.live.cellOutput.capacity.toString(),dataHash:ccc.hashCkb(verified.live.outputData),firstInput:ccc.hexFrom(verified.transaction.inputs[0].toBytes())}};
  }
  return {status:"confirmed",stage,transactionHash:BODY_HASHES[stage],blockNumber:ccc.numToHex(verified.blockNumber),manifest};
}
export interface AdminUpgradeStorage{getItem(key:string):string|null;setItem(key:string,value:string):void}
export interface AdminRegistryUpgradeReceipt{schema:"ckboost-qa-admin-registry-signed/v1";network:"testnet";protocolTypeHash:typeof ADMIN_UPGRADE_PROTOCOL;ownerLockHash:string;stage:AdminRegistryUpgradeStage;transactionHash:ccc.Hex;signedTransaction:ccc.Hex;phase:"signed"|"broadcast-attempted";signedAt:string}
const memory=new Map<string,AdminRegistryUpgradeReceipt>(),busy=new Set<string>();
export function adminUpgradeReceiptKey(stage:AdminRegistryUpgradeStage){return `ckboost:qa-admin-registry:v1:${ADMIN_UPGRADE_PROTOCOL}:${OWNER_HASH}:${stage}:${BODY_HASHES[stage]}`;}
function storageOrThrow(store?:AdminUpgradeStorage){const result=store??(typeof localStorage!=="undefined"?localStorage:undefined);assert(result,"Durable browser storage is unavailable. No signing or broadcast is allowed.");return result;}
export function readAdminUpgradeReceipt(stage:AdminRegistryUpgradeStage,store?:AdminUpgradeStorage){
  const key=adminUpgradeReceiptKey(stage),saved=memory.get(key),raw=storageOrThrow(store).getItem(key);if(!raw)return saved??null;
  assert(raw.length<1200000,"The saved upgrade receipt is too large.");const value=JSON.parse(raw) as AdminRegistryUpgradeReceipt;
  assert(value.schema==="ckboost-qa-admin-registry-signed/v1"&&value.network==="testnet"&&value.protocolTypeHash===ADMIN_UPGRADE_PROTOCOL&&value.ownerLockHash===OWNER_HASH&&value.stage===stage&&value.transactionHash===BODY_HASHES[stage]&&["signed","broadcast-attempted"].includes(value.phase),"The saved upgrade receipt is invalid. Inspect it; never clear it to deploy again.");
  const tx=ccc.Transaction.fromBytes(value.signedTransaction);assert(tx.hash()===BODY_HASHES[stage]&&ccc.hexFrom(tx.rawToBytes())===ccc.hexFrom(adminUpgradeTransaction(stage).rawToBytes()),"The saved signed transaction body does not match the reviewed upgrade.");
  if(saved?.phase==="broadcast-attempted")return saved;memory.set(key,value);return value;
}
function saveReceipt(value:AdminRegistryUpgradeReceipt,store?:AdminUpgradeStorage){const key=adminUpgradeReceiptKey(value.stage);memory.set(key,value);storageOrThrow(store).setItem(key,JSON.stringify(value));}
export interface AdminRegistryUpgradeReview{stage:AdminRegistryUpgradeStage;transactionHash:ccc.Hex;feeShannons:string;transaction:ccc.Transaction}
export async function reviewAdminRegistryUpgrade(signer:ccc.Signer,stage:AdminRegistryUpgradeStage,guard:AdminUpgradeGuard=()=>true):Promise<AdminRegistryUpgradeReview>{
  await owner(signer,guard);const plan=validateAdminRegistryUpgradePlan(),tx=adminUpgradeTransaction(stage);
  const existing=await read(signer.client.getTransaction(BODY_HASHES[stage]));current(guard);
  assert(!existing,"This exact transaction is already known to the node. Check confirmation; never sign or deploy another copy.");
  if(stage==="state")await committedStage(signer.client,"code",guard);
  await freshProtocol(signer.client,guard);
  const live=await read(signer.client.getCellLive(tx.inputs[0].previousOutput));current(guard);
  assert(live&&!live.cellOutput.type&&live.outputData==="0x"&&live.cellOutput.lock.eq(UPGRADE_OWNER)&&point(live.outPoint)===point(tx.inputs[0].previousOutput),"The fixed Account 1 funding input is no longer live/plain. Do not replace it; the anchor must be regenerated and consumers recompiled.");
  const expected=stage==="code"?BigInt(plan.source.code.inputCapacityShannons):plan.code.outputs[1].capacity;
  assert(live.cellOutput.capacity===expected,"The actual fixed input capacity differs from the reviewed plan.");
  const fee=live.cellOutput.capacity-tx.getOutputsCapacity();assert(fee>0n&&fee<=MAX_FEE&&fee===BigInt(plan.source[stage].feeShannons!),"The actual fee does not match the reviewed limit/body.");
  tx.inputs[0].cellOutput=live.cellOutput;tx.inputs[0].outputData=live.outputData;
  await owner(signer,guard);return {stage,transactionHash:BODY_HASHES[stage],feeShannons:fee.toString(),transaction:tx};
}
async function exclusive<T>(stage:AdminRegistryUpgradeStage,run:()=>Promise<T>){const key=adminUpgradeReceiptKey(stage);assert(!busy.has(key),"An operation on this exact upgrade transaction is already in progress.");busy.add(key);try{return await run();}finally{busy.delete(key);}}
/** Explicit user action only. Saves the actual signed body durably before any
 * possible network send. This function never broadcasts or estimates. */
export async function signAdminRegistryUpgrade(signer:ccc.Signer,stage:AdminRegistryUpgradeStage,guard:AdminUpgradeGuard=()=>true,store?:AdminUpgradeStorage){return exclusive(stage,async()=>{
  assert(!readAdminUpgradeReceipt(stage,store),"A signed or attempted upgrade is already saved. Restore it and check confirmation; do not sign again.");
  const reviewed=await reviewAdminRegistryUpgrade(signer,stage,guard);
  const prepared=await read(signer.prepareTransaction(reviewed.transaction.clone()));await owner(signer,guard);
  assert(prepared.hash()===BODY_HASHES[stage],"Wallet preparation changed the fixed raw body. Nothing was signed or broadcast. Recompute the anchor and recompile consumers.");
  const signed=ccc.Transaction.fromBytes((await signer.signTransaction(prepared)).toBytes());
  assert(signed.hash()===BODY_HASHES[stage]&&signed.toBytes().length<500000,"The wallet changed the signed transaction body. Nothing was broadcast. Recompute the anchor and recompile consumers.");
  const receipt:AdminRegistryUpgradeReceipt={schema:"ckboost-qa-admin-registry-signed/v1",network:"testnet",protocolTypeHash:ADMIN_UPGRADE_PROTOCOL,ownerLockHash:OWNER_HASH,stage,transactionHash:signed.hash(),signedTransaction:ccc.hexFrom(signed.toBytes()),phase:"signed",signedAt:new Date().toISOString()};
  // Retain the actual returned signature even if the wallet/scope changed
  // while its popup was open. It remains unbroadcast and requires fresh A
  // authorization before a later explicit send; it must not trigger resigning.
  saveReceipt(receipt,store);await owner(signer,guard);return receipt;
});}
/** Separate explicit broadcast action. An attempted send is never repeated;
 * a lost acknowledgement is recovered by checking the fixed actual hash. */
export async function broadcastAdminRegistryUpgrade(signer:ccc.Signer,stage:AdminRegistryUpgradeStage,guard:AdminUpgradeGuard=()=>true,store?:AdminUpgradeStorage){return exclusive(stage,async()=>{
  const receipt=readAdminUpgradeReceipt(stage,store);assert(receipt&&receipt.phase==="signed","No unbroadcast signed receipt is available. Check the attempted transaction instead of sending again.");
  await reviewAdminRegistryUpgrade(signer,stage,guard);const signed=ccc.Transaction.fromBytes(receipt.signedTransaction);
  const cycles=await read(signer.client.estimateCycles(signed));current(guard);assert(cycles>0n,"Read-only script verification did not succeed. Nothing was broadcast.");
  await reviewAdminRegistryUpgrade(signer,stage,guard);await owner(signer,guard);
  const attempted:AdminRegistryUpgradeReceipt={...receipt,phase:"broadcast-attempted"};saveReceipt(attempted,store);current(guard);
  const hash=await signer.client.sendTransaction(signed);current(guard);assert(hash===receipt.transactionHash,"The RPC acknowledgement differs from the saved actual hash. Check confirmation; do not send again.");return attempted;
});}
