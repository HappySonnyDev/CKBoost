import type {ccc as Ccc} from "@ckb-ccc/connector-react";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {gunzipSync} from "node:zlib";
let mockRuntime:unknown={network:"testnet",protocol:{typeHash:"0x4eacaf9b1a120d2bfd99f26fcedfdcfe6ef116484e9b478b0a104a872316e034"}};
const mockInventory=jest.fn();
jest.mock("@ckb-ccc/connector-react",()=>({ccc:jest.requireActual("@ckb-ccc/core").ccc}));
jest.mock("@/lib/ckb/isolated-runtime.mjs",()=>({getIsolatedRuntime:()=>mockRuntime}));
jest.mock("../testnet-admin-financial-inventory",()=>({readFinancialNamespaceInventory:(...args:unknown[])=>mockInventory(...args)}));
// Private tiny candidate pins make the transaction-policy tests fast. The
// historical 9504 parent is the complete actual public raw transaction and is
// always hashed/decoded, never replaced by an unrelated mocked hash response.
jest.mock("../../../../contracts/admin-tipping/release-pins.mjs",()=>{
 const {ccc}=require("@ckb-ccc/connector-react"),elf=(n:number)=>{const b=new Uint8Array(25);b.set([0x7f,0x45,0x4c,0x46,2,1]);b[16]=2;b[18]=243;b[20]=1;b[24]=n;return b;};
 return {ADMIN_TIPPING_RELEASE:{releaseId:"synthetic-finance-operator",protocolTypeHash:"0x4eacaf9b1a120d2bfd99f26fcedfdcfe6ef116484e9b478b0a104a872316e034",registryTypeHash:"0x97e23b14d33e0445c1eac09f1948e2c3652547bfbb7fb7db56978f48baff9690",byteLengths:{tippingType:25,fundingLock:25,protocolLock:25},dataHashes:{tippingType:ccc.hashCkb(elf(1)),fundingLock:ccc.hashCkb(elf(2)),protocolLock:ccc.hashCkb(elf(3))}}};
});
function fixture(){
 const {ccc}=require("@ckb-ccc/connector-react") as typeof import("@ckb-ccc/connector-react"),model=require("../testnet-admin-financial-operator") as typeof import("../testnet-admin-financial-operator"),source=require("@/config/qa/admin-registry-upgrade-plan.json") as typeof import("@/config/qa/admin-registry-upgrade-plan.json");
 const owner=ccc.Script.from(source.owner.lock as Ccc.ScriptLike),historical=ccc.Transaction.fromBytes(gunzipSync(Buffer.from(readFileSync(join(__dirname,"fixtures/qa-permissions-9504.bin.gz.b64"),"utf8").trim(),"base64"))),protocolParent=ccc.Transaction.fromBytes(source.protocol.transactionHex),code=ccc.Transaction.fromBytes(source.code.unsignedTransaction),state=ccc.Transaction.fromBytes(source.state.unsignedTransaction);
 expect(historical.hash()).toBe("0x950471450fa173fb530a05026bd6a9e8e5bf327ae7f709a49e21a8616a8d92e6");
 const nativeParent=ccc.Transaction.from({outputs:[{capacity:ccc.fixedPointFrom(500000),lock:owner}],outputsData:["0x"]}),parents=new Map<string,Ccc.ClientTransactionResponse>(),lives=new Map<string,Ccc.Cell>();
 const key=(p:Ccc.OutPointLike)=>{const v=ccc.OutPoint.from(p);return `${v.txHash}:${v.index}`;};
 const seed=(tx:Ccc.Transaction,block:bigint,liveIndices:number[]=[])=>{parents.set(tx.hash(),{transaction:tx,status:"committed",blockNumber:block} as Ccc.ClientTransactionResponse);for(const i of liveIndices)lives.set(`${tx.hash()}:${i}`,ccc.Cell.from({outPoint:{txHash:tx.hash(),index:i},cellOutput:tx.outputs[i],outputData:tx.outputsData[i]}));};
 seed(historical,1n,[0]);seed(protocolParent,2n,[0]);seed(code,100n,[0]);seed(state,101n,[0]);seed(nativeParent,50n,[0]);
 const knownClient=new ccc.ClientPublicTestnet({url:"https://testnet.ckbapp.dev/",fallbacks:[]});
 const client={url:"https://testnet.ckbapp.dev/",addressPrefix:"ckt",getKnownScript:jest.fn(name=>knownClient.getKnownScript(name)),getTransaction:jest.fn(async h=>parents.get(ccc.hexFrom(h))),getCellLive:jest.fn(async p=>lives.get(key(p))),findCellsPaged:jest.fn(async search=>({cells:[...lives.values()].filter(c=>search.scriptType==="type"?c.cellOutput.type?.eq(search.script):c.cellOutput.lock.eq(search.script)),lastCursor:"done"})),estimateCycles:jest.fn(async()=>100000n),sendTransaction:jest.fn(async t=>ccc.Transaction.from(t).hash())} as unknown as Ccc.Client;
 const signer={client,getRecommendedAddressObj:jest.fn(async()=>ccc.Address.fromScript(owner,client)),prepareTransaction:jest.fn(async t=>ccc.Transaction.from(t)),signTransaction:jest.fn(async t=>{const tx=ccc.Transaction.from(t).clone(),i=tx.inputs[0].previousOutput.eq(source.protocol.outPoint)?1:0,existing=tx.witnesses[i]!=="0x"?ccc.WitnessArgs.fromBytes(tx.witnesses[i]):ccc.WitnessArgs.from({});tx.witnesses[i]=ccc.hexFrom(ccc.WitnessArgs.from({...existing,lock:new Uint8Array(85).fill(1)}).toBytes());return tx;})} as unknown as Ccc.Signer;
 const values=new Map<string,string>(),storage={getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);},removeItem:(k:string)=>{values.delete(k);}};
 const elf=(n:number)=>{const b=new Uint8Array(25);b.set([0x7f,0x45,0x4c,0x46,2,1]);b[16]=2;b[18]=243;b[20]=1;b[24]=n;return ccc.hexFrom(b);},binaries={tippingType:elf(1),fundingLock:elf(2),protocolLock:elf(3)};
 const commit=(receipt:import("../testnet-admin-financial-operator").FinancialSignedReceipt,block:bigint)=>{const tx=ccc.Transaction.fromBytes(receipt.signedTransaction);for(const input of tx.inputs)lives.delete(key(input.previousOutput));seed(tx,block,tx.outputs.map((_,i)=>i));return tx;};
 return {ccc,model,source,owner,client,signer,parents,lives,storage,values,binaries,key,historical,protocolParent,code,state,nativeParent,commit};
}
beforeEach(()=>{jest.resetModules();jest.clearAllMocks();mockRuntime={network:"testnet",protocol:{typeHash:"0x4eacaf9b1a120d2bfd99f26fcedfdcfe6ef116484e9b478b0a104a872316e034"}};mockInventory.mockResolvedValue({complete:true,oldTips:0,protocolFunding:0,campaignFunding:0,campaignTypeHashes:[]});});
test("codes prepare reads real canonical/current inputs and never signs, estimates or sends",async()=>{
 const f=fixture(),p=await f.model.prepareFinancialCodeStage(f.signer,f.binaries);expect(p.stage).toBe("codes");const tx=f.ccc.Transaction.fromBytes(p.unsignedTransaction);expect(tx.inputs[0].previousOutput.txHash).toBe(f.historical.hash());expect(tx.inputs[0].previousOutput.index).toBe(0n);expect(tx.inputs[1].previousOutput.txHash).toBe(f.nativeParent.hash());expect(f.signer.signTransaction).not.toHaveBeenCalled();expect(f.client.sendTransaction).not.toHaveBeenCalled();expect(f.client.estimateCycles).not.toHaveBeenCalled();expect(mockInventory).toHaveBeenCalled();
});
test("Registry prerequisites, explicit QA scope, current actor and nonempty old pools block preparation",async()=>{
 const f=fixture();mockRuntime=null;await expect(f.model.prepareFinancialCodeStage(f.signer,f.binaries)).rejects.toThrow(/isolated QA/);mockRuntime={network:"testnet",protocol:{typeHash:f.source.protocol.typeHash}};
 f.parents.delete(f.state.hash());await expect(f.model.prepareFinancialCodeStage(f.signer,f.binaries)).rejects.toThrow(/not committed/);f.parents.set(f.state.hash(),{transaction:f.state,status:"committed",blockNumber:101n} as Ccc.ClientTransactionResponse);
 mockInventory.mockResolvedValueOnce({complete:true,oldTips:0,protocolFunding:0,campaignFunding:1,campaignTypeHashes:[]});await expect(f.model.prepareFinancialCodeStage(f.signer,f.binaries)).rejects.toThrow(/migration/);expect(f.signer.signTransaction).not.toHaveBeenCalled();
});
test("an unrelated transaction cannot satisfy a prerequisite canonical hash, and projected funds are never accepted",async()=>{
 const f=fixture();f.parents.set(f.historical.hash(),{transaction:f.nativeParent,status:"committed",blockNumber:1n} as Ccc.ClientTransactionResponse);await expect(f.model.prepareFinancialCodeStage(f.signer,f.binaries)).rejects.toThrow(/canonical.*hash/);expect(f.signer.signTransaction).not.toHaveBeenCalled();
});
test("storage capacity is checked before opening a wallet signature request",async()=>{
 const f=fixture(),p=await f.model.prepareFinancialCodeStage(f.signer,f.binaries),blocked={...f.storage,setItem:()=>{throw Error("Quota exceeded");}};await expect(f.model.signFinancialStage(f.signer,p,()=>true,blocked)).rejects.toThrow(/Quota/);expect(f.signer.signTransaction).not.toHaveBeenCalled();expect(f.client.sendTransaction).not.toHaveBeenCalled();
});
test.each(["prepare","signature"])("wallet %s body mutation stops and no actual send occurs",async phase=>{
 const f=fixture(),p=await f.model.prepareFinancialCodeStage(f.signer,f.binaries),mutate=async(t:Ccc.TransactionLike)=>{const tx=f.ccc.Transaction.from(t).clone();tx.outputs[3].capacity--;return tx;};if(phase==="prepare")jest.mocked(f.signer.prepareTransaction).mockImplementation(mutate);else jest.mocked(f.signer.signTransaction).mockImplementation(mutate);await expect(f.model.signFinancialStage(f.signer,p,()=>true,f.storage)).rejects.toThrow(/changed/);expect(f.client.sendTransaction).not.toHaveBeenCalled();expect(f.model.readFinancialReceipt("codes",f.storage)).toBeNull();
});
test("explicit signing only persists bytes; broadcast attempt is durable before a lost acknowledgement and can never resend",async()=>{
 const f=fixture(),p=await f.model.prepareFinancialCodeStage(f.signer,f.binaries),r=await f.model.signFinancialStage(f.signer,p,()=>true,f.storage);expect(r.phase).toBe("signed");expect(f.client.estimateCycles).not.toHaveBeenCalled();expect(f.client.sendTransaction).not.toHaveBeenCalled();
 jest.mocked(f.client.sendTransaction).mockImplementation(async tx=>{expect(f.model.readFinancialReceipt("codes",f.storage)?.phase).toBe("broadcast-attempted");expect(f.ccc.Transaction.from(tx).hash()).toBe(r.transactionHash);throw Error("Acknowledgement lost");});await expect(f.model.broadcastFinancialStage(f.signer,"codes",()=>true,f.storage)).rejects.toThrow(/Acknowledgement/);await expect(f.model.broadcastFinancialStage(f.signer,"codes",()=>true,f.storage)).rejects.toThrow(/never resend/);expect(f.client.sendTransaction).toHaveBeenCalledTimes(1);await expect(f.model.signFinancialStage(f.signer,p,()=>true,f.storage)).rejects.toThrow(/already saved/);expect(f.signer.signTransaction).toHaveBeenCalledTimes(1);
 f.commit(r,200n);expect(await f.model.confirmFinancialStage(f.client,"codes",r.transactionHash)).toMatchObject({status:"confirmed",transactionHash:r.transactionHash,codeTransactionHash:r.transactionHash});
});
test("post-sign storage failure retains actual bytes for export and stops a send",async()=>{
 const f=fixture(),p=await f.model.prepareFinancialCodeStage(f.signer,f.binaries),broken={...f.storage,setItem:(k:string,v:string)=>{if(k.endsWith(":capacity-probe"))f.storage.setItem(k,v);else throw Error("Storage blocked after popup");}};await expect(f.model.signFinancialStage(f.signer,p,()=>true,broken)).rejects.toThrow(/Storage blocked/);expect(f.model.readFinancialReceipt("codes",f.storage)?.signedTransaction).toBeTruthy();await expect(f.model.broadcastFinancialStage(f.signer,"codes",()=>true,broken)).rejects.toThrow(/Storage blocked/);expect(f.client.sendTransaction).not.toHaveBeenCalled();
});
test("same Signer changing Account during estimate leaves signed-only state and never sends",async()=>{
 const f=fixture(),p=await f.model.prepareFinancialCodeStage(f.signer,f.binaries);await f.model.signFinancialStage(f.signer,p,()=>true,f.storage);jest.mocked(f.client.estimateCycles).mockImplementation(async()=>{jest.mocked(f.signer.getRecommendedAddressObj).mockResolvedValue(f.ccc.Address.fromScript({...f.owner,args:"0x01"},f.client));return 100n;});await expect(f.model.broadcastFinancialStage(f.signer,"codes",()=>true,f.storage)).rejects.toThrow(/Account 1/);expect(f.client.sendTransaction).not.toHaveBeenCalled();expect(f.model.readFinancialReceipt("codes",f.storage)?.phase).toBe("signed");
});

