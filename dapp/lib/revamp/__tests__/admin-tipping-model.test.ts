import {ccc} from "@ckb-ccc/connector-react";
import {adminTipAssets, adminTipRegistryCapability, canonicalAdminTipAsset, readAdminTipDepositDelta,validateTipSettingsDraft,readProtocolTip,readAdminTips,buildProtocolTipRows,assertProtocolTipSupport,isProtocolTipApprover} from "../admin-tipping-model";
import {ConnectedTypeID,TippingData} from "ssri-ckboost/types";
import {encodeAdminRegistry,type AdminRegistryData} from "../admin-registry-model";
import type {AdminTipCapability} from "../admin-tipping-capability";
import {adminUsersFixture,userHash as h} from "./admin-users-fixtures";
jest.mock("@ckb-ccc/connector-react",()=>({ccc:jest.requireActual("@ckb-ccc/core")}));
jest.mock("@/lib/services/udt-registry",()=>({udtRegistry:{getTokenByScriptHash:()=>({network:"testnet",symbol:"TEST",decimals:6})}}));
function depositFixture(delta=3000000000n){const f=adminUsersFixture(),lock=ccc.Script.from({codeHash:h("4"),hashType:"type",args:f.scope.protocolHash});const parent=ccc.Transaction.from({inputs:[{previousOutput:{txHash:h("e"),index:0}}],outputs:[{capacity:50000000000n,lock:f.lock},{capacity:10000000000n,lock}],outputsData:["0x","0x"]});const tx=ccc.Transaction.from({inputs:[{previousOutput:{txHash:parent.hash(),index:0}},{previousOutput:{txHash:parent.hash(),index:1}}],outputs:[{capacity:10000000000n+delta,lock},{capacity:50000000000n-delta-100000000n,lock:f.lock}],outputsData:["0x","0x"]});f.client.getTransaction=jest.fn().mockResolvedValue({transaction:parent,status:"committed",blockNumber:10n});return{...f,lock,parent,tx};}
describe("Tipping complete asset and deposit evidence",()=>{
  it("preserves only an exact current legacy validity when changing other settings",()=>{
    const previous={expirationSeconds:"600",thresholdsShannons:[],approverLockHashes:[]},draft={expirationDays:"current:600",thresholdsCkb:["100"],approverLockHashes:[h("b")]};
    expect(validateTipSettingsDraft(draft,previous)).toEqual({expirationSeconds:"600",thresholdsShannons:["10000000000"],approverLockHashes:[h("b")]});
    expect(()=>validateTipSettingsDraft(draft)).toThrow(/exact current/);
    expect(()=>validateTipSettingsDraft({...draft,expirationDays:"current:86400"},previous)).toThrow(/exact current/);
    expect(validateTipSettingsDraft({...draft,expirationDays:"3"},previous).expirationSeconds).toBe("259200");
  });
  it("reads one exact public Tip for a non-Admin without opening the Admin list or forging a role",async()=>{
    const f=adminUsersFixture(),wallet=ccc.Script.from({...f.lock,args:"0x99"}),scope={...f.scope,walletLock:wallet,lockHash:wallet.hash(),address:ccc.Address.fromScript(wallet,f.client).toString()};
    const type=ccc.Script.from({codeHash:h("7"),hashType:"type",args:ccc.hexFrom(ConnectedTypeID.encode({type_id:h("b"),connected_key:scope.protocolHash}))});
    const data={target_lock_hash:f.lock.hash(),proposer_lock_hash:f.lock.hash(),supporter_lock_hashes:[],metadata:{contribution_title:"Offline public detail",short_description:"actual codec",long_description:"",contribution_type_tags:[],creation_timestamp:1795600000000n},rewards:{ckb_amount:0n,points_amount:1n,udt_assets:[],nft_assets:[]},status:"created",granted_at:0n};
    const cell=ccc.Cell.from({outPoint:{txHash:h("b"),index:0},cellOutput:{capacity:100000000000n,lock:f.protocolCell.cellOutput.lock,type},outputData:ccc.hexFrom(TippingData.encode(data))});
    f.client.findCellsPaged=jest.fn(async()=>({cells:[cell],lastCursor:"done"}));
    const rows=await readProtocolTip(scope,h("b"));expect(rows).toHaveLength(1);expect(f.client.findCellsPaged).toHaveBeenCalledWith(expect.objectContaining({scriptSearchMode:"exact",script:expect.objectContaining({args:type.args})}),"asc",100,undefined);
    await expect(readAdminTips(scope)).rejects.toThrow(/Only current platform administrators/);
    expect(buildProtocolTipRows(scope,rows,{expirationSeconds:"0",thresholdsShannons:[],approverLockHashes:[]})[0].title).toBe("Offline public detail");
  });
  it("requires actual matching Registry bytes/capability and still reserves first approval for Admin",()=>{
    const f=adminUsersFixture(),wallet=ccc.Script.from({...f.lock,args:"0x99"}),scope={...f.scope,walletLock:wallet,lockHash:wallet.hash(),address:ccc.Address.fromScript(wallet,f.client).toString()};
    const script=ccc.Script.from({codeHash:h("e"),hashType:"type",args:ccc.hexFrom(ccc.bytesConcat(h("d"),scope.protocolHash))});
    const data:AdminRegistryData={schema:"ckboost-admin-registry/v1",protocolTypeHash:scope.protocolHash,revision:"0",tipping:{expirationSeconds:"0",thresholdsShannons:[],approverLockHashes:[scope.lockHash]},attestations:[],periods:[]};
    const cell=ccc.Cell.from({outPoint:{txHash:h("d"),index:0},cellOutput:{capacity:100000000000n,lock:script,type:script},outputData:encodeAdminRegistry(data)}),snapshot={available:true,unavailableReason:null,cell,data,transactionHash:cell.outPoint.txHash};
    const capability:AdminTipCapability={available:true,unavailableReason:null,manifest:{schema:"ckboost-admin-tipping-deployment/v1",network:"testnet",releaseId:"synthetic-offline-only",protocolTypeHash:scope.protocolHash,registryTypeHash:script.hash(),scripts:{tippingType:script,fundingLock:script,protocolLock:script}}};
    expect(isProtocolTipApprover(scope,snapshot,capability)).toBe(true);
    expect(isProtocolTipApprover(scope,snapshot,{...capability,available:false})).toBe(false);
    expect(isProtocolTipApprover(scope,snapshot,{...capability,manifest:{...capability.manifest!,registryTypeHash:h("c")}})).toBe(false);
    const forged={...snapshot,data:{...data,tipping:{...data.tipping,approverLockHashes:[scope.lockHash,h("f")]}}};expect(isProtocolTipApprover(scope,forged,capability)).toBe(false);
    const tipType={codeHash:h("7"),hashType:"type" as const,args:ccc.hexFrom(ConnectedTypeID.encode({type_id:h("b"),connected_key:scope.protocolHash}))};
    const tip=TippingData.decode(TippingData.encode({target_lock_hash:f.lock.hash(),proposer_lock_hash:f.lock.hash(),supporter_lock_hashes:[],metadata:{contribution_title:"Offline first-approval fixture",short_description:"",long_description:"",contribution_type_tags:[],creation_timestamp:1795600000000n},rewards:{ckb_amount:0n,points_amount:1n,udt_assets:[],nft_assets:[]},status:"created",granted_at:0n}));
    const tipCell=ccc.Cell.from({outPoint:{txHash:h("b"),index:0},cellOutput:{capacity:100000000000n,lock:f.protocolCell.cellOutput.lock,type:tipType},outputData:ccc.hexFrom(TippingData.encode(tip))}),record={id:h("b"),cell:tipCell,data:tip};
    expect(()=>assertProtocolTipSupport(scope,record,snapshot,capability)).toThrow(/first approval.*Admin/);
    expect(()=>assertProtocolTipSupport(f.scope,record,snapshot,capability)).not.toThrow();
  });
  it("does not let a matching asset label/id substitute another script, precision or asset kind",()=>{const f=adminUsersFixture(),assets=adminTipAssets(f.scope);expect(canonicalAdminTipAsset(f.scope,assets[1])).toEqual(assets[1]);expect(()=>canonicalAdminTipAsset(f.scope,{...assets[1],kind:"udt",typeScript:{codeHash:h("a"),hashType:"type",args:h("b")}})).toThrow(/complete configured asset/);expect(()=>canonicalAdminTipAsset(f.scope,{...assets[1],decimals:0})).toThrow(/complete configured asset/);expect(()=>canonicalAdminTipAsset(f.scope,{...assets[0],typeScript:{...assets[0].typeScript!,args:h("f")}})).toThrow(/complete configured asset/);});
  it("proves the exact pool net increase and Admin native capacity spend using canonical input parents",async()=>{const f=depositFixture();await expect(readAdminTipDepositDelta(f.scope,f.tx,adminTipAssets(f.scope)[1])).resolves.toBe(3000000000n);expect(f.client.getTransaction).toHaveBeenCalledTimes(1);});
  it("does not count an unchanged recycled pool output as a new deposit",async()=>{const f=depositFixture(0n);await expect(readAdminTipDepositDelta(f.scope,f.tx,adminTipAssets(f.scope)[1])).resolves.toBe(0n);});
  it("rejects malformed parents and a transaction without this Admin's ordinary signed capacity spend",async()=>{const bad=depositFixture();bad.client.getTransaction=jest.fn().mockResolvedValue({transaction:bad.tx,status:"committed",blockNumber:10n});await expect(readAdminTipDepositDelta(bad.scope,bad.tx,adminTipAssets(bad.scope)[1])).rejects.toThrow(/input parent/);const missing=depositFixture();missing.tx.inputs=[ccc.CellInput.from({previousOutput:{txHash:missing.parent.hash(),index:1}})];await expect(readAdminTipDepositDelta(missing.scope,missing.tx,adminTipAssets(missing.scope)[1])).rejects.toThrow(/Admin's signed native/);});
  it("keeps independent settings unavailable until paired VM/code/registry evidence exists",()=>{const f=adminUsersFixture();expect(adminTipRegistryCapability(f.scope)).toMatchObject({available:false,unavailableReason:expect.stringContaining("paired, reviewed")});});
});
