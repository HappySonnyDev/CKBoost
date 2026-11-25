import {ccc} from "@ckb-ccc/connector-react";
import {ProtocolData} from "ssri-ckboost/types";
import {readAdminTipCapability,type AdminTipDeploymentManifest} from "../admin-tipping-capability";
import type {AdminTipReleasePin} from "@/lib/ckb/admin-tipping-release-pins";
import {encodeAdminRegistry} from "../admin-registry-model";
import {makeProfileReadScope} from "../profile-model";
import {adminUsersFixture,userHash as h} from "./admin-users-fixtures";

let mockPins:AdminTipReleasePin[]=[],mockRuntime:{protocol:{typeHash:string}}|null=null;
jest.mock("@ckb-ccc/connector-react",()=>({ccc:jest.requireActual("@ckb-ccc/core")}));
jest.mock("@/lib/ckb/admin-tipping-release-pins",()=>({get ADMIN_TIP_RELEASE_PINS(){return mockPins;}}));
jest.mock("@/lib/ckb/isolated-runtime.mjs",()=>({getIsolatedRuntime:()=>mockRuntime,ISOLATED_QA_PINS:[]}));

/** Pure public synthetic cells. Pins only exist in this test module and are
 * never installed as a deployable release or used for any node/wallet action. */
function fixture(){
  const f=adminUsersFixture(),TYPE_ID="0x00000000000000000000000000000000000000000000000000545950455f4944";
  const scripts={tippingType:ccc.Script.from({codeHash:TYPE_ID,hashType:"type",args:h("b")}),fundingLock:ccc.Script.from({codeHash:TYPE_ID,hashType:"type",args:h("c")}),protocolLock:ccc.Script.from({codeHash:TYPE_ID,hashType:"type",args:"0x06661a546d171ae6f280f3f1363070c7d1e7ad7dc1032d566c7b16f804d57ab4"})};
  expect(scripts.protocolLock.hash()).toBe("0xe91b5a78463c293318331c21d372e031eb9ffad87b379fbe0563222fcdd28815");
  const protocol=ProtocolData.decode(f.protocolCell.outputData),codes=protocol.protocol_config.script_code_hashes;
  codes.ckb_boost_tipping_type_code_hash=scripts.tippingType.hash();codes.ckb_boost_funding_lock_code_hash=scripts.fundingLock.hash();codes.ckb_boost_protocol_lock_code_hash=scripts.protocolLock.hash();
  const cell=ccc.Cell.from({...f.protocolCell,outputData:ccc.hexFrom(ProtocolData.encode(protocol))}),wallet=ccc.Address.fromScript({...f.lock,args:"0x99"},f.client),scope=makeProfileReadScope(f.client,cell,wallet,"testnet");
  const registryType=ccc.Script.from({codeHash:h("d"),hashType:"type",args:ccc.hexFrom(ccc.bytesConcat(h("e"),scope.protocolHash))});
  const data={schema:"ckboost-admin-registry/v1" as const,protocolTypeHash:scope.protocolHash,revision:"0",tipping:{expirationSeconds:"600",thresholdsShannons:["10000000000"],approverLockHashes:[scope.lockHash]},attestations:[],periods:[]};
  const registryCell=ccc.Cell.from({outPoint:{txHash:h("d"),index:0},cellOutput:{capacity:100000000000n,lock:registryType,type:registryType},outputData:encodeAdminRegistry(data)});
  const registry={available:true,unavailableReason:null,cell:registryCell,data,transactionHash:registryCell.outPoint.txHash};
  const cells=(Object.keys(scripts) as Array<keyof typeof scripts>).map((name,index)=>ccc.Cell.from({outPoint:{txHash:h(String(index+1)),index:0},cellOutput:{capacity:100000000000n,lock:f.lock,type:scripts[name]},outputData:ccc.hexFrom([index+1,index+10])}));
  const manifest:AdminTipDeploymentManifest={schema:"ckboost-admin-tipping-deployment/v1",network:"testnet",releaseId:"synthetic-offline-capability",protocolTypeHash:scope.protocolHash,registryTypeHash:registryType.hash(),scripts};
  const dataHashes={tippingType:ccc.hashCkb(cells[0].outputData),fundingLock:ccc.hashCkb(cells[1].outputData),protocolLock:ccc.hashCkb(cells[2].outputData)};
  mockPins=[{releaseId:manifest.releaseId,protocolTypeHash:scope.protocolHash,registryTypeHash:registryType.hash(),dataHashes}];mockRuntime={protocol:{typeHash:scope.protocolHash}};
  process.env.NEXT_PUBLIC_CKBOOST_ADMIN_TIPPING=JSON.stringify(manifest);
  scope.client.findCellsPaged=jest.fn(async search=>({cells:cells.filter(value=>value.cellOutput.type?.eq(search.script)),lastCursor:"done"}));
  scope.client.getCellLive=jest.fn(async point=>cells.find(cell=>cell.outPoint.eq(point)));
  return {scope,registry,cells,manifest};
}
beforeEach(()=>{mockPins=[];mockRuntime=null;});
afterEach(()=>{delete process.env.NEXT_PUBLIC_CKBOOST_ADMIN_TIPPING;});
test("a non-Admin obtains capability only after all three exact current code byte hashes and Registry identity match",async()=>{
  const f=fixture();await expect(readAdminTipCapability(f.scope,f.registry)).resolves.toMatchObject({available:true,manifest:f.manifest});expect(f.scope.client.findCellsPaged).toHaveBeenCalledTimes(3);
});
test("an environment declaration without a reviewed source pin cannot admit an Approver",async()=>{
  const f=fixture();mockPins=[];await expect(readAdminTipCapability(f.scope,f.registry)).rejects.toThrow(/were not reviewed/);expect(f.scope.client.findCellsPaged).not.toHaveBeenCalled();
});
test("wrong executable bytes fail the capability proof instead of granting the Registry's listed wallet",async()=>{
  const f=fixture();f.scope.client.findCellsPaged=jest.fn(async search=>({cells:f.cells.filter(value=>value.cellOutput.type?.eq(search.script)).map(value=>ccc.Cell.from({...value,outputData:"0xbad0"})),lastCursor:"done"}));
  await expect(readAdminTipCapability(f.scope,f.registry)).rejects.toThrow(/differs from the reviewed release/);
});
test("an otherwise valid approver registry for a different full state identity cannot grant capability",async()=>{
  const f=fixture();const wrong=ccc.Cell.from({...f.registry.cell,cellOutput:{...f.registry.cell.cellOutput,type:{...f.registry.cell.cellOutput.type!,args:ccc.hexFrom(ccc.bytesConcat(h("a"),f.scope.protocolHash))}}});
  await expect(readAdminTipCapability(f.scope,{...f.registry,cell:wrong})).rejects.toThrow(/not the current exact registry/);
});

test("spent indexed code cannot stand in for the actual live reviewed executable",async()=>{
  const f=fixture();f.scope.client.getCellLive=jest.fn().mockResolvedValue(undefined);
  await expect(readAdminTipCapability(f.scope,f.registry)).rejects.toThrow(/no longer live|differs|changed|live/);
});
