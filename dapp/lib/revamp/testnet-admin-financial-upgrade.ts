import {ccc} from "@ckb-ccc/connector-react";
import {ProtocolData,type ProtocolDataLike} from "ssri-ckboost/types";
import {ADMIN_TIPPING_RELEASE} from "../../../contracts/admin-tipping/release-pins.mjs";
import {PERMISSION_REVIEW_RELEASES} from "../ckb/permissions-release-pins.mjs";
import qaBase from "../../config/qa/ckboost-testnet.json";
import registryPlan from "../../config/qa/admin-registry-upgrade-plan.json";

const TYPE_ID="0x00000000000000000000000000000000000000000000000000545950455f4944";
const QA_LOCK="0xe91b5a78463c293318331c21d372e031eb9ffad87b379fbe0563222fcdd28815";
const OWNER=ccc.Script.from(registryPlan.owner.lock as ccc.ScriptLike);
const assert:(ok:unknown,message:string)=>asserts ok=(ok,message)=>{if(!ok)throw new Error(message);};
const point=(value:ccc.OutPointLike)=>{const p=ccc.OutPoint.from(value);return `${p.txHash}:${p.index}`;};
export type AdminFinancialBinaries=Record<"tippingType"|"fundingLock"|"protocolLock",ccc.HexLike>;
/** Offline proposal only. An ELF matching these actual-anchor source pins is
 * not evidence that it is deployed. No wallet, RPC or environment override. */
export function validateAdminFinancialBinaries(input:AdminFinancialBinaries){
  return Object.fromEntries((["tippingType","fundingLock","protocolLock"] as const).map(name=>{
    const data=ccc.bytesFrom(input[name]),view=new DataView(data.buffer,data.byteOffset,data.byteLength);
    assert(data.length===ADMIN_TIPPING_RELEASE.byteLengths[name]&&ccc.hashCkb(data)===ADMIN_TIPPING_RELEASE.dataHashes[name],`The ${name} bytes do not match the actual Registry-bound reviewed candidate.`);
    assert(data.length>=24&&data[0]===0x7f&&data[1]===0x45&&data[2]===0x4c&&data[3]===0x46&&data[4]===2&&data[5]===1&&view.getUint16(16,true)===2&&view.getUint16(18,true)===243&&view.getUint32(20,true)===1,"Expected a reviewed little-endian RISC-V ELF executable.");
    return [name,ccc.hexFrom(data)];
  })) as Record<keyof AdminFinancialBinaries,ccc.Hex>;
}
function baselineProtocol(cell:ccc.Cell){
  assert(cell.cellOutput.type?.hash()===ADMIN_TIPPING_RELEASE.protocolTypeHash&&cell.cellOutput.lock.codeHash===QA_LOCK,"Only the exact dedicated QA protocol may be changed.");
  const protocol=ProtocolData.decode(cell.outputData);
  assert(ccc.hexFrom(ProtocolData.encode(protocol))===cell.outputData&&protocol.protocol_config.admin_lock_hash_vec.some(hash=>ccc.hexFrom(hash)===OWNER.hash()),"Canonical current QA Admin authorization is required.");
  const codes=protocol.protocol_config.script_code_hashes;
  assert(ccc.hexFrom(codes.ckb_boost_protocol_lock_code_hash)===QA_LOCK&&ccc.hexFrom(codes.ckb_boost_user_type_code_hash)==="0xecc4b989dc3bfc2f80e22226d14b4b04257e8f4bf3d8298f80619b798e12cb2c"&&ccc.hexFrom(codes.ckb_boost_campaign_type_code_hash)==="0x9004d12f500e558df19c14e08907e014dbfc50ae249500bb5c389f883a1487d2","QA protocol lineage changed; do not substitute shared code.");
  return protocol;
}
export interface AdminFinancialCodePlan {
  schema:"ckboost-admin-financial-code-proposal/v1";status:"unsigned-prepared"|"funding-required";
  transaction:ccc.Transaction;transactionHash:ccc.Hex;feeShannons:string;
  additionalCapacityShannons:string;requiredInputCapacityShannons:string;
  scripts:Record<"tippingType"|"fundingLock"|"protocolLock",ccc.Script>;
  capacityIncreaseShannons:string;minimumChangeShannons:string;
  readOnly:true;didSign:false;didBroadcast:false;didActivate:false;
}
/** All three code outputs fit one conservative <500,000-byte proposal. Only
 * the existing QA ProtocolLock code is consumed; fresh native TypeIDs are
 * created for Tip/Funding. Shared historical executables are never inputs.
 * Funding cells may be projected future change: caller must prove every input
 * committed/live, exact Registry state, empty old financial namespaces and
 * wallet authority again before a later explicit signing action. */
