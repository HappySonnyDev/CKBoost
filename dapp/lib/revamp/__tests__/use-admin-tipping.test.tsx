import React from "react";
import {act,renderHook,waitFor} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {ccc} from "@ckb-ccc/connector-react";
import {ConnectedTypeID,ProtocolData,TippingData} from "ssri-ckboost/types";
import {useAdminTipping} from "../use-admin-tipping";
import {readAdminTips,readProtocolTip,readProtocolTipPool,readProtocolTipHistory,readAdminTipPool,readAdminTipHistory,adminTipAssets,type AdminTipDraft} from "../admin-tipping-model";
import {readAdminRegistry,readProtocolAdminRegistry,saveAdminTipSettings} from "../admin-registry-service";
import {readAdminTipCapability,makeAdminTipExecutionPolicy,type AdminTipCapability} from "../admin-tipping-capability";
import {encodeAdminRegistry,type AdminRegistryData} from "../admin-registry-model";
import {makeProfileReadScope} from "../profile-model";
import {readAdminUsers} from "../admin-users-model";
import {adminUsersFixture,userHash as h} from "./admin-users-fixtures";
let mockFixture:ReturnType<typeof adminUsersFixture>,mockSigner:ccc.Signer|undefined,mockInfo:object|undefined,mockQa:{network:string;protocol:{typeHash:string}}|null;
let mockCapability:AdminTipCapability;
let mockCurrent:Awaited<ReturnType<typeof readAdminTips>>,mockTransaction:ccc.Transaction|null;
const mockPublish=jest.fn(),mockRefresh=jest.fn().mockResolvedValue(undefined),mockRegister=jest.fn();
jest.mock("@ckb-ccc/connector-react",()=>({ccc:{...jest.requireActual("@ckb-ccc/core"),useSigner:()=>mockSigner,useCcc:()=>({client:mockFixture.client,signerInfo:mockInfo,open:()=>{}})},ssri:{ExecutorJsonRpc:jest.fn()}}));
jest.mock("@/lib/providers/protocol-provider",()=>({useProtocol:()=>({protocolCell:mockFixture.protocolCell,isLoading:false,error:null,refreshProtocolData:mockRefresh})}));
jest.mock("@/lib/providers/pending-transaction-provider",()=>({usePendingTransactions:()=>({confirmationTarget:0,register:mockRegister})}));
jest.mock("@/lib/ckb/current-deployment",()=>({currentDeployment:{getCurrentNetwork:()=>"testnet"}}));
jest.mock("@/lib/ckb/isolated-runtime.mjs",()=>({getIsolatedRuntime:()=>mockQa}));
jest.mock("@/lib/ckb/deployment-manager",()=>({deploymentManager:{getContractCodeHash:(_network:string,name:string)=>({ckboostTippingType:h("7"),ckboostProtocolLock:h("2"),ckboostFundingLock:h("4")})[name as "ckboostTippingType"],getContractOutPoint:()=>({txHash:h("e"),index:0})}}));
jest.mock("../discovery-read-client",()=>({getDiscoveryReadClient:()=>mockFixture.client}));
jest.mock("../discovery-cells",()=>({...jest.requireActual("../discovery-cells"),readDiscoveryProtocol:jest.fn(async()=>mockFixture.protocolCell)}));
jest.mock("../admin-users-model",()=>({...jest.requireActual("../admin-users-model"),readAdminUsers:jest.fn()}));
jest.mock("../admin-registry-service",()=>({readAdminRegistry:jest.fn(),readProtocolAdminRegistry:jest.fn(),saveAdminTipSettings:jest.fn()}));
jest.mock("../admin-tipping-model",()=>({...jest.requireActual("../admin-tipping-model"),readAdminTips:jest.fn(),readAdminTipPool:jest.fn(),readAdminTipHistory:jest.fn(),readProtocolTip:jest.fn(),readProtocolTipPool:jest.fn(),readProtocolTipHistory:jest.fn()}));
jest.mock("@/lib/services/udt-registry",()=>({udtRegistry:{getTokenByScriptHash:()=>undefined}}));
jest.mock("@/lib/services/tipping-service",()=>({TippingService:jest.fn().mockImplementation((signer:ccc.Signer)=>({updateTipping:(data:unknown)=>mockPublish(signer,data),fundProtocolWithCKB:()=>{throw Error("Not used by these tests");}}))}));
jest.mock("../admin-tipping-capability",()=>({...jest.requireActual("../admin-tipping-capability"),readAdminTipCapability:jest.fn(),makeAdminTipExecutionPolicy:jest.fn()}));
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return{promise,resolve};}
function setup(options:{tipId?:string;historyRequested?:boolean}={}){const query=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});const wrapper=({children}:{children:React.ReactNode})=><QueryClientProvider client={query}>{children}</QueryClientProvider>;return renderHook(props=>useAdminTipping(props),{wrapper,initialProps:options});}
function reviewerFixture({first=false,registered=true,paired=true}={}) {
  const f=mockFixture,data=ProtocolData.decode(f.protocolCell.outputData);
  data.protocol_config.admin_lock_hash_vec=[f.targetLock.hash()];
  f.protocolCell=ccc.Cell.from({...f.protocolCell,outputData:ccc.hexFrom(ProtocolData.encode(data))});
  f.scope=makeProfileReadScope(f.client,f.protocolCell,f.address,"testnet");
  const registryScript=ccc.Script.from({codeHash:h("e"),hashType:"type",args:ccc.hexFrom(ccc.bytesConcat(h("d"),f.scope.protocolHash))});
  const registry:AdminRegistryData={schema:"ckboost-admin-registry/v1",protocolTypeHash:f.scope.protocolHash,revision:"1",tipping:{expirationSeconds:"86400",thresholdsShannons:["10000000000"],approverLockHashes:registered?[f.scope.lockHash]:[]},attestations:[],periods:[]};
  const registryCell=ccc.Cell.from({outPoint:{txHash:h("d"),index:0},cellOutput:{capacity:100000000000n,lock:registryScript,type:registryScript},outputData:encodeAdminRegistry(registry)});
  const snapshot={available:true,unavailableReason:null,cell:registryCell,data:registry,transactionHash:registryCell.outPoint.txHash};
  jest.mocked(readAdminRegistry).mockResolvedValue(snapshot);jest.mocked(readProtocolAdminRegistry).mockResolvedValue(snapshot);
  mockCapability=paired?{available:true,unavailableReason:null,manifest:{schema:"ckboost-admin-tipping-deployment/v1",network:"testnet",releaseId:"offline-hook-test",protocolTypeHash:f.scope.protocolHash,registryTypeHash:registryScript.hash(),scripts:{tippingType:f.lock,fundingLock:f.lock,protocolLock:f.lock}}}:{available:false,unavailableReason:"Paired code proof unavailable",manifest:null};
  const id=h("b"),tipType=ccc.Script.from({codeHash:h("7"),hashType:"type",args:ccc.hexFrom(ConnectedTypeID.encode({type_id:id,connected_key:f.scope.protocolHash}))});
  const tip=TippingData.decode(TippingData.encode({target_lock_hash:f.targetLock.hash(),proposer_lock_hash:f.targetLock.hash(),supporter_lock_hashes:first?[]:[f.targetLock.hash()],metadata:{contribution_title:"Offline reviewer permission fixture",short_description:"No node or real wallet is used",long_description:"",contribution_type_tags:[],creation_timestamp:BigInt(Date.now())},rewards:{ckb_amount:10000000000n,points_amount:1n,udt_assets:[],nft_assets:[]},status:first?"created":"approved",granted_at:0n}));
  const tipLock=ccc.Script.from({codeHash:h("2"),hashType:"type",args:ccc.hexFrom(ConnectedTypeID.encode({type_id:f.targetLock.hash(),connected_key:f.scope.protocolHash}))});
  const parent=ccc.Transaction.from({inputs:[{previousOutput:{txHash:h("a"),index:1}}],outputs:[{capacity:50000000000n,lock:tipLock,type:tipType}],outputsData:[ccc.hexFrom(TippingData.encode(tip))]});
  const tipCell=ccc.Cell.from({outPoint:{txHash:parent.hash(),index:0},cellOutput:parent.outputs[0],outputData:parent.outputsData[0]});
  mockCurrent=[{id,cell:tipCell,data:tip}];
  const nativeParent=ccc.Transaction.from({inputs:[{previousOutput:{txHash:h("c"),index:1}}],outputs:[{capacity:100000000000n,lock:f.lock}],outputsData:["0x"]});
  const native=ccc.Cell.from({outPoint:{txHash:nativeParent.hash(),index:0},cellOutput:nativeParent.outputs[0],outputData:"0x"});
  const parentBytes=parent.toBytes(),parentHash=parent.hash(),nativeBytes=nativeParent.toBytes(),nativeHash=nativeParent.hash();
  f.client.getCell=jest.fn(async point=>ccc.OutPoint.from(point).eq(native.outPoint)?native:tipCell);
  f.client.getTransaction=jest.fn(async hash=>{const transaction=mockTransaction?.hash()===hash?mockTransaction:parentHash===hash?ccc.Transaction.fromBytes(parentBytes):nativeHash===hash?ccc.Transaction.fromBytes(nativeBytes):null;return transaction?{transaction,status:"committed",blockNumber:10n} as Awaited<ReturnType<ccc.Client["getTransaction"]>>:undefined;});
  f.client.getHeaderByNumber=jest.fn(async number=>({number:ccc.numFrom(number),hash:h("e"),timestamp:BigInt(Date.now())} as ccc.ClientBlockHeader));
  f.client.getCellLive=jest.fn(async point=>mockCurrent.find(row=>row.cell.outPoint.eq(point))?.cell);
  mockPublish.mockImplementation(async(signer:ccc.Signer,next:Parameters<typeof TippingData.encode>[0])=>signer.sendTransaction(ccc.Transaction.from({inputs:[{previousOutput:tipCell.outPoint},{previousOutput:native.outPoint}],outputs:[tipCell.cellOutput,{capacity:99900000000n,lock:f.lock}],outputsData:[ccc.hexFrom(TippingData.encode(next)),"0x"]})));
  return {id,registry,snapshot,tipCell,native,parent:ccc.Transaction.fromBytes(parentBytes),nativeParent:ccc.Transaction.fromBytes(nativeBytes)};
}
function revokedSnapshot(f:ReturnType<typeof reviewerFixture>){const data={...f.registry,tipping:{...f.registry.tipping,approverLockHashes:[]}};return {...f.snapshot,data,cell:ccc.Cell.from({...f.snapshot.cell,outputData:encodeAdminRegistry(data)})};}
const draft=():AdminTipDraft=>({title:"A real-scoped QA proposal",recipient:mockFixture.targetAddress.toString(),summary:"Synthetic offline transaction test",rewards:[{assetId:"points",amount:"1"}]});
beforeEach(()=>{jest.clearAllMocks();localStorage.clear();mockFixture=adminUsersFixture();mockCurrent=[];mockTransaction=null;mockCapability={available:false,unavailableReason:"Independent tip settings require the paired, reviewed Tipping/Funding contract and SDK deployment.",manifest:null};mockQa={network:"testnet",protocol:{typeHash:mockFixture.scope.protocolHash}};
  const native=ccc.Cell.from({outPoint:{txHash:h("c"),index:0},cellOutput:{capacity:100000000000n,lock:mockFixture.lock},outputData:"0x"});mockFixture.client.getCell=jest.fn(async()=>native);mockFixture.client.waitTransaction=jest.fn().mockResolvedValue({});
  mockFixture.client.getTransaction=jest.fn(async()=>mockTransaction?{transaction:mockTransaction,status:"committed",blockNumber:10n} as Awaited<ReturnType<ccc.Client["getTransaction"]>>:undefined);
  mockFixture.client.sendTransaction=jest.fn(async value=>{mockTransaction=ccc.Transaction.from(value);const cell=ccc.Cell.from({outPoint:{txHash:mockTransaction.hash(),index:0},cellOutput:mockTransaction.outputs[0],outputData:mockTransaction.outputsData[0]});const data=TippingData.decode(cell.outputData),id=ccc.hexFrom(ConnectedTypeID.decode(cell.cellOutput.type!.args).type_id);mockCurrent=[{id,cell,data}];return mockTransaction.hash();});
  mockSigner={client:mockFixture.client,getRecommendedAddressObj:jest.fn().mockResolvedValue(mockFixture.address),sendTransaction:jest.fn(async function(this:ccc.Signer,tx:ccc.TransactionLike){return this.client.sendTransaction(tx);})} as unknown as ccc.Signer;mockInfo={signer:mockSigner};
  jest.mocked(readAdminTips).mockImplementation(async()=>mockCurrent);jest.mocked(readProtocolTip).mockImplementation(async()=>mockCurrent);jest.mocked(readProtocolTipPool).mockResolvedValue({ckb:100000000000n,udts:[],cells:[]});jest.mocked(readProtocolTipHistory).mockResolvedValue([]);jest.mocked(readProtocolAdminRegistry).mockImplementation(async scope=>readAdminRegistry(scope));jest.mocked(readAdminTipCapability).mockImplementation(async()=>mockCapability);jest.mocked(makeAdminTipExecutionPolicy).mockImplementation(async(scope,registry)=>mockCapability.available?{protocolTypeHash:scope.protocolHash,registryTypeHash:mockCapability.manifest!.registryTypeHash,registryCell:registry.cell!,declaredAtMs:BigInt(Date.now())}:null);jest.mocked(readAdminTipPool).mockResolvedValue({ckb:0n,udts:[],cells:[]});jest.mocked(readAdminTipHistory).mockResolvedValue([]);jest.mocked(readAdminUsers).mockResolvedValue([]);jest.mocked(readAdminRegistry).mockResolvedValue({available:false,unavailableReason:"Registry upgrade pending",cell:null,data:null,transactionHash:null});
  mockPublish.mockImplementation(async(signer:ccc.Signer,data:Parameters<typeof TippingData.encode>[0])=>{const input=ccc.CellInput.from({previousOutput:native.outPoint}),id=ccc.hashTypeId(input,0),type={codeHash:h("7"),hashType:"type" as const,args:ccc.hexFrom(ConnectedTypeID.encode({type_id:id,connected_key:mockFixture.scope.protocolHash}))};const tx=ccc.Transaction.from({inputs:[input],outputs:[{capacity:50000000000n,lock:mockFixture.protocolCell.cellOutput.lock,type},{capacity:49900000000n,lock:mockFixture.lock}],outputsData:[ccc.hexFrom(TippingData.encode(data)),"0x"]});return signer.sendTransaction(tx);});
});
describe("Tipping scope, unknown attempts and independent capability",()=>{
  it("does not read while disconnected and keeps history lazy for the list",async()=>{mockSigner=undefined;mockInfo=undefined;const first=setup();expect(first.result.current.access).toBe("disconnected");expect(readAdminTips).not.toHaveBeenCalled();first.unmount();});
  it("discards late records when the same Signer account changes",async()=>{const old=deferred<Awaited<ReturnType<typeof readAdminTips>>>();jest.mocked(readAdminTips).mockReturnValue(old.promise);const{result}=setup();await waitFor(()=>expect(readAdminTips).toHaveBeenCalledTimes(1));jest.mocked(mockSigner!.getRecommendedAddressObj).mockResolvedValue(ccc.Address.fromScript({...mockFixture.lock,args:"0x99"},mockFixture.client));await act(async()=>old.resolve([]));await waitFor(()=>expect(result.current.access).toBe("denied"));expect(result.current.rows).toBeNull();});
  it("blocks creation outside the explicit exact QA profile without requesting a signature",async()=>{const{result}=setup();await waitFor(()=>expect(result.current.access).toBe("allowed"));mockQa=null;await expect(result.current.createProposal(draft())).rejects.toThrow(/isolated Testnet QA protocol/);expect(mockPublish).not.toHaveBeenCalled();});
  it("captures a lost acknowledgement and restores a creation fingerprint across a new timestamp without rebroadcast",async()=>{const{result}=setup();await waitFor(()=>expect(result.current.access).toBe("allowed"));const accepted=mockFixture.client.sendTransaction;mockFixture.client.sendTransaction=jest.fn(async(...args)=>{await accepted(...args);throw Error("Acknowledgement lost");});
    await act(async()=>{await expect(result.current.createProposal(draft())).rejects.toThrow(/Acknowledgement lost.*Pending transaction/);});expect(mockTransaction).not.toBeNull();const receiptKey=`ckboost:admin-tip-pending:testnet:${mockFixture.scope.protocolHash}:${mockFixture.scope.lockHash}`;expect(JSON.parse(localStorage.getItem(receiptKey)!).transactionHash).toBe(mockTransaction!.hash());
    await act(async()=>{await expect(result.current.createProposal(draft())).resolves.toBe(mockCurrent[0].id);});expect(mockPublish).toHaveBeenCalledTimes(1);expect(mockFixture.client.sendTransaction).toHaveBeenCalledTimes(1);expect(localStorage.getItem(receiptKey)).toBeNull();
  });
  it("rejects a forged asset object before funding or balance queries",async()=>{const{result}=setup();await waitFor(()=>expect(result.current.access).toBe("allowed"));const fake={...adminTipAssets(mockFixture.scope)[1],decimals:0};await expect(result.current.fund(fake,"10")).rejects.toThrow(/complete configured asset/);await expect(result.current.walletBalance(fake)).rejects.toThrow(/complete configured asset/);expect(mockPublish).not.toHaveBeenCalled();});
  it("does not expose new settings merely because a registry was deployed beside the old Tip VM",async()=>{jest.mocked(readAdminRegistry).mockResolvedValue({available:true,unavailableReason:null,cell:null,data:{schema:"ckboost-admin-registry/v1",protocolTypeHash:mockFixture.scope.protocolHash,revision:"1",tipping:{expirationSeconds:"123",approverLockHashes:[],thresholdsShannons:[]},attestations:[],periods:[]},transactionHash:h("d")});const{result}=setup();await waitFor(()=>expect(result.current.access).toBe("allowed"));expect(result.current.settingsAvailable).toBe(false);expect(result.current.settings?.expirationSeconds).toBe("86400");await expect(result.current.saveSettings({expirationDays:"3",approverLockHashes:[],thresholdsCkb:[]})).rejects.toThrow(/paired, reviewed/);expect(saveAdminTipSettings).not.toHaveBeenCalled();expect(readAdminTipHistory).not.toHaveBeenCalled();});
});
describe("Standalone Registry Approver detail",()=>{
  it.each([false,true])("checks a lost support acknowledgement after refresh changes the row and removes its Approve button (role revoked=%s)",async revoked=>{
    const f=reviewerFixture(),first=setup({tipId:f.id});await waitFor(()=>expect(first.result.current.canApprove).toBe(true));
    const accepted=mockFixture.client.sendTransaction;mockFixture.client.sendTransaction=jest.fn(async(...args)=>{await accepted(...args);throw Error("Acknowledgement lost");});
    await act(async()=>{await expect(first.result.current.approve(first.result.current.selected!)).rejects.toThrow(/Acknowledgement lost.*Pending transaction/);});
    const key=`ckboost:admin-tip-pending:testnet:${mockFixture.scope.protocolHash}:${mockFixture.scope.lockHash}`,saved=JSON.parse(localStorage.getItem(key)!);expect(saved.action).toContain(f.tipCell.outPoint.txHash);expect(mockCurrent[0].cell.outPoint.txHash).not.toBe(f.tipCell.outPoint.txHash);first.unmount();
    expect(mockTransaction!.inputs.map(input=>input.previousOutput.txHash)).toEqual([f.parent.hash(),f.nativeParent.hash()]);
    if(revoked)jest.mocked(readProtocolAdminRegistry).mockResolvedValue(revokedSnapshot(f));
    const second=setup({tipId:f.id});await waitFor(()=>expect(second.result.current.pendingReceipt?.transactionHash).toBe(saved.transactionHash));
    await waitFor(()=>expect(second.result.current.canApprove).toBe(false));if(revoked)await waitFor(()=>expect(second.result.current.access).toBe("denied"));
    await act(async()=>{await expect(second.result.current.checkPendingConfirmation()).resolves.toBe(f.id);});
    expect(localStorage.getItem(key)).toBeNull();expect(mockPublish).toHaveBeenCalledTimes(1);expect(mockFixture.client.sendTransaction).toHaveBeenCalledTimes(1);expect(second.result.current.operation?.phase).toBe("confirmed");
  });
  it("confirms a saved exact CKB deposit with canonical parent and actor proof after Admin management access is gone",async()=>{
    const f=reviewerFixture(),pool=ccc.Script.from({codeHash:h("4"),hashType:"type",args:mockFixture.scope.protocolHash});
    mockTransaction=ccc.Transaction.from({inputs:[{previousOutput:f.native.outPoint}],outputs:[{capacity:10000000000n,lock:pool},{capacity:89900000000n,lock:mockFixture.lock}],outputsData:["0x","0x"]});
    const key=`ckboost:admin-tip-pending:testnet:${mockFixture.scope.protocolHash}:${mockFixture.scope.lockHash}`;localStorage.setItem(key,JSON.stringify({schema:"ckboost-admin-tip-pending/v1",action:"fund:ckb:10000000000",transactionHash:mockTransaction.hash()}));
    const{result}=setup();await waitFor(()=>expect(result.current.access).toBe("denied"));await waitFor(()=>expect(result.current.pendingReceipt).not.toBeNull());
    await act(async()=>{await expect(result.current.checkPendingConfirmation()).resolves.toBe(mockTransaction!.hash());});
    expect(localStorage.getItem(key)).toBeNull();expect(result.current.canManage).toBe(false);expect(mockPublish).not.toHaveBeenCalled();expect(mockFixture.client.sendTransaction).not.toHaveBeenCalled();
  });
  it("keeps an unconfirmed saved transaction available without signing, resending or clearing its receipt",async()=>{
    const f=reviewerFixture(),hash=h("a"),key=`ckboost:admin-tip-pending:testnet:${mockFixture.scope.protocolHash}:${mockFixture.scope.lockHash}`;
    localStorage.setItem(key,JSON.stringify({schema:"ckboost-admin-tip-pending/v1",action:`support:${f.id}:${f.tipCell.outPoint.txHash}:0`,transactionHash:hash}));
    mockFixture.client.getTransaction=jest.fn().mockResolvedValue(undefined);
    const{result}=setup({tipId:f.id});await waitFor(()=>expect(result.current.pendingReceipt).not.toBeNull());
    await act(async()=>{await expect(result.current.checkPendingConfirmation()).rejects.toThrow(/pending or unavailable/);});
    expect(localStorage.getItem(key)).not.toBeNull();expect(mockPublish).not.toHaveBeenCalled();expect(mockFixture.client.sendTransaction).not.toHaveBeenCalled();
  });
  it("does not clear an imported receipt when the RPC returns another committed body",async()=>{
    const f=reviewerFixture(),hash=h("a"),key=`ckboost:admin-tip-pending:testnet:${mockFixture.scope.protocolHash}:${mockFixture.scope.lockHash}`;
    localStorage.setItem(key,JSON.stringify({schema:"ckboost-admin-tip-pending/v1",action:`support:${f.id}:${f.tipCell.outPoint.txHash}:0`,transactionHash:hash}));
    mockFixture.client.getTransaction=jest.fn().mockResolvedValue({transaction:f.parent,status:"committed",blockNumber:10n});
    const{result}=setup({tipId:f.id});await waitFor(()=>expect(result.current.pendingReceipt).not.toBeNull());
    await act(async()=>{await expect(result.current.checkPendingConfirmation()).rejects.toThrow(/body or committed block/);});expect(localStorage.getItem(key)).not.toBeNull();expect(mockPublish).not.toHaveBeenCalled();
  });
  it("retains the old wallet's receipt and hides late confirmation state after disconnect",async()=>{
    const f=reviewerFixture(),hash=h("a"),key=`ckboost:admin-tip-pending:testnet:${mockFixture.scope.protocolHash}:${mockFixture.scope.lockHash}`,late=deferred<Awaited<ReturnType<ccc.Client["getTransaction"]>>>();
    localStorage.setItem(key,JSON.stringify({schema:"ckboost-admin-tip-pending/v1",action:`support:${f.id}:${f.tipCell.outPoint.txHash}:0`,transactionHash:hash}));mockFixture.client.getTransaction=jest.fn().mockReturnValue(late.promise);
    const{result,rerender}=setup({tipId:f.id});await waitFor(()=>expect(result.current.pendingReceipt).not.toBeNull());let checking!:Promise<string>;
    act(()=>{checking=result.current.checkPendingConfirmation();});await waitFor(()=>expect(mockFixture.client.getTransaction).toHaveBeenCalledWith(hash));mockSigner=undefined;mockInfo=undefined;rerender({tipId:f.id});
    await act(async()=>{late.resolve(undefined);await expect(checking).rejects.toThrow(/wallet or protocol changed/);});expect(result.current.access).toBe("disconnected");expect(result.current.pendingReceipt).toBeNull();expect(result.current.operation).toBeNull();expect(localStorage.getItem(key)).not.toBeNull();expect(mockFixture.client.sendTransaction).not.toHaveBeenCalled();
  });
  it("allows a registered non-Admin to endorse only its scoped detail, with no Users read or management capability",async()=>{
    const f=reviewerFixture(),{result}=setup({tipId:f.id,historyRequested:true});
    await waitFor(()=>expect(result.current.selected?.id).toBe(f.id));
    expect(result.current).toMatchObject({access:"allowed",isAdmin:false,canManage:false,canApprove:true,settingsAvailable:false});
    expect(readAdminUsers).not.toHaveBeenCalled();expect(readAdminTips).not.toHaveBeenCalled();expect(readProtocolTipHistory).toHaveBeenCalled();expect(mockPublish).not.toHaveBeenCalled();
    await act(async()=>{await expect(result.current.approve(result.current.selected!)).resolves.toBe(f.id);});
    expect(mockPublish).toHaveBeenCalledTimes(1);expect(mockFixture.client.sendTransaction).toHaveBeenCalledTimes(1);expect(jest.requireMock("@/lib/services/tipping-service").TippingService.mock.calls[0][4]).toEqual({allowFeeRetry:false});
    expect(mockCurrent[0].data.supporter_lock_hashes).toEqual([mockFixture.targetLock.hash(),mockFixture.scope.lockHash]);
    await expect(result.current.createProposal(draft())).rejects.toThrow(/administrators/);
    await expect(result.current.fund(adminTipAssets(mockFixture.scope)[1],"100")).rejects.toThrow(/administrators/);
    await expect(result.current.saveSettings({expirationDays:"3",approverLockHashes:[],thresholdsCkb:[]})).rejects.toThrow(/administrators/);
    expect(saveAdminTipSettings).not.toHaveBeenCalled();
  });
  it("never gives an Approver access to the Admin list, creation or settings workspace",async()=>{
    reviewerFixture();const{result}=setup();await waitFor(()=>expect(result.current.access).toBe("denied"));
    expect(readProtocolAdminRegistry).not.toHaveBeenCalled();expect(readProtocolTip).not.toHaveBeenCalled();expect(readAdminTips).not.toHaveBeenCalled();expect(readAdminUsers).not.toHaveBeenCalled();
  });
  it.each([{registered:false,paired:true},{registered:true,paired:false}])("refuses an unregistered wallet or an unproven release: %p",async options=>{
    const f=reviewerFixture(options),{result}=setup({tipId:f.id});await waitFor(()=>expect(result.current.access).toBe("denied"));
    expect(result.current.canApprove).toBe(false);expect(readProtocolTip).not.toHaveBeenCalled();expect(mockPublish).not.toHaveBeenCalled();
  });
  it("keeps the first approval Admin-only even for a fully verified configured Approver",async()=>{
    const f=reviewerFixture({first:true}),{result}=setup({tipId:f.id});await waitFor(()=>expect(result.current.selected?.id).toBe(f.id));
    expect(result.current.canApprove).toBe(false);expect(result.current.supportUnavailableReason).toMatch(/first approval.*Admin/);
    await act(async()=>{await expect(result.current.approve(result.current.selected!)).rejects.toThrow(/first approval.*Admin/);});expect(mockPublish).not.toHaveBeenCalled();
  });
  it("rechecks revoked Registry membership before constructing or requesting a wallet transaction",async()=>{
    const f=reviewerFixture(),{result}=setup({tipId:f.id});await waitFor(()=>expect(result.current.canApprove).toBe(true));
    jest.mocked(readProtocolAdminRegistry).mockResolvedValue(revokedSnapshot(f));
    await act(async()=>{await expect(result.current.approve(result.current.selected!)).rejects.toThrow(/not a current verified tip approver/);});expect(mockPublish).not.toHaveBeenCalled();
  });
  it("rechecks role revocation at the actual client send boundary and never records a broadcast attempt",async()=>{
    const f=reviewerFixture(),{result}=setup({tipId:f.id});await waitFor(()=>expect(result.current.canApprove).toBe(true));
    mockPublish.mockImplementation(async(signer:ccc.Signer)=>{jest.mocked(readProtocolAdminRegistry).mockResolvedValue(revokedSnapshot(f));return signer.sendTransaction(ccc.Transaction.from({inputs:[{previousOutput:f.native.outPoint}],outputs:[{capacity:99900000000n,lock:mockFixture.lock}],outputsData:["0x"]}));});
    await act(async()=>{await expect(result.current.approve(result.current.selected!)).rejects.toThrow(/not a current verified tip approver/);});expect(mockFixture.client.sendTransaction).not.toHaveBeenCalled();expect(mockRegister).not.toHaveBeenCalled();expect(localStorage.length).toBe(0);
  });
  it("does not use a late old-wallet policy result to admit the next account",async()=>{
    const f=reviewerFixture(),old=deferred<Awaited<ReturnType<typeof readProtocolAdminRegistry>>>();jest.mocked(readProtocolAdminRegistry).mockReturnValueOnce(old.promise);
    const{result}=setup({tipId:f.id});await waitFor(()=>expect(readProtocolAdminRegistry).toHaveBeenCalled());
    jest.mocked(mockSigner!.getRecommendedAddressObj).mockResolvedValue(ccc.Address.fromScript({...mockFixture.lock,args:"0x99"},mockFixture.client));
    await act(async()=>old.resolve(f.snapshot));await waitFor(()=>expect(result.current.access).toBe("denied"));expect(result.current.rows).toBeNull();expect(mockPublish).not.toHaveBeenCalled();
  });
  it("does not let a detail Approver invoke support for a different full proposal ID",async()=>{
    const f=reviewerFixture(),{result}=setup({tipId:f.id});await waitFor(()=>expect(result.current.selected).not.toBeNull());
    await expect(result.current.approve({...result.current.selected!,id:h("e")})).rejects.toThrow(/exact proposal detail/);expect(mockPublish).not.toHaveBeenCalled();
  });
});
