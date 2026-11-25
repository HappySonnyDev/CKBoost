import type {ccc as CccTypes} from "@ckb-ccc/connector-react";
let mockRuntime:unknown={network:"testnet",protocol:{typeHash:"0x4eacaf9b1a120d2bfd99f26fcedfdcfe6ef116484e9b478b0a104a872316e034"}};
jest.mock("@ckb-ccc/connector-react",()=>({ccc:jest.requireActual("@ckb-ccc/core")}));
jest.mock("@/lib/ckb/isolated-runtime.mjs",()=>({getIsolatedRuntime:()=>mockRuntime}));

function fixture(){
  const model=jest.requireActual<typeof import("../testnet-admin-upgrade")>("../testnet-admin-upgrade"),{ccc}=require("@ckb-ccc/connector-react") as typeof import("@ckb-ccc/connector-react");
  const source=model.validateAdminRegistryUpgradePlan().source,code=model.adminUpgradeTransaction("code"),state=model.adminUpgradeTransaction("state");
  const owner=ccc.Script.from(source.owner.lock as CccTypes.ScriptLike);
  const protocol=ccc.Cell.from({outPoint:source.protocol.outPoint,cellOutput:{capacity:source.protocol.capacityShannons,lock:source.protocol.lockScript as CccTypes.ScriptLike,type:source.protocol.typeScript as CccTypes.ScriptLike},outputData:source.protocol.outputData});
  const codeInput=ccc.Cell.from({outPoint:code.inputs[0].previousOutput,cellOutput:{capacity:source.code.inputCapacityShannons,lock:owner},outputData:"0x"});
  const codeLive=ccc.Cell.from({outPoint:{txHash:code.hash(),index:0},cellOutput:code.outputs[0],outputData:code.outputsData[0]}),change=ccc.Cell.from({outPoint:{txHash:code.hash(),index:1},cellOutput:code.outputs[1],outputData:"0x"});
  const stateLive=ccc.Cell.from({outPoint:{txHash:state.hash(),index:0},cellOutput:state.outputs[0],outputData:state.outputsData[0]});
  let codeCommitted=false,stateCommitted=false;
  const client={url:"https://testnet.ckbapp.dev/",addressPrefix:"ckt",getTransaction:jest.fn(async(hash:CccTypes.BytesLike)=>{const hex=ccc.hexFrom(hash);return hex===code.hash()&&codeCommitted?{transaction:code,status:"committed",blockNumber:100n}:hex===state.hash()&&stateCommitted?{transaction:state,status:"committed",blockNumber:101n}:undefined;}),getCellLive:jest.fn(async(point:CccTypes.OutPointLike)=>{const p=ccc.OutPoint.from(point);if(p.eq(protocol.outPoint))return protocol;if(p.eq(codeInput.outPoint))return codeCommitted?undefined:codeInput;if(p.eq(codeLive.outPoint))return codeCommitted?codeLive:undefined;if(p.eq(change.outPoint))return codeCommitted&&!stateCommitted?change:undefined;if(p.eq(stateLive.outPoint))return stateCommitted?stateLive:undefined;return undefined;}),estimateCycles:jest.fn(async()=>100000n),sendTransaction:jest.fn(async(tx:CccTypes.Transaction)=>tx.hash())} as unknown as CccTypes.Client;
  const signer={client,getRecommendedAddressObj:jest.fn(async()=>ccc.Address.fromScript(owner,client)),prepareTransaction:jest.fn(async(tx:CccTypes.Transaction)=>tx),signTransaction:jest.fn(async(tx:CccTypes.Transaction)=>{const signed=tx.clone();signed.witnesses[0]=ccc.hexFrom(ccc.WitnessArgs.from({lock:new Uint8Array(85).fill(1)}).toBytes());return signed;})} as unknown as CccTypes.Signer;
  const values=new Map<string,string>(),storage={getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);}};
  return {model,ccc,source,code,state,owner,client,signer,protocol,codeInput,codeLive,stateLive,change,storage,values,setCodeCommitted:(v=true)=>{codeCommitted=v;},setStateCommitted:(v=true)=>{stateCommitted=v;}};
}
beforeEach(()=>{jest.resetModules();mockRuntime={network:"testnet",protocol:{typeHash:"0x4eacaf9b1a120d2bfd99f26fcedfdcfe6ef116484e9b478b0a104a872316e034"}};});