export function buildAdminFinancialCodePlan({protocolCell,oldProtocolCode,fundingCells,binaries}:{protocolCell:ccc.Cell;oldProtocolCode:ccc.Cell;fundingCells:ccc.Cell[];binaries:AdminFinancialBinaries}):AdminFinancialCodePlan {
  baselineProtocol(protocolCell);
  const bytes=validateAdminFinancialBinaries(binaries),old=oldProtocolCode,type=old.cellOutput.type;
  const previous=qaBase.current.testnet.ckboostProtocolLock;
  assert(point(old.outPoint)===point({txHash:previous.transactionHash,index:previous.index})&&old.cellOutput.capacity===BigInt(qaBase.sources.effectiveProfile.dependencies.find(row=>row.name==="ckboostProtocolLock")!.capacity!),"The original QA code outpoint/capacity changed; refresh the reviewed lineage before signing.");
  assert(type?.codeHash===TYPE_ID&&type.hashType==="type"&&type.hash()===QA_LOCK&&old.cellOutput.lock.eq(OWNER),"Only the Account 1 owned, dedicated QA ProtocolLock TypeID may be upgraded.");
  const previousRelease=PERMISSION_REVIEW_RELEASES["protocol-lock"];assert(previousRelease,"Missing reviewed previous QA code release.");
  assert(ccc.hashCkb(old.outputData)===previousRelease.dataHash&&ccc.bytesFrom(old.outputData).length===previousRelease.byteLength,"The prior QA ProtocolLock is not the verified permissions-v2 release.");
  assert(fundingCells.length>0&&fundingCells.length<=256,"Provide bounded Account 1 funding inputs; no automatic coin selection is performed.");
  const all=[old,...fundingCells],keys=new Set<string>();
  for(const cell of all){assert(!keys.has(point(cell.outPoint)),"Duplicate code/funding input.");keys.add(point(cell.outPoint));assert(cell.cellOutput.capacity>=ccc.CellOutput.from({lock:cell.cellOutput.lock,type:cell.cellOutput.type},cell.outputData).capacity,"Input below occupied capacity.");}
  for(const cell of fundingCells)assert(cell.cellOutput.lock.eq(OWNER)&&!cell.cellOutput.type&&cell.outputData==="0x","Only empty untyped Account 1 capacity may fund a code upgrade.");
  const first=ccc.CellInput.from({...old,since:0});
  const tippingType=ccc.Script.from({codeHash:TYPE_ID,hashType:"type",args:ccc.hashTypeId(first,1)}),fundingLock=ccc.Script.from({codeHash:TYPE_ID,hashType:"type",args:ccc.hashTypeId(first,2)});
  const scripts={protocolLock:type,tippingType,fundingLock};
  const outputs=(["protocolLock","tippingType","fundingLock"] as const).map(name=>ccc.CellOutput.from({lock:OWNER,type:scripts[name]},bytes[name]));
  outputs[0].capacity=outputs[0].capacity>old.cellOutput.capacity?outputs[0].capacity:old.cellOutput.capacity;
  const minimumChange=ccc.CellOutput.from({lock:OWNER},"0x");
  const known=ccc.Transaction.fromBytes(registryPlan.code.unsignedTransaction);
  assert(known.hash()==="0x3aed91b51165ae831e4422d017fd280bd78e2247bcd4a1410520fecca39968a8","The fixed reviewed wallet dependency baseline changed.");
  const tx=ccc.Transaction.from({inputs:all.map(cell=>({...cell,since:0})),outputs:[...outputs,minimumChange],outputsData:[bytes.protocolLock,bytes.tippingType,bytes.fundingLock,"0x"],cellDeps:known.cellDeps,witnesses:[ccc.hexFrom(ccc.WitnessArgs.from({lock:new Uint8Array(85)}).toBytes()),...fundingCells.map(()=>"0x" as ccc.Hex)]});
  assert(tx.toBytes().length<500000,"The three-code batch exceeds the conservative transaction-size limit; review a split plan instead.");
  const fee=BigInt(tx.toBytes().length+4); // fee rate 1,000 shannons/KB, ceil; matches CCC serialized-size convention.
  const inputCapacity=all.reduce((sum,cell)=>sum+cell.cellOutput.capacity,0n),occupied=outputs.reduce((sum,out)=>sum+out.capacity,0n),required=occupied+minimumChange.capacity+fee;
  if(inputCapacity>=required)tx.outputs[3].capacity=inputCapacity-occupied-fee;
  return {schema:"ckboost-admin-financial-code-proposal/v1",status:inputCapacity>=required?"unsigned-prepared":"funding-required",transaction:tx,transactionHash:tx.hash(),feeShannons:fee.toString(),additionalCapacityShannons:(inputCapacity>=required?0n:required-inputCapacity).toString(),requiredInputCapacityShannons:required.toString(),scripts,capacityIncreaseShannons:(occupied-old.cellOutput.capacity).toString(),minimumChangeShannons:minimumChange.capacity.toString(),readOnly:true,didSign:false,didBroadcast:false,didActivate:false};
}
/** Reconstruct code identities from the actual raw outputs. Display metadata is
 * never authority for a future protocol configuration or runtime activation. */
