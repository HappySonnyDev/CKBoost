import {ccc} from "@ckb-ccc/connector-react";
import runtimeSource from "../../../config/qa/ckboost-testnet.json";
import source from "../../../config/qa/admin-registry-upgrade-plan.json";
import {confirmAdminRegistryUpgrade} from "../testnet-admin-upgrade";
import {readAdminFinancialReview,prepareAdminFinancialReview,exportAdminFinancialReview,assertFinancialReviewUnchanged,validateFinancialReviewFile} from "../testnet-admin-financial-review";
import type {AdminFinancialBinaries} from "../testnet-admin-financial-upgrade";

let mockRuntime:typeof runtimeSource|null=null;
jest.mock("@ckb-ccc/connector-react",()=>({ccc:jest.requireActual("@ckb-ccc/core")}));
jest.mock("../../../config/qa/ckboost-testnet.json",()=>JSON.parse(JSON.stringify(jest.requireActual("../../../config/qa/ckboost-testnet.json"))));
jest.mock("@/lib/ckb/isolated-runtime.mjs",()=>({getIsolatedRuntime:()=>mockRuntime}));
jest.mock("../testnet-admin-upgrade",()=>({...jest.requireActual("../testnet-admin-upgrade"),confirmAdminRegistryUpgrade:jest.fn()}));
jest.mock("../../../../contracts/admin-tipping/release-pins.mjs",()=>{
  const c=require("@ckb-ccc/core"),elf=(id:number)=>{const data=new Uint8Array(25);data.set([0x7f,0x45,0x4c,0x46,2,1]);data[16]=2;data[18]=243;data[20]=1;data[24]=id;return data;};
  return {ADMIN_TIPPING_RELEASE:{protocolTypeHash:"0x4eacaf9b1a120d2bfd99f26fcedfdcfe6ef116484e9b478b0a104a872316e034",registryTypeHash:"0x97e23b14d33e0445c1eac09f1948e2c3652547bfbb7fb7db56978f48baff9690",releaseId:"synthetic-offline-only",byteLengths:{tippingType:25,fundingLock:25,protocolLock:25},dataHashes:{tippingType:c.hashCkb(elf(1)),fundingLock:c.hashCkb(elf(2)),protocolLock:c.hashCkb(elf(3))}}};
});
jest.mock("../../ckb/permissions-release-pins.mjs",()=>({PERMISSION_REVIEW_RELEASES:{"protocol-lock":{byteLength:1,dataHash:require("@ckb-ccc/core").hashCkb("0x01")}}}));
const h=(n:number)=>`0x${n.toString(16).padStart(64,"0")}` as ccc.Hex;
const elf=(id:number)=>{const data=new Uint8Array(25);data.set([0x7f,0x45,0x4c,0x46,2,1]);data[16]=2;data[18]=243;data[20]=1;data[24]=id;return ccc.hexFrom(data);};
function fixture(){
  mockRuntime=JSON.parse(JSON.stringify(runtimeSource));const owner=ccc.Script.from(source.owner.lock as ccc.ScriptLike),protocolType=ccc.Script.from(source.protocol.typeScript as ccc.ScriptLike),codeType=ccc.Script.from(mockRuntime!.current.testnet.ckboostProtocolLock.typeScript as ccc.ScriptLike);
  const parents=[
    ccc.Transaction.from({inputs:[{previousOutput:{txHash:h(1),index:0}}],outputs:[{capacity:source.protocol.capacityShannons,lock:source.protocol.lockScript as ccc.ScriptLike,type:protocolType}],outputsData:[source.protocol.outputData]}),
    ccc.Transaction.from({inputs:[{previousOutput:{txHash:h(2),index:0}}],outputs:[{capacity:1000000000000n,lock:owner,type:codeType}],outputsData:["0x01"]}),
    ccc.Transaction.from({inputs:[{previousOutput:{txHash:h(3),index:0}}],outputs:[{capacity:500000000000n,lock:owner}],outputsData:["0x"]}),
  ];
  const cells=parents.map(tx=>ccc.Cell.from({outPoint:{txHash:tx.hash(),index:0},cellOutput:tx.outputs[0],outputData:tx.outputsData[0]}));
  mockRuntime!.current.testnet.ckboostProtocolLock.transactionHash=cells[1].outPoint.txHash;
  runtimeSource.current.testnet.ckboostProtocolLock.transactionHash=cells[1].outPoint.txHash;
  runtimeSource.sources.effectiveProfile.dependencies.find(row=>row.name==="ckboostProtocolLock")!.capacity=cells[1].cellOutput.capacity.toString();
  const client={url:"https://testnet.ckb.dev/",addressPrefix:"ckt",findCellsPaged:jest.fn(async(search:ccc.ClientIndexerSearchKeyLike)=>({cells:search.scriptType==="lock"?[cells[2]]:ccc.Script.from(search.script).eq(protocolType)?[cells[0]]:[cells[1]],lastCursor:"done"})),getTransaction:jest.fn(async(hash:ccc.HexLike)=>{const transaction=parents.find(tx=>tx.hash()===hash);return transaction?{transaction,status:"committed",blockNumber:10n}:undefined;}),getCellLive:jest.fn(async(point:ccc.OutPointLike)=>cells.find(cell=>cell.outPoint.eq(point))),sendTransaction:jest.fn()} as unknown as ccc.Client;
  jest.mocked(confirmAdminRegistryUpgrade).mockImplementation(async(_client,stage)=>({status:"unknown",stage,transactionHash:h(stage==="code"?4:5),message:"Synthetic missing Registry"}));
  const binaries:AdminFinancialBinaries={tippingType:elf(1),fundingLock:elf(2),protocolLock:elf(3)};
  return {client,owner,cells,parents,binaries};
}
beforeEach(()=>jest.clearAllMocks());
test("reads canonical live QA inputs, reports real plain capacity and remains blocked while Registry stages are unconfirmed",async()=>{
  const f=fixture(),value=await readAdminFinancialReview(f.client,f.owner);
  expect(value.liveBalanceShannons).toBe("500000000000");expect(value.ownerMatches).toBe(true);expect(value.registryConfirmed).toBe(false);expect(value.registryState).toBeNull();expect(value.blockedReasons.join(" ")).toMatch(/Both fixed Registry stages/);expect(BigInt(value.additionalCapacityEstimateShannons)).toBeGreaterThan(0n);
  await expect(prepareAdminFinancialReview(f.client,f.owner,f.binaries)).rejects.toThrow(/Both fixed Registry stages/);expect(f.client.sendTransaction).not.toHaveBeenCalled();
});
test("requires the exact runtime and Testnet network before any RPC",async()=>{
  const f=fixture();mockRuntime=null;await expect(readAdminFinancialReview(f.client,f.owner)).rejects.toThrow(/isolated QA protocol/);expect(f.client.findCellsPaged).not.toHaveBeenCalled();
});
test("a canonical-parent mismatch or spent current input blocks the review",async()=>{
  const f=fixture();jest.mocked(f.client.getTransaction).mockResolvedValue({transaction:f.parents[2],status:"committed",blockNumber:10n} as Awaited<ReturnType<ccc.Client["getTransaction"]>>);await expect(readAdminFinancialReview(f.client,f.owner)).rejects.toThrow(/canonical committed parent/);
  const spent=fixture();jest.mocked(spent.client.getCellLive).mockResolvedValue(undefined);await expect(readAdminFinancialReview(spent.client,spent.owner)).rejects.toThrow(/no longer live/);
});
test("after independent Registry confirmation it constructs only an unsigned exact-owner proposal and exports no activation claim",async()=>{
  const f=fixture();jest.mocked(confirmAdminRegistryUpgrade).mockImplementation(async(_client,stage)=>({status:"confirmed",stage,transactionHash:h(stage==="code"?4:5),blockNumber:"0xa",manifest:null}));
  const {snapshot,plan}=await prepareAdminFinancialReview(f.client,f.owner,f.binaries);expect(plan.status).toBe("unsigned-prepared");expect(plan.transaction.inputs).toHaveLength(2);expect(plan.transaction.inputs[0].previousOutput.eq(f.cells[1].outPoint)).toBe(true);
  const exported=exportAdminFinancialReview(plan,snapshot);expect(exported).toMatchObject({readOnly:true,didSign:false,didBroadcast:false,didActivate:false});expect(exported.unsignedTransaction).toBe(ccc.hexFrom(plan.transaction.toBytes()));expect(f.client.sendTransaction).not.toHaveBeenCalled();
  const wrong={...snapshot,ownerMatches:false};expect(()=>exportAdminFinancialReview(plan,wrong)).toThrow(/fully funded unsigned/);
  const changed={...snapshot,fundingCells:[]};expect(()=>assertFinancialReviewUnchanged(snapshot,changed,plan)).toThrow(/funding input changed/);
  plan.transaction.outputs[0].capacity++;expect(()=>exportAdminFinancialReview(plan,snapshot)).toThrow(/unchanged/);
});
test("a different connected wallet cannot prepare even when both Registry stages are confirmed",async()=>{
  const f=fixture();jest.mocked(confirmAdminRegistryUpgrade).mockImplementation(async(_client,stage)=>({status:"confirmed",stage,transactionHash:h(4),blockNumber:"0xa",manifest:null}));
  await expect(prepareAdminFinancialReview(f.client,{...f.owner,args:"0x99"},f.binaries)).rejects.toThrow(/Connect Account 1/);expect(f.client.sendTransaction).not.toHaveBeenCalled();
});
test("checks byte pins before reading the chain and ignores late results after scope cancellation",async()=>{
  const f=fixture();expect(()=>validateFinancialReviewFile("tippingType",ccc.bytesFrom(elf(1)))).not.toThrow();expect(()=>validateFinancialReviewFile("tippingType",ccc.bytesFrom(elf(2)))).toThrow(/size and hash/);
  await expect(prepareAdminFinancialReview(f.client,f.owner,{...f.binaries,tippingType:elf(9)})).rejects.toThrow(/reviewed candidate/);expect(f.client.findCellsPaged).not.toHaveBeenCalled();
  await expect(readAdminFinancialReview(f.client,f.owner,()=>false)).rejects.toThrow(/review changed/);expect(f.client.findCellsPaged).not.toHaveBeenCalled();
});