/** Exercise the real CCC send wrapper, rather than mocking away its fee await.
 * Only its final RPC and cache effects are spies; no network is performed. */
function realCccSend(f:ReturnType<typeof fixture>,transactionHash:Ccc.Hex){
 const noCache=jest.fn(async()=>transactionHash),markTransactions=jest.fn(async()=>{});
 Object.defineProperties(f.client,{sendTransactionNoCache:{value:noCache,writable:true,configurable:true},cache:{value:{markTransactions},configurable:true}});
 jest.mocked(f.client.sendTransaction).mockImplementation(function(this:Ccc.Client,...args:Parameters<Ccc.Client["sendTransaction"]>){return f.ccc.Client.prototype.sendTransaction.apply(this,args);});
 return {noCache,markTransactions};
}
test.each(["account","scope","client"] as const)("real CCC fee await followed by a %s change never reaches its RPC send boundary",async change=>{
 const f=fixture(),prepared=await f.model.prepareFinancialCodeStage(f.signer,f.binaries),receipt=await f.model.signFinancialStage(f.signer,prepared,()=>true,f.storage);
 const {noCache,markTransactions}=realCccSend(f,receipt.transactionHash);let valid=true;
 const feeRead=jest.spyOn(f.ccc.Transaction.prototype,"getFeeRate").mockImplementation(async()=>{
   await Promise.resolve();
   if(change==="account")jest.mocked(f.signer.getRecommendedAddressObj).mockResolvedValue(f.ccc.Address.fromScript({...f.owner,args:"0x01"},f.client));
   if(change==="scope")valid=false;
   if(change==="client")Object.defineProperty(f.signer,"client",{value:{...f.client},configurable:true});
   return 1000n;
 });
 try{
   await expect(f.model.broadcastFinancialStage(f.signer,"codes",()=>valid,f.storage)).rejects.toThrow(/Account 1|operation changed|wallet client changed/);
   expect(feeRead).toHaveBeenCalledTimes(1);expect(f.client.sendTransaction).toHaveBeenCalledTimes(1);expect(noCache).not.toHaveBeenCalled();expect(markTransactions).not.toHaveBeenCalled();
   // Conservatively retain the durable attempt marker. A failed post-entry
   // check must never clear a saved signature or enable an automatic resend.
   expect(f.model.readFinancialReceipt("codes",f.storage)?.phase).toBe("broadcast-attempted");
 }finally{feeRead.mockRestore();}
});
test("real CCC still validates its fee and updates its cache once after the guarded exact signed submission",async()=>{
 const f=fixture(),prepared=await f.model.prepareFinancialCodeStage(f.signer,f.binaries),receipt=await f.model.signFinancialStage(f.signer,prepared,()=>true,f.storage);
 const {noCache,markTransactions}=realCccSend(f,receipt.transactionHash),feeRead=jest.spyOn(f.ccc.Transaction.prototype,"getFeeRate").mockResolvedValue(1000n);
 noCache.mockImplementation(async()=>{expect(f.model.readFinancialReceipt("codes",f.storage)?.phase).toBe("broadcast-attempted");return receipt.transactionHash;});
 try{
   await expect(f.model.broadcastFinancialStage(f.signer,"codes",()=>true,f.storage)).resolves.toMatchObject({transactionHash:receipt.transactionHash,phase:"broadcast-attempted"});
   expect(feeRead).toHaveBeenCalledTimes(1);expect(noCache).toHaveBeenCalledTimes(1);expect(markTransactions).toHaveBeenCalledTimes(1);
   const actual=(noCache.mock.calls as unknown as [[Ccc.Transaction]])[0][0];expect(f.ccc.hexFrom(actual.toBytes())).toBe(receipt.signedTransaction);
 }finally{feeRead.mockRestore();}
});
test("the guarded client retains CCC's excessive-fee rejection before any RPC or cache mutation",async()=>{
 const f=fixture(),prepared=await f.model.prepareFinancialCodeStage(f.signer,f.binaries),receipt=await f.model.signFinancialStage(f.signer,prepared,()=>true,f.storage);
 const {noCache,markTransactions}=realCccSend(f,receipt.transactionHash),feeRead=jest.spyOn(f.ccc.Transaction.prototype,"getFeeRate").mockResolvedValue(1n<<100n);
 try{await expect(f.model.broadcastFinancialStage(f.signer,"codes",()=>true,f.storage)).rejects.toThrow();expect(feeRead).toHaveBeenCalledTimes(1);expect(noCache).not.toHaveBeenCalled();expect(markTransactions).not.toHaveBeenCalled();}
 finally{feeRead.mockRestore();}
});
test("a witness mutation during CCC fee reads is rejected even when the raw transaction hash stays unchanged",async()=>{
 const f=fixture(),prepared=await f.model.prepareFinancialCodeStage(f.signer,f.binaries),receipt=await f.model.signFinancialStage(f.signer,prepared,()=>true,f.storage);
 const {noCache}=realCccSend(f,receipt.transactionHash),feeRead=jest.spyOn(f.ccc.Transaction.prototype,"getFeeRate").mockImplementation(async function(this:Ccc.Transaction){
   const body=this.hash();this.witnesses[0]=f.ccc.hexFrom(f.ccc.WitnessArgs.from({lock:new Uint8Array(85).fill(2)}).toBytes());expect(this.hash()).toBe(body);return 1000n;
 });
 try{await expect(f.model.broadcastFinancialStage(f.signer,"codes",()=>true,f.storage)).rejects.toThrow(/actual signed transaction changed/);expect(noCache).not.toHaveBeenCalled();}
 finally{feeRead.mockRestore();}
});
test("wallet replacement during a signature retains the actual signed bytes and prevents another signature",async()=>{
 const f=fixture(),p=await f.model.prepareFinancialCodeStage(f.signer,f.binaries),sign=jest.mocked(f.signer.signTransaction).getMockImplementation()!;
 jest.mocked(f.signer.signTransaction).mockImplementation(async tx=>{const signed=await sign(tx);jest.mocked(f.signer.getRecommendedAddressObj).mockResolvedValue(f.ccc.Address.fromScript({...f.owner,args:"0x01"},f.client));return signed;});await expect(f.model.signFinancialStage(f.signer,p,()=>true,f.storage)).rejects.toThrow(/Account 1/);expect(f.model.readFinancialReceipt("codes",f.storage)?.phase).toBe("signed");await expect(f.model.signFinancialStage(f.signer,p,()=>true,f.storage)).rejects.toThrow(/already saved/);expect(f.signer.signTransaction).toHaveBeenCalledTimes(1);expect(f.client.sendTransaction).not.toHaveBeenCalled();
});
test("protocol stage requires a committed batch and preserves the exact protocol recipe/data delta",async()=>{
 const f=fixture(),p=await f.model.prepareFinancialCodeStage(f.signer,f.binaries),r=await f.model.signFinancialStage(f.signer,p,()=>true,f.storage);await expect(f.model.prepareFinancialProtocolStage(f.signer,r.transactionHash)).rejects.toThrow(/not committed/);f.commit(r,200n);
 const startSeconds=BigInt(Math.floor(Date.now()/1000)),prepared=await f.model.prepareFinancialProtocolStage(f.signer,r.transactionHash),tx=f.ccc.Transaction.fromBytes(prepared.unsignedTransaction),{ProtocolData,TransactionRecipe}=jest.requireActual("ssri-ckboost/types"),before=ProtocolData.decode(f.source.protocol.outputData),after=ProtocolData.decode(tx.outputsData[0]);expect(after.last_updated).toBeGreaterThanOrEqual(startSeconds);expect(after.last_updated).toBeLessThanOrEqual(BigInt(Math.floor(Date.now()/1000)));expect(after.last_updated).toBeLessThan(100000000000n);expect(tx.inputs[0].previousOutput.txHash).toBe(f.protocolParent.hash());expect(tx.outputs[0].type?.hash()).toBe(f.source.protocol.typeHash);expect(after.campaigns_approved).toEqual(before.campaigns_approved);expect(after.protocol_config.admin_lock_hash_vec).toEqual(before.protocol_config.admin_lock_hash_vec);const witness=f.ccc.WitnessArgs.fromBytes(tx.witnesses[0]),recipe=TransactionRecipe.decode(witness.outputType!);expect(f.ccc.bytesTo(recipe.method_path,"utf8")).toBe("CKBoostProtocol.update_protocol");expect(f.ccc.hexFrom(recipe.arguments[0].data)).toBe("0x00000000");
 const signed=await f.model.signFinancialStage(f.signer,prepared,()=>true,f.storage);expect(f.client.sendTransaction).not.toHaveBeenCalled();f.commit(signed,201n);expect(await f.model.confirmFinancialStage(f.client,"protocol",signed.transactionHash)).toMatchObject({status:"confirmed",codeTransactionHash:r.transactionHash});expect(mockInventory).toHaveBeenLastCalledWith(f.client,expect.anything(),expect.any(Function),{historicalProtocol:true});
});
test("tampered protocol roles are rejected even with recomputed hash; stale inputs and failed estimates never send",async()=>{
 const f=fixture(),p=await f.model.prepareFinancialCodeStage(f.signer,f.binaries),r=await f.model.signFinancialStage(f.signer,p,()=>true,f.storage);f.commit(r,200n);const q=await f.model.prepareFinancialProtocolStage(f.signer,r.transactionHash),tx=f.ccc.Transaction.fromBytes(q.unsignedTransaction),{ProtocolData}=jest.requireActual("ssri-ckboost/types"),d=ProtocolData.decode(tx.outputsData[0]);d.protocol_config.admin_lock_hash_vec=[];tx.outputsData[0]=f.ccc.hexFrom(ProtocolData.encode(d));await expect(f.model.signFinancialStage(f.signer,{...q,transactionHash:tx.hash(),unsignedTransaction:f.ccc.hexFrom(tx.toBytes())},()=>true,f.storage)).rejects.toThrow(/Only the two/);expect(f.client.sendTransaction).not.toHaveBeenCalled();
});