export function assertAdminFinancialCodePlan(plan:AdminFinancialCodePlan){
  const tx=plan.transaction,old=qaBase.current.testnet.ckboostProtocolLock;
  assert(plan.schema==="ckboost-admin-financial-code-proposal/v1"&&plan.status==="unsigned-prepared"&&plan.readOnly&&tx.hash()===plan.transactionHash,"Only a fully funded, unchanged reviewed code proposal may define the next config.");
  assert(tx.version===0n&&tx.headerDeps.length===0&&tx.inputs.length>=2&&tx.inputs.length<=257&&tx.outputs.length===4&&tx.outputsData.length===4&&tx.toBytes().length<500000,"Unexpected three-code upgrade transaction shape.");
  assert(tx.inputs[0].since===0n&&point(tx.inputs[0].previousOutput)===point({txHash:old.transactionHash,index:old.index}),"The original dedicated QA code input changed.");
  const seen=new Set<string>();for(const input of tx.inputs){assert(input.since===0n&&!seen.has(point(input.previousOutput)),"Duplicate/replaced/since-locked upgrade input.");seen.add(point(input.previousOutput));}
  const scripts={protocolLock:ccc.Script.from(old.typeScript as ccc.ScriptLike),tippingType:ccc.Script.from({codeHash:TYPE_ID,hashType:"type",args:ccc.hashTypeId(tx.inputs[0],1)}),fundingLock:ccc.Script.from({codeHash:TYPE_ID,hashType:"type",args:ccc.hashTypeId(tx.inputs[0],2)})};
  validateAdminFinancialBinaries({protocolLock:tx.outputsData[0],tippingType:tx.outputsData[1],fundingLock:tx.outputsData[2]});
  const oldCapacity=BigInt(qaBase.sources.effectiveProfile.dependencies.find(row=>row.name==="ckboostProtocolLock")!.capacity!);
  for(const [i,name] of ["protocolLock","tippingType","fundingLock"].entries()){
    const key=name as keyof typeof scripts,out=tx.outputs[i],minimum=ccc.CellOutput.from({lock:OWNER,type:scripts[key]},tx.outputsData[i]).capacity;
    assert(out.lock.eq(OWNER)&&out.type?.eq(scripts[key])&&out.capacity===(i===0&&oldCapacity>minimum?oldCapacity:minimum),"A code output changed its owner, native TypeID or reviewed occupied capacity.");
  }
  assert(!tx.outputs[3].type&&tx.outputs[3].lock.eq(OWNER)&&tx.outputsData[3]==="0x"&&tx.outputs[3].capacity>=ccc.CellOutput.from({lock:OWNER},"0x").capacity,"Invalid Account 1 change reserve.");
  const deps=ccc.Transaction.fromBytes(registryPlan.code.unsignedTransaction).cellDeps;
  assert(tx.cellDeps.length===deps.length&&tx.cellDeps.every((dep,i)=>dep.depType===deps[i].depType&&point(dep.outPoint)===point(deps[i].outPoint)),"Unreviewed wallet/code dependencies in the unsigned batch.");
  assert(tx.witnesses.length===tx.inputs.length&&tx.witnesses.slice(1).every(value=>value==="0x"),"Unexpected unsigned witness shape.");
  const witness=ccc.WitnessArgs.fromBytes(tx.witnesses[0]);assert(witness.inputType==null&&witness.outputType==null&&ccc.bytesFrom(witness.lock??"0x").length===85&&ccc.bytesFrom(witness.lock!).every(value=>value===0),"Expected the exact unsigned Omnilock placeholder.");
  assert(BigInt(plan.feeShannons)===BigInt(tx.toBytes().length+4),"Unsigned fee/size summary changed.");
  return scripts;
}
/** Produce only the permitted ProtocolData delta. Transaction construction and
 * activation follow confirmed/live code receipts; this does not send or mutate
 * the old protocol/campaign/user objects. Both old funding namespaces must be
 * freshly empty across the protocol and every canonical QA campaign. */
export function makeAdminFinancialProtocolData(protocolCell:ccc.Cell,plan:AdminFinancialCodePlan,inventory:{complete:boolean;oldTips:number;protocolFunding:number;campaignFunding:number},lastUpdated:bigint):ProtocolDataLike {
  const before=baselineProtocol(protocolCell);
  const scripts=assertAdminFinancialCodePlan(plan);
  assert(inventory.complete&&[inventory.oldTips,inventory.protocolFunding,inventory.campaignFunding].every(count=>Number.isSafeInteger(count)&&count===0),"Old QA Tip/Funding state exists or was not completely checked. A separate state migration is required.");
  assert(lastUpdated>=ccc.numFrom(before.last_updated)&&lastUpdated<=0xffffffffffffffffn,"Invalid config update timestamp.");
  const data=ProtocolData.decode(protocolCell.outputData);
  data.protocol_config.script_code_hashes.ckb_boost_tipping_type_code_hash=scripts.tippingType.hash();
  data.protocol_config.script_code_hashes.ckb_boost_funding_lock_code_hash=scripts.fundingLock.hash();
  data.last_updated=lastUpdated;
  return data;
}
