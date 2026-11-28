import {ccc} from "@ckb-ccc/connector-react";
import {ConnectedTypeID,ProtocolData} from "ssri-ckboost/types";
import {resolveProtocolTipRecipient,TipRecipientUserNotFoundError} from "../admin-tip-recipient";
import {adminUsersFixture,userHash as h} from "./admin-users-fixtures";

jest.mock("@ckb-ccc/connector-react",()=>({ccc:jest.requireActual("@ckb-ccc/core")}));
jest.mock("@/lib/services/udt-registry",()=>({udtRegistry:{getTokenByScriptHash:()=>null}}));

function fixture(){
  const f=adminUsersFixture(),seed=f.userCell(),parent=ccc.Transaction.from({inputs:[{previousOutput:{txHash:h("e"),index:0}}],outputs:[seed.cellOutput],outputsData:[seed.outputData]});
  const cell=ccc.Cell.from({outPoint:{txHash:parent.hash(),index:0},cellOutput:parent.outputs[0],outputData:parent.outputsData[0]});
  const pages=jest.fn().mockResolvedValue({cells:[cell],lastCursor:"done"}),transaction=jest.fn().mockResolvedValue({status:"committed",transaction:parent,blockNumber:123n}),live=jest.fn().mockResolvedValue(cell);
  Object.assign(f.client,{findCellsPaged:pages,getTransactionNoCache:transaction,getCellLiveNoCache:live,getTransaction:jest.fn(()=>{throw Error("Cached parents are forbidden");}),getCellLive:jest.fn(()=>{throw Error("Cached liveness is forbidden");}),sendTransaction:jest.fn(()=>{throw Error("No payment may be sent");})});
  // The actor is deliberately neither platform Admin nor Organizer. Reading a
  // recipient preimage must not elevate or impersonate that actor.
  const protocol={...f.scope.protocol,protocol_config:{...f.scope.protocol.protocol_config,admin_lock_hash_vec:[]},endorsers_whitelist:[]};
  const protocolCell=ccc.Cell.from({...f.protocolCell,outputData:ccc.hexFrom(ProtocolData.encode(protocol))}),scope={...f.scope,protocol,protocolCell};
  return {...f,scope,parent,cell,pages,transaction,live,target:f.targetLock.hash()};
}
describe("public exact-protocol Tip recipient verification",()=>{
  it("resolves A2 for a non-Admin A3 using only bounded User enumeration and uncached canonical/live proofs",async()=>{
    const f=fixture(),result=await resolveProtocolTipRecipient(f.scope,f.target);
    expect(result.eq(f.targetLock)).toBe(true);expect(result.hash()).toBe(f.target);expect(result).not.toBe(f.cell.cellOutput.lock);
    expect(f.pages).toHaveBeenCalledWith(expect.objectContaining({script:{codeHash:h("5"),hashType:"type",args:"0x"},scriptType:"type",scriptSearchMode:"prefix",withData:true}),"asc",100,undefined);
    expect(f.transaction).toHaveBeenCalledWith(f.parent.hash());expect(f.live).toHaveBeenCalledWith(f.cell.outPoint,true,true);expect(f.client.getTransaction).not.toHaveBeenCalled();expect(f.client.getCellLive).not.toHaveBeenCalled();expect(f.client.sendTransaction).not.toHaveBeenCalled();
  });
  it("does not resolve malformed/zero targets or an incoherent protocol/wallet/network scope",async()=>{
    const f=fixture();for(const hash of ["0x12",h("0")])await expect(resolveProtocolTipRecipient(f.scope,hash)).rejects.toThrow(/complete nonzero/);
    for(const scope of [{...f.scope,protocolHash:h("b")},{...f.scope,lockHash:h("b")},{...f.scope,network:"mainnet" as const}])await expect(resolveProtocolTipRecipient(scope,f.target)).rejects.toThrow(/scope/);
    expect(f.pages).not.toHaveBeenCalled();
  });
  it("ignores foreign protocols, wrong code/hash type, noncanonical args and a different wallet",async()=>{
    const f=fixture(),foreign=(type:ccc.ScriptLike,lock=f.targetLock)=>ccc.Cell.from({...f.cell,cellOutput:{...f.cell.cellOutput,lock,type}});
    const cells=[foreign({...f.cell.cellOutput.type!,args:ccc.hexFrom(ConnectedTypeID.encode({type_id:h("b"),connected_key:h("e")}))}),foreign({...f.cell.cellOutput.type!,codeHash:h("e")}),foreign({...f.cell.cellOutput.type!,hashType:"data"}),foreign({...f.cell.cellOutput.type!,args:"0x0102"}),foreign(f.cell.cellOutput.type!,f.lock)];
    f.pages.mockResolvedValue({cells:cells.map((cell,index)=>ccc.Cell.from({...cell,outPoint:{txHash:h("c"),index}})),lastCursor:"done"});await expect(resolveProtocolTipRecipient(f.scope,f.target)).rejects.toThrow(/No current User Cell/);expect(f.transaction).not.toHaveBeenCalled();expect(f.live).not.toHaveBeenCalled();
  });
  it("rejects conflicts only for the target, while unrelated User duplicates do not authorize or block it",async()=>{
    const f=fixture(),other=ccc.Cell.from({...f.cell,outPoint:{txHash:h("d"),index:0}});
    f.pages.mockResolvedValue({cells:[f.cell,other],lastCursor:"done"});await expect(resolveProtocolTipRecipient(f.scope,f.target)).rejects.toThrow(/Multiple current User Cells/);expect(f.transaction).not.toHaveBeenCalled();
    const unrelated=f.userCell(h("d"),f.lock);f.pages.mockResolvedValue({cells:[unrelated,ccc.Cell.from({...unrelated,outPoint:{txHash:h("e"),index:0}}),f.cell],lastCursor:"done"});await expect(resolveProtocolTipRecipient(f.scope,f.target)).resolves.toEqual(f.targetLock);
  });
  it("requires terminal pagination, without accepting an earlier target from a partial or repeated page",async()=>{
    const f=fixture();f.pages.mockResolvedValue({cells:Array.from({length:100},()=>f.cell),lastCursor:"same"});await expect(resolveProtocolTipRecipient(f.scope,f.target)).rejects.toThrow(/repeated/);expect(f.transaction).not.toHaveBeenCalled();
  });
  it("distinguishes an absent registered recipient from conflicts and failed proofs",async()=>{
    const f=fixture();f.pages.mockResolvedValue({cells:[],lastCursor:"done"});
    await expect(resolveProtocolTipRecipient(f.scope,f.target)).rejects.toBeInstanceOf(TipRecipientUserNotFoundError);
    f.pages.mockResolvedValue({cells:[f.cell,ccc.Cell.from({...f.cell,outPoint:{txHash:h("d"),index:0}})],lastCursor:"done"});
    await expect(resolveProtocolTipRecipient(f.scope,f.target)).rejects.not.toBeInstanceOf(TipRecipientUserNotFoundError);
    f.pages.mockResolvedValue({cells:[f.cell],lastCursor:"done"});f.transaction.mockRejectedValue(Error("RPC offline"));
    await expect(resolveProtocolTipRecipient(f.scope,f.target)).rejects.not.toBeInstanceOf(TipRecipientUserNotFoundError);
  });
  it.each(["missing","pending","wrong-hash","missing-block","outside-output","changed-output","changed-data"])("rejects %s parent proof before any live lookup",async mode=>{
    const f=fixture();let response:unknown={status:"committed",transaction:f.parent,blockNumber:123n};
    if(mode==="missing")response=undefined;
    if(mode==="pending")response={...response as object,status:"pending"};
    if(mode==="missing-block")response={status:"committed",transaction:f.parent};
    if(mode==="wrong-hash"){const tx=f.parent.clone();tx.outputs[0].capacity++;response={status:"committed",transaction:tx,blockNumber:123n};}
    if(mode==="outside-output")f.pages.mockResolvedValue({cells:[ccc.Cell.from({...f.cell,outPoint:{txHash:f.parent.hash(),index:9}})],lastCursor:"done"});
    if(mode==="changed-output")f.pages.mockResolvedValue({cells:[ccc.Cell.from({...f.cell,cellOutput:{...f.cell.cellOutput,capacity:f.cell.cellOutput.capacity+1n}})],lastCursor:"done"});
    if(mode==="changed-data"){const data={...f.data,total_points_earned:8};const {UserData}=require("ssri-ckboost/types");f.pages.mockResolvedValue({cells:[ccc.Cell.from({...f.cell,outputData:ccc.hexFrom(UserData.encode(data))})],lastCursor:"done"});}
    f.transaction.mockResolvedValue(response);await expect(resolveProtocolTipRecipient(f.scope,f.target)).rejects.toThrow(/parent/);expect(f.live).not.toHaveBeenCalled();
  });
  it.each(["missing","wrong-point","wrong-lock","wrong-type","wrong-capacity","wrong-data"])("rejects %s current live proof instead of returning an unverified destination",async mode=>{
    const f=fixture();let cell:ccc.Cell|undefined=f.cell;
    if(mode==="missing")cell=undefined;
    if(mode==="wrong-point")cell=ccc.Cell.from({...f.cell,outPoint:{txHash:h("d"),index:0}});
    if(mode==="wrong-lock")cell=ccc.Cell.from({...f.cell,cellOutput:{...f.cell.cellOutput,lock:f.lock}});
    if(mode==="wrong-type")cell=ccc.Cell.from({...f.cell,cellOutput:{...f.cell.cellOutput,type:{...f.cell.cellOutput.type!,args:"0x"}}});
    if(mode==="wrong-capacity")cell=ccc.Cell.from({...f.cell,cellOutput:{...f.cell.cellOutput,capacity:f.cell.cellOutput.capacity+1n}});
    if(mode==="wrong-data")cell=ccc.Cell.from({...f.cell,outputData:"0x"});
    f.live.mockResolvedValue(cell);await expect(resolveProtocolTipRecipient(f.scope,f.target)).rejects.toThrow(/no longer live|lock\/data changed/);
  });
  it("never substitutes cached evidence when an uncached proof API or network response is unavailable",async()=>{
    const f=fixture();f.transaction.mockRejectedValue(Error("RPC offline"));await expect(resolveProtocolTipRecipient(f.scope,f.target)).rejects.toThrow(/RPC offline/);expect(f.live).not.toHaveBeenCalled();
    Object.defineProperty(f.client,"getTransactionNoCache",{value:undefined});await expect(resolveProtocolTipRecipient(f.scope,f.target)).rejects.toThrow(/uncached.*No cached or explorer fallback/);expect(f.client.getTransaction).not.toHaveBeenCalled();
  });
  it("cancels before enumeration and rejects a late liveness result after cancellation",async()=>{
    const f=fixture(),cancel=new AbortController();cancel.abort();await expect(resolveProtocolTipRecipient(f.scope,f.target,cancel.signal)).rejects.toThrow(/cancel/i);expect(f.pages).not.toHaveBeenCalled();
    const active=new AbortController();f.live.mockImplementation(async()=>{active.abort();return f.cell;});await expect(resolveProtocolTipRecipient(f.scope,f.target,active.signal)).rejects.toThrow(/cancel/i);expect(f.client.sendTransaction).not.toHaveBeenCalled();
  });
});
