import {ccc} from "@ckb-ccc/connector-react";
import {ConnectedTypeID,TippingData} from "ssri-ckboost/types";
import {ADMIN_TIP_PUBLIC_TRANSACTION_LIMIT,confirmAdminTipReceipt,inspectInvalidAdminTipReceipt,makeAdminTipReceipt,parseAdminTipReceipt,type AdminTipPendingReceiptV1} from "../admin-tipping-confirmation";
import {makeProfileReadScope} from "../profile-model";
import qaProfile from "../../../config/qa/ckboost-testnet-admin-v4.json";
import actualPublicLog from "./fixtures/tip-create-016c-public.json";
import actualProof from "./fixtures/tip-create-016c-invalid-capacity-proof.json";
import {adminUsersFixture,userHash as h} from "./admin-users-fixtures";

// Preserve the actual connector's 1.12 classes. The unrelated top-level 1.19
// core intentionally repairs low capacities during serialization and would
// erase the invalid body this suite must prove, changing its transaction hash.
jest.mock("@ckb-ccc/connector-react",()=>({ccc:jest.requireActual("../../../../packages/ssri-ckboost/node_modules/@ckb-ccc/core")}));
jest.mock("@/lib/services/udt-registry",()=>({udtRegistry:{getTokenByScriptHash:()=>null}}));
const fingerprint=(tx:ccc.Transaction,index=0)=>{const data=TippingData.decode(tx.outputsData[index]);return ccc.hashCkb(TippingData.encode({...data,metadata:{...data.metadata,creation_timestamp:0n}}));};
const legacy=(tx:ccc.Transaction,action=`create:${fingerprint(tx)}`):AdminTipPendingReceiptV1=>({schema:"ckboost-admin-tip-pending/v1",action,transactionHash:tx.hash()});
function fixture(){
  const f=adminUsersFixture(),input=ccc.CellInput.from({previousOutput:{txHash:h("e"),index:0},since:0});
  const type=ccc.Script.from({codeHash:h("7"),hashType:"type",args:ccc.hexFrom(ConnectedTypeID.encode({type_id:ccc.hashTypeId(input,0),connected_key:f.scope.protocolHash}))});
  const lock=ccc.Script.from({codeHash:h("2"),hashType:"type",args:ccc.hexFrom(ConnectedTypeID.encode({type_id:f.scope.lockHash,connected_key:f.scope.protocolHash}))});
  const data={target_lock_hash:f.targetLock.hash(),proposer_lock_hash:f.lock.hash(),supporter_lock_hashes:[],metadata:{contribution_title:"Public capacity fixture",short_description:"",long_description:"",contribution_type_tags:[],creation_timestamp:1795800000000n},rewards:{points_amount:1n,ckb_amount:0n,udt_assets:[],nft_assets:[]},status:"created",granted_at:0n};
  let encoded=ccc.hexFrom(TippingData.encode(data));
  const oldMinimum=ccc.CellOutput.from({lock:f.lock,type},encoded).capacity,padding=(57600000000n-oldMinimum)/100000000n;
  if(padding<0n)throw Error("Fixture cannot reproduce the original 576 CKB output.");
  data.metadata.short_description="x".repeat(Number(padding));encoded=ccc.hexFrom(TippingData.encode(data));
  const provided=ccc.CellOutput.from({lock:f.lock,type},encoded).capacity;
  const tx=ccc.Transaction.from({inputs:[input],outputs:[{capacity:provided,lock,type},{capacity:100000000000n,lock:f.lock}],outputsData:[encoded,"0x"],witnesses:[`0x${"00".repeat(85)}`]});
  tx.outputs[0].capacity=provided;
  const noCache=jest.fn().mockResolvedValue(undefined);f.client.getTransactionNoCache=noCache;
  f.client.getTransaction=jest.fn(()=>{throw Error("Recovery must never use the cached transaction API.");});
  return {...f,input,type,tx,noCache,receipt:legacy(tx),needed:ccc.CellOutput.from({lock,type},encoded).capacity};
}
function rpc(tx:ccc.Transaction){
  const point=(p:ccc.OutPoint)=>({tx_hash:p.txHash,index:ccc.numToHex(p.index)}),script=(s:ccc.Script)=>({code_hash:s.codeHash,hash_type:s.hashType,args:s.args});
  return {version:ccc.numToHex(tx.version),cell_deps:tx.cellDeps.map(d=>({out_point:point(d.outPoint),dep_type:d.depType==="depGroup"?"dep_group":"code"})),header_deps:tx.headerDeps,inputs:tx.inputs.map(i=>({previous_output:point(i.previousOutput),since:ccc.numToHex(i.since)})),outputs:tx.outputs.map(o=>({capacity:ccc.numToHex(o.capacity),lock:script(o.lock),type:o.type?script(o.type):null})),outputs_data:tx.outputsData,witnesses:tx.witnesses};
}
describe("public Tip receipts and deterministic capacity recovery",()=>{
  it("keeps strict v1 compatibility and captures canonical v2 public bytes including witnesses",()=>{
    const f=fixture();expect(parseAdminTipReceipt(JSON.stringify(f.receipt))).toEqual(f.receipt);
    const next=makeAdminTipReceipt(f.receipt.action,f.tx);expect(next.schema).toBe("ckboost-admin-tip-pending/v2");expect(ccc.Transaction.fromBytes(next.transactionHex).witnesses).toEqual(f.tx.witnesses);expect(parseAdminTipReceipt(JSON.stringify(next))).toEqual(next);
    for(const changes of [{schema:"other"},{transactionHash:h("b")},{transactionHex:`${next.transactionHex}00`},{extra:true}])expect(()=>parseAdminTipReceipt(JSON.stringify({...next,...changes}))).toThrow();
    expect(()=>parseAdminTipReceipt(" ".repeat(ADMIN_TIP_PUBLIC_TRANSACTION_LIMIT+1))).toThrow(/oversized/);
    const oversized=f.tx.clone();oversized.witnesses=[`0x${"00".repeat(550_000)}`];expect(()=>makeAdminTipReceipt(f.receipt.action,oversized)).toThrow(/oversized|bounded/);
  });
  it("proves 576 < 630 from final script/data bytes, not from an error string or a hardcoded formula",async()=>{
    const f=fixture();expect(f.tx.outputs[0].capacity).toBe(57600000000n);expect(f.needed).toBe(63000000000n);
    const proof=await inspectInvalidAdminTipReceipt(f.scope,makeAdminTipReceipt(f.receipt.action,f.tx));
    expect(proof).toMatchObject({schema:"ckboost-admin-tip-invalid-capacity/v1",protocolTypeHash:f.scope.protocolHash,walletLockHash:f.scope.lockHash,transactionHash:f.tx.hash(),nodeStatus:"unknown",didSign:false,didBroadcast:false,didClear:false,deficits:[{outputIndex:0,providedCapacityShannons:"57600000000",requiredCapacityShannons:"63000000000",deficitShannons:"5400000000"}]});
    expect(f.noCache).toHaveBeenCalledTimes(1);expect(f.noCache).toHaveBeenCalledWith(f.tx.hash());expect(f.client.getTransaction).not.toHaveBeenCalled();
  });
  it("requires an actual public body for v1 and accepts canonical hex, CCC logs and explicit RPC shapes",async()=>{
    const f=fixture();await expect(inspectInvalidAdminTipReceipt(f.scope,f.receipt)).rejects.toThrow(/legacy receipt.*Import/);expect(f.noCache).not.toHaveBeenCalled();
    // CCC's console serialization may include cached input metadata. It is
    // explicitly parsed but never treated as canonical input/authority proof.
    f.tx.inputs[0].cellOutput=ccc.CellOutput.from({capacity:200000000000n,lock:f.lock});f.tx.inputs[0].outputData="0x";
    f.tx.addCellDeps({outPoint:{txHash:h("d"),index:0},depType:"depGroup"});const saved=legacy(f.tx),snake=rpc(f.tx);
    const bodies=[ccc.hexFrom(f.tx.toBytes()),JSON.stringify(ccc.hexFrom(f.tx.toBytes())),ccc.stringify(f.tx),JSON.stringify(snake),JSON.stringify({jsonrpc:"2.0",id:1,method:"send_transaction",params:[snake,"passthrough"]}),JSON.stringify({jsonrpc:"2.0",id:1,result:{transaction:snake,tx_status:{status:"unknown"}}})];
    for(const body of bodies)expect((await inspectInvalidAdminTipReceipt(f.scope,saved,body)).transactionHash).toBe(saved.transactionHash);
  });
  it("rejects wrong hashes, envelopes, missing fields, ambiguous fields, malformed or oversized data before RPC",async()=>{
    const f=fixture(),snake=rpc(f.tx),camel=JSON.parse(ccc.stringify(f.tx)),valid=ccc.hexFrom(f.tx.toBytes());
    const bodies=["PoolRejectedTransaction: capacity below minimum",JSON.stringify({transaction:snake,privateKey:"do not accept exports"}),JSON.stringify({jsonrpc:"2.0",id:1,method:"estimate_cycles",params:[snake]}),JSON.stringify({nested:{transaction:snake}}),JSON.stringify({...snake,outputs_data:[]}),JSON.stringify({...camel,cell_deps:[]}),JSON.stringify({...camel,inputs:[{...camel.inputs[0],unknown:true}]}),JSON.stringify({...snake,hash:h("b")}),`0x${"00".repeat(550_001)}`];
    for(const body of bodies)await expect(inspectInvalidAdminTipReceipt(f.scope,f.receipt,body)).rejects.toThrow();
    await expect(inspectInvalidAdminTipReceipt(f.scope,{...f.receipt,transactionHash:h("b")},valid)).rejects.toThrow(/saved raw transaction hash/);
    expect(f.noCache).not.toHaveBeenCalled();
  });
  it("binds the full protocol, wallet, owner, fresh input0 TypeID, action and immutable reward payload",async()=>{
    const f=fixture(),hex=(tx:ccc.Transaction)=>ccc.hexFrom(tx.toBytes());
    const otherWallet={...f.scope,walletLock:f.targetLock,lockHash:f.targetLock.hash(),address:f.targetAddress.toString()};
    await expect(inspectInvalidAdminTipReceipt(otherWallet,f.receipt,hex(f.tx))).rejects.toThrow(/wallet.*fingerprint/);
    for(const change of [
      (tx:ccc.Transaction)=>{tx.outputs[0].type=ccc.Script.from({...f.type,args:ccc.hexFrom(ConnectedTypeID.encode({type_id:ccc.hashTypeId(f.input,0),connected_key:h("b")}))});},
      (tx:ccc.Transaction)=>{tx.outputs[0].lock=ccc.Script.from({...tx.outputs[0].lock,codeHash:h("b")});},
      (tx:ccc.Transaction)=>{tx.outputs[0].lock=ccc.Script.from({...tx.outputs[0].lock,args:ccc.hexFrom(ConnectedTypeID.encode({type_id:f.scope.lockHash,connected_key:h("b")}))});},
      (tx:ccc.Transaction)=>{tx.inputs[0]=ccc.CellInput.from({previousOutput:{txHash:h("b"),index:0}});},
      (tx:ccc.Transaction)=>{const d=TippingData.decode(tx.outputsData[0]);d.rewards.points_amount=2n;tx.outputsData[0]=ccc.hexFrom(TippingData.encode(d));},
    ]){const tx=f.tx.clone();change(tx);await expect(inspectInvalidAdminTipReceipt(f.scope,legacy(tx,f.receipt.action),hex(tx))).rejects.toThrow();}
    await expect(inspectInvalidAdminTipReceipt(f.scope,{...f.receipt,action:`create:${h("b")}`},hex(f.tx))).rejects.toThrow(/fingerprint/);
    await expect(inspectInvalidAdminTipReceipt(f.scope,{...f.receipt,action:"fund:ckb:1"},hex(f.tx))).rejects.toThrow(/creation action/);
    expect(f.noCache).not.toHaveBeenCalled();
  });
  it.each(["sent","pending","proposed","committed"])("never releases a receipt with uncached node status %s",async status=>{
    const f=fixture();f.noCache.mockResolvedValue({status,transaction:f.tx});await expect(inspectInvalidAdminTipReceipt(f.scope,makeAdminTipReceipt(f.receipt.action,f.tx))).rejects.toThrow(/Keep the saved receipt/);
  });
  it("accepts rejected only with the same independently invalid body and rejects mismatched/inconsistent RPC evidence",async()=>{
    const f=fixture(),receipt=makeAdminTipReceipt(f.receipt.action,f.tx);f.noCache.mockResolvedValue({status:"rejected",transaction:f.tx,reason:"untrusted error text"});expect((await inspectInvalidAdminTipReceipt(f.scope,receipt)).nodeStatus).toBe("rejected");
    const other=f.tx.clone();other.outputs[1].capacity--;f.noCache.mockResolvedValue({status:"unknown",transaction:other});await expect(inspectInvalidAdminTipReceipt(f.scope,receipt)).rejects.toThrow(/different transaction body/);
    f.noCache.mockResolvedValue({status:"unknown",transaction:f.tx,blockNumber:10n});await expect(inspectInvalidAdminTipReceipt(f.scope,receipt)).rejects.toThrow(/Keep the saved receipt/);
    f.noCache.mockRejectedValue(Error("RPC unavailable"));await expect(inspectInvalidAdminTipReceipt(f.scope,receipt)).rejects.toThrow(/RPC unavailable/);
  });
  it("does not treat a valid body, error text, or fee rejection as an occupied-capacity proof",async()=>{
    const f=fixture();f.tx.outputs[0].capacity=f.needed;
    await expect(inspectInvalidAdminTipReceipt(f.scope,makeAdminTipReceipt(f.receipt.action,f.tx))).rejects.toThrow(/no occupied-capacity deficit/);expect(f.noCache).not.toHaveBeenCalled();
  });
  it("guards account/scope and cancellation before and after the only uncached read",async()=>{
    const f=fixture(),receipt=makeAdminTipReceipt(f.receipt.action,f.tx),cancel=new AbortController();cancel.abort();await expect(inspectInvalidAdminTipReceipt(f.scope,receipt,undefined,{signal:cancel.signal})).rejects.toThrow(/expired/);expect(f.noCache).not.toHaveBeenCalled();
    let current=true;f.noCache.mockImplementation(async()=>{current=false;return undefined;});await expect(inspectInvalidAdminTipReceipt(f.scope,receipt,undefined,{assertCurrent:()=>{if(!current)throw Error("Wallet changed");}})).rejects.toThrow(/Wallet changed/);
  });
  it("replays the actual public 016c log against the real released QA protocol and derives 576/630",async()=>{
    // Actual pre-wallet public console object, including cached parent data
    // and a wallet placeholder. No key or claim of signature validity exists.
    const tx=ccc.Transaction.from(actualPublicLog);actualPublicLog.outputs.forEach((output,index)=>{tx.outputs[index].capacity=ccc.numFrom(output.capacity);});
    const after=qaProfile.sources.adminUpgradeBundle.protocolUpdate.after,client={addressPrefix:"ckt",getTransactionNoCache:jest.fn().mockResolvedValue(undefined)} as unknown as ccc.Client;
    const protocolCell=ccc.Cell.from({outPoint:after.outPoint,cellOutput:{capacity:after.capacityShannons,lock:after.lockScript,type:after.typeScript},outputData:after.dataHex}),owner=tx.outputs[1].lock;
    const scope=makeProfileReadScope(client,protocolCell,ccc.Address.fromScript(owner,client),"testnet"),receipt=legacy(tx);
    expect(receipt.transactionHash).toBe("0x016c855dec9d49f1e250bf83ae9bfe0a169146bfa5f46fbaf590dbcef825f441");
    const proof=await inspectInvalidAdminTipReceipt(scope,receipt,JSON.stringify(actualPublicLog));expect(proof.deficits).toEqual([{outputIndex:0,providedCapacityShannons:"57600000000",requiredCapacityShannons:"63000000000",deficitShannons:"5400000000"}]);expect(proof.tipId).toBe("0x02a334a4be26436e936bd1f12d69e0eb7f17ace539ed30dac6ee17b6a54b2cf4");expect(client.getTransactionNoCache).toHaveBeenCalledTimes(1);
    // The checked-in integration fixture is itself fully replayed. Only the
    // read-time node status can differ between offline and the real audit.
    expect({...proof,nodeStatus:actualProof.nodeStatus}).toEqual(actualProof);
  });
  it("the existing committed confirmation path accepts v2 without clearing or broadcasting",async()=>{
    const f=adminUsersFixture(),pool=ccc.Script.from({codeHash:h("4"),hashType:"type",args:f.scope.protocolHash}),parent=ccc.Transaction.from({outputs:[{capacity:200000000000n,lock:f.lock}],outputsData:["0x"]}),tx=ccc.Transaction.from({inputs:[{previousOutput:{txHash:parent.hash(),index:0}}],outputs:[{capacity:100000000000n,lock:f.lock},{capacity:99900000000n,lock:pool}],outputsData:["0x","0x"]});
    f.client.getTransaction=jest.fn(async hash=>({status:"committed",transaction:hash===tx.hash()?tx:parent,blockNumber:10n}) as never);f.client.getHeaderByNumber=jest.fn().mockResolvedValue({number:10n,hash:h("a")});
    const receipt=makeAdminTipReceipt("fund:ckb:1",tx);await expect(confirmAdminTipReceipt(f.scope,receipt,{confirmationTarget:0})).resolves.toEqual({kind:"fund",result:tx.hash()});expect(parseAdminTipReceipt(JSON.stringify(receipt))).toEqual(receipt);
  });
});
