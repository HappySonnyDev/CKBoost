import {ccc} from "@ckb-ccc/connector-react";
import {ProtocolData} from "ssri-ckboost/types";
import baseline from "../../../config/qa/admin-registry-upgrade-plan.json";
import runtime from "../../../config/qa/ckboost-testnet.json";
import {buildAdminFinancialCodePlan,makeAdminFinancialProtocolData,validateAdminFinancialBinaries,type AdminFinancialBinaries} from "../testnet-admin-financial-upgrade";
import {ADMIN_TIPPING_RELEASE} from "../../../../contracts/admin-tipping/release-pins.mjs";
import {PERMISSION_REVIEW_RELEASES} from "../../ckb/permissions-release-pins.mjs";

jest.mock("@ckb-ccc/connector-react",()=>({ccc:jest.requireActual("@ckb-ccc/core").ccc}));

jest.mock("../../../../contracts/admin-tipping/release-pins.mjs",()=>{
  const {ccc}=require("@ckb-ccc/connector-react");
  const elf=(id:number)=>{const b=new Uint8Array(25);b.set([0x7f,0x45,0x4c,0x46,2,1]);b[16]=2;b[18]=243;b[20]=1;b[24]=id;return b;};
  return {ADMIN_TIPPING_RELEASE:{releaseId:"test-fixture",protocolTypeHash:"0x4eacaf9b1a120d2bfd99f26fcedfdcfe6ef116484e9b478b0a104a872316e034",registryTypeHash:"0x97e23b14d33e0445c1eac09f1948e2c3652547bfbb7fb7db56978f48baff9690",byteLengths:{tippingType:25,fundingLock:25,protocolLock:25},dataHashes:{tippingType:ccc.hashCkb(elf(1)),fundingLock:ccc.hashCkb(elf(2)),protocolLock:ccc.hashCkb(elf(3))}}};
});
jest.mock("../../ckb/permissions-release-pins.mjs",()=>{
  const {ccc}=require("@ckb-ccc/connector-react");return {PERMISSION_REVIEW_RELEASES:{"protocol-lock":{byteLength:1,dataHash:ccc.hashCkb("0x01")}}};
});
const elf=(id:number)=>{const b=new Uint8Array(25);b.set([0x7f,0x45,0x4c,0x46,2,1]);b[16]=2;b[18]=243;b[20]=1;b[24]=id;return ccc.hexFrom(b);};
function fixture(){
  const owner=ccc.Script.from(baseline.owner.lock as ccc.ScriptLike),protocolCell=ccc.Cell.from({outPoint:baseline.protocol.outPoint,cellOutput:{capacity:baseline.protocol.capacityShannons,lock:baseline.protocol.lockScript as ccc.ScriptLike,type:baseline.protocol.typeScript as ccc.ScriptLike},outputData:baseline.protocol.outputData});
  const record=runtime.current.testnet.ckboostProtocolLock;
  const oldProtocolCode=ccc.Cell.from({outPoint:{txHash:record.transactionHash,index:record.index},cellOutput:{capacity:runtime.sources.effectiveProfile.dependencies.find(row=>row.name==="ckboostProtocolLock")!.capacity!,lock:owner,type:record.typeScript as ccc.ScriptLike},outputData:"0x01"});
  const funding=ccc.Cell.from({outPoint:{txHash:`0x${"ab".repeat(32)}`,index:0},cellOutput:{capacity:ccc.fixedPointFrom(5000),lock:owner},outputData:"0x"});
  const binaries:AdminFinancialBinaries={tippingType:elf(1),fundingLock:elf(2),protocolLock:elf(3)};
  return {protocolCell,oldProtocolCode,fundingCells:[funding],binaries};
}
it("creates fresh Tip/Funding native TypeIDs while preserving exact QA ProtocolLock and its capacity",()=>{
  const f=fixture(),original=JSON.stringify(f.oldProtocolCode.cellOutput.toBytes()),plan=buildAdminFinancialCodePlan(f),tx=plan.transaction;
  expect(plan.status).toBe("unsigned-prepared");expect(tx.outputs[0].type?.eq(f.oldProtocolCode.cellOutput.type!)).toBe(true);
  expect(tx.outputs[0].capacity).toBe(f.oldProtocolCode.cellOutput.capacity);
  expect(plan.scripts.tippingType.args).toBe(ccc.hashTypeId(tx.inputs[0],1));expect(plan.scripts.fundingLock.args).toBe(ccc.hashTypeId(tx.inputs[0],2));
  expect(plan.scripts.tippingType.hash()).not.toBe(plan.scripts.fundingLock.hash());expect(tx.inputs).toHaveLength(2);
  expect(f.oldProtocolCode.cellOutput.capacity+f.fundingCells[0].cellOutput.capacity-tx.getOutputsCapacity()).toBe(BigInt(plan.feeShannons));
  expect(JSON.stringify(f.oldProtocolCode.cellOutput.toBytes())).toBe(original);expect(plan.didSign||plan.didBroadcast||plan.didActivate).toBe(false);
});
it("reports the exact positive shortfall and never claims an underfunded draft sendable",()=>{
  const f=fixture();f.fundingCells[0].cellOutput.capacity=ccc.CellOutput.from({lock:f.fundingCells[0].cellOutput.lock},"0x").capacity;
  const plan=buildAdminFinancialCodePlan(f);expect(plan.status).toBe("funding-required");expect(BigInt(plan.additionalCapacityShannons)).toBeGreaterThan(0n);
  expect(()=>makeAdminFinancialProtocolData(f.protocolCell,plan,{complete:true,oldTips:0,protocolFunding:0,campaignFunding:0},999999999999n)).toThrow("fully funded");
});
it.each(["tippingType","fundingLock","protocolLock"] as const)("rejects a substituted %s executable before creating a proposal",name=>{
  const f=fixture();f.binaries[name]=elf(9);expect(()=>buildAdminFinancialCodePlan(f)).toThrow("reviewed candidate");
});
it("rejects a shared/wrong TypeID, another owner, typed wallet funds, and duplicate inputs",()=>{
  let f=fixture();f.oldProtocolCode.cellOutput.type=ccc.Script.from({...f.oldProtocolCode.cellOutput.type!,args:`0x${"ff".repeat(32)}`});expect(()=>buildAdminFinancialCodePlan(f)).toThrow("dedicated QA");
  f=fixture();f.oldProtocolCode.cellOutput.lock=ccc.Script.from({...f.oldProtocolCode.cellOutput.lock,args:"0x01"});expect(()=>buildAdminFinancialCodePlan(f)).toThrow("Account 1");
  f=fixture();f.fundingCells[0].cellOutput.type=f.oldProtocolCode.cellOutput.type;expect(()=>buildAdminFinancialCodePlan(f)).toThrow("untyped");
  f=fixture();f.fundingCells.push(f.fundingCells[0]);expect(()=>buildAdminFinancialCodePlan(f)).toThrow("Duplicate");
});
it("changes only the two new financial code hashes and update time, retaining roles, users, campaigns and settings",()=>{
  const f=fixture(),plan=buildAdminFinancialCodePlan(f),prior=ProtocolData.decode(f.protocolCell.outputData),before=f.protocolCell.outputData;
  const after=makeAdminFinancialProtocolData(f.protocolCell,plan,{complete:true,oldTips:0,protocolFunding:0,campaignFunding:0},ccc.numFrom(prior.last_updated)+1n);
  const expected=ProtocolData.decode(before);expected.last_updated=ccc.numFrom(prior.last_updated)+1n;expected.protocol_config.script_code_hashes.ckb_boost_tipping_type_code_hash=plan.scripts.tippingType.hash();expected.protocol_config.script_code_hashes.ckb_boost_funding_lock_code_hash=plan.scripts.fundingLock.hash();
  expect(ccc.hexFrom(ProtocolData.encode(after))).toBe(ccc.hexFrom(ProtocolData.encode(expected)));expect(f.protocolCell.outputData).toBe(before);
});
it.each([{complete:false,oldTips:0,protocolFunding:0,campaignFunding:0},{complete:true,oldTips:1,protocolFunding:0,campaignFunding:0},{complete:true,oldTips:0,protocolFunding:0,campaignFunding:1}])("blocks configuration replacement when old namespaces are nonempty or incomplete",inventory=>{
  const f=fixture(),plan=buildAdminFinancialCodePlan(f);expect(()=>makeAdminFinancialProtocolData(f.protocolCell,plan,inventory,999999999999n)).toThrow("migration");
});
it("rejects a mutated code proposal raw body before allowing a configuration delta",()=>{
  const f=fixture(),plan=buildAdminFinancialCodePlan(f);plan.transaction.outputs[0].capacity+=1n;expect(()=>makeAdminFinancialProtocolData(f.protocolCell,plan,{complete:true,oldTips:0,protocolFunding:0,campaignFunding:0},999999999999n)).toThrow("unchanged");
});

it("uses the actual raw code outputs when display scripts are replaced",()=>{
  const f=fixture(),plan=buildAdminFinancialCodePlan(f);plan.scripts.tippingType=ccc.Script.from({...plan.scripts.tippingType,args:`0x${"99".repeat(32)}`});
  const next=makeAdminFinancialProtocolData(f.protocolCell,plan,{complete:true,oldTips:0,protocolFunding:0,campaignFunding:0},999999999999n);
  expect(ccc.hexFrom(next.protocol_config.script_code_hashes.ckb_boost_tipping_type_code_hash)).toBe(plan.transaction.outputs[1].type!.hash());
});
it("rejects a substituted raw code script even when its hash summary is recomputed",()=>{
  const f=fixture(),plan=buildAdminFinancialCodePlan(f);plan.transaction.outputs[1].type=ccc.Script.from({...plan.scripts.tippingType,args:`0x${"99".repeat(32)}`});plan.transactionHash=plan.transaction.hash();
  expect(()=>makeAdminFinancialProtocolData(f.protocolCell,plan,{complete:true,oldTips:0,protocolFunding:0,campaignFunding:0},999999999999n)).toThrow("native TypeID");
});