test("fixed public plan validates exact raw bodies, ELF, owners, capacity and linked custom TypeID",()=>{
 const f=fixture(),plan=f.model.validateAdminRegistryUpgradePlan();expect(plan.registryType.hash()).toBe(f.model.ADMIN_UPGRADE_REGISTRY);expect(plan.code.outputs[0].capacity).toBe(4672800000000n);expect(plan.state.outputs[0].capacity).toBe(38600000000n);expect(plan.registry.tipping.approverLockHashes).toEqual(["0x5538b22a20cabb3e33634a339d1ecbeb9557a00b73a6d81fba9eab957a8f711c"]);
 const tampered=JSON.parse(JSON.stringify(f.source));const tx=f.code.clone();tx.outputs[1].capacity--;tampered.code.unsignedTransaction=f.ccc.hexFrom(tx.toBytes());tampered.code.transactionHash=tx.hash();expect(()=>f.model.validateAdminRegistryUpgradePlan(tampered)).toThrow(/raw transaction body/);
});
test("ordinary environment, foreign protocol, mainnet and another wallet fail closed",async()=>{
 const f=fixture();mockRuntime=null;await expect(f.model.reviewAdminRegistryUpgrade(f.signer,"code")).rejects.toThrow(/isolated QA/);
 mockRuntime={network:"testnet",protocol:{typeHash:`0x${"11".repeat(32)}`}};await expect(f.model.reviewAdminRegistryUpgrade(f.signer,"code")).rejects.toThrow(/isolated QA/);
 mockRuntime={network:"testnet",protocol:{typeHash:f.model.ADMIN_UPGRADE_PROTOCOL}};(f.client as unknown as {url:string}).url="https://mainnet.ckbapp.dev/";await expect(f.model.reviewAdminRegistryUpgrade(f.signer,"code")).rejects.toThrow(/fixed public/);
 (f.client as unknown as {url:string}).url="https://testnet.ckbapp.dev/";jest.mocked(f.signer.getRecommendedAddressObj).mockResolvedValue(f.ccc.Address.fromScript({...f.owner,args:"0x01"},f.client));await expect(f.model.reviewAdminRegistryUpgrade(f.signer,"code")).rejects.toThrow(/Account 1/);expect(f.signer.signTransaction).not.toHaveBeenCalled();
});
test("read review verifies fixed plain funding and current Protocol without any wallet signature or send",async()=>{
 const f=fixture(),review=await f.model.reviewAdminRegistryUpgrade(f.signer,"code");expect(review.transactionHash).toBe(f.code.hash());expect(review.feeShannons).toBe("47210");expect(f.signer.signTransaction).not.toHaveBeenCalled();expect(f.client.sendTransaction).not.toHaveBeenCalled();expect(f.client.estimateCycles).not.toHaveBeenCalled();
 jest.mocked(f.client.getCellLive).mockResolvedValueOnce(f.ccc.Cell.from({...f.protocol,outputData:"0x00"}));await expect(f.model.reviewAdminRegistryUpgrade(f.signer,"code")).rejects.toThrow(/authorization changed/);
});
test("typed, nonempty, wrong capacity or spent fixed funding inputs never get replaced",async()=>{
 const f=fixture(),original=jest.mocked(f.client.getCellLive).getMockImplementation()!;
 for(const cell of [undefined,f.ccc.Cell.from({...f.codeInput,outputData:"0x00"}),f.ccc.Cell.from({...f.codeInput,cellOutput:{...f.codeInput.cellOutput,type:f.code.outputs[0].type}}),f.ccc.Cell.from({...f.codeInput,cellOutput:{...f.codeInput.cellOutput,capacity:f.codeInput.cellOutput.capacity-1n}})]){
   jest.mocked(f.client.getCellLive).mockImplementation(async p=>f.ccc.OutPoint.from(p).eq(f.codeInput.outPoint)?cell:original(p));await expect(f.model.reviewAdminRegistryUpgrade(f.signer,"code")).rejects.toThrow(/fixed|capacity/);
 }expect(f.signer.signTransaction).not.toHaveBeenCalled();
});
test("state cannot sign before exact committed and currently live pinned code",async()=>{
 const f=fixture();await expect(f.model.signAdminRegistryUpgrade(f.signer,"state",()=>true,f.storage)).rejects.toThrow(/not committed/);expect(f.signer.signTransaction).not.toHaveBeenCalled();
 f.setCodeCommitted();const original=jest.mocked(f.client.getCellLive).getMockImplementation()!;jest.mocked(f.client.getCellLive).mockImplementation(async p=>f.ccc.OutPoint.from(p).eq(f.codeLive.outPoint)?f.ccc.Cell.from({...f.codeLive,outputData:"0x00"}):original(p));await expect(f.model.reviewAdminRegistryUpgrade(f.signer,"state")).rejects.toThrow(/differs/);
});
test("sign saves actual signed bytes only; signature and prepare body changes stop before a send",async()=>{
 const f=fixture(),receipt=await f.model.signAdminRegistryUpgrade(f.signer,"code",()=>true,f.storage);expect(receipt.phase).toBe("signed");expect(f.model.readAdminUpgradeReceipt("code",f.storage)?.transactionHash).toBe(f.code.hash());expect(f.client.sendTransaction).not.toHaveBeenCalled();expect(f.client.estimateCycles).not.toHaveBeenCalled();await expect(f.model.signAdminRegistryUpgrade(f.signer,"code",()=>true,f.storage)).rejects.toThrow(/already saved/);expect(f.signer.signTransaction).toHaveBeenCalledTimes(1);
});
test.each(["prepare","signature"])("wallet %s changing a raw output forces recompute/recompile and never broadcasts",async phase=>{
 const f=fixture(),mutate=async(tx:CccTypes.TransactionLike)=>{const changed=f.ccc.Transaction.from(tx).clone();changed.outputs[1].capacity--;return changed;};
 if(phase==="prepare")jest.mocked(f.signer.prepareTransaction).mockImplementation(mutate);else jest.mocked(f.signer.signTransaction).mockImplementation(mutate);
 await expect(f.model.signAdminRegistryUpgrade(f.signer,"code",()=>true,f.storage)).rejects.toThrow(/changed/);expect(f.client.sendTransaction).not.toHaveBeenCalled();expect(f.model.readAdminUpgradeReceipt("code",f.storage)).toBeNull();
});
test("explicit broadcast persists attempted hash before send; lost acknowledgement never sends again",async()=>{
 const f=fixture();await f.model.signAdminRegistryUpgrade(f.signer,"code",()=>true,f.storage);jest.mocked(f.client.sendTransaction).mockImplementation(async tx=>{expect(f.model.readAdminUpgradeReceipt("code",f.storage)?.phase).toBe("broadcast-attempted");expect(f.ccc.Transaction.from(tx).hash()).toBe(f.code.hash());throw new Error("Lost acknowledgement");});
 await expect(f.model.broadcastAdminRegistryUpgrade(f.signer,"code",()=>true,f.storage)).rejects.toThrow(/Lost acknowledgement/);expect(f.client.sendTransaction).toHaveBeenCalledTimes(1);await expect(f.model.broadcastAdminRegistryUpgrade(f.signer,"code",()=>true,f.storage)).rejects.toThrow(/Check the attempted/);expect(f.client.sendTransaction).toHaveBeenCalledTimes(1);
 f.setCodeCommitted();expect((await f.model.confirmAdminRegistryUpgrade(f.client,"code")).status).toBe("confirmed");expect(f.signer.signTransaction).toHaveBeenCalledTimes(1);
});
test("failed estimate, stale operation and storage failure cannot broadcast",async()=>{
 const f=fixture();await f.model.signAdminRegistryUpgrade(f.signer,"code",()=>true,f.storage);jest.mocked(f.client.estimateCycles).mockResolvedValue(0n);await expect(f.model.broadcastAdminRegistryUpgrade(f.signer,"code",()=>true,f.storage)).rejects.toThrow(/script verification/);expect(f.client.sendTransaction).not.toHaveBeenCalled();
 await expect(f.model.broadcastAdminRegistryUpgrade(f.signer,"code",()=>false,f.storage)).rejects.toThrow(/operation changed/);
 jest.mocked(f.client.estimateCycles).mockResolvedValue(100n);const broken={getItem:f.storage.getItem,setItem:()=>{throw new Error("Storage blocked");}};await expect(f.model.broadcastAdminRegistryUpgrade(f.signer,"code",()=>true,broken)).rejects.toThrow(/Storage blocked/);expect(f.client.sendTransaction).not.toHaveBeenCalled();
});
test("same signer changing Account during estimate fails fresh ownership and never sends",async()=>{
 const f=fixture();await f.model.signAdminRegistryUpgrade(f.signer,"code",()=>true,f.storage);jest.mocked(f.client.estimateCycles).mockImplementation(async()=>{jest.mocked(f.signer.getRecommendedAddressObj).mockResolvedValue(f.ccc.Address.fromScript({...f.owner,args:"0x01"},f.client));return 100n;});await expect(f.model.broadcastAdminRegistryUpgrade(f.signer,"code",()=>true,f.storage)).rejects.toThrow(/Account 1/);expect(f.client.sendTransaction).not.toHaveBeenCalled();
});
test("wallet switch while the signature popup is open still retains its actual signed receipt without a send",async()=>{
 const f=fixture(),sign=jest.mocked(f.signer.signTransaction).getMockImplementation()!;
 jest.mocked(f.signer.signTransaction).mockImplementation(async tx=>{const signed=await sign(tx);jest.mocked(f.signer.getRecommendedAddressObj).mockResolvedValue(f.ccc.Address.fromScript({...f.owner,args:"0x01"},f.client));return signed;});
 await expect(f.model.signAdminRegistryUpgrade(f.signer,"code",()=>true,f.storage)).rejects.toThrow(/Account 1/);expect(f.model.readAdminUpgradeReceipt("code",f.storage)?.phase).toBe("signed");expect(f.client.sendTransaction).not.toHaveBeenCalled();await expect(f.model.signAdminRegistryUpgrade(f.signer,"code",()=>true,f.storage)).rejects.toThrow(/already saved/);expect(f.signer.signTransaction).toHaveBeenCalledTimes(1);
});
test("state confirmation binds both actual committed bodies and exact live outputs, only exports manifest",async()=>{
 const f=fixture();f.setCodeCommitted();f.setStateCommitted();const result=await f.model.confirmAdminRegistryUpgrade(f.client,"state");expect(result.status).toBe("confirmed");if(result.status!=="confirmed")throw Error("Expected actual confirmation");expect(result.manifest).toMatchObject({schema:"ckboost-admin-registry-deployment/v1",network:"testnet",protocolTypeHash:f.model.ADMIN_UPGRADE_PROTOCOL,codeDataHash:f.model.ADMIN_UPGRADE_RELEASE.dataHash});expect(f.ccc.Script.from(result.manifest!.typeScript as import("@ckb-ccc/connector-react").ccc.ScriptLike).hash()).toBe(f.model.ADMIN_UPGRADE_REGISTRY);expect(f.client.sendTransaction).not.toHaveBeenCalled();
 const unrelated=f.state.clone();unrelated.outputs[0].capacity++;jest.mocked(f.client.getTransaction).mockResolvedValue({status:"committed",blockNumber:101n,transaction:unrelated} as import("@ckb-ccc/connector-react").ccc.ClientTransactionResponse);await expect(f.model.confirmAdminRegistryUpgrade(f.client,"state")).rejects.toThrow(/actual committed raw transaction/);
});
