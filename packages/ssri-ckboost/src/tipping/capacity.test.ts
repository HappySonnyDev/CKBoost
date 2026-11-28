import {ccc} from "@ckb-ccc/core";
import {ConnectedTypeID,ProtocolData,TippingData,type ProtocolDataLike,type TippingDataLike} from "../generated";
import {Tipping} from "./index";

jest.mock("../logging/index.js",()=>({createScopedLogger:()=>({info:jest.fn()})}));

const CKB=100000000n;
const h=(digit:string)=>`0x${digit.repeat(64)}` as ccc.Hex;
const zero=h("0");
const protocolLockCode="0xe91b5a78463c293318331c21d372e031eb9ffad87b379fbe0563222fcdd28815";
const tipCode="0xbd7ab8605983bf0e85ad027649cede7033891a64dda60edc56e7548797094237";
const omniCode="0xf329effd1c475a2978453c8600e1eaf0bc2087ee093c3ee64cc96ec6847752cb";
const wallet=ccc.Script.from({codeHash:omniCode,hashType:"type",args:"0x1270de01d042a23bfab1dc06375138b48ea03d006900"});
const recipient=ccc.Script.from({codeHash:omniCode,hashType:"type",args:"0x121eed0a14e8cc8d5f81e2a82abc4e8f70bc772d4400"});
const approver=ccc.Script.from({codeHash:omniCode,hashType:"type",args:"0x12951f05826ebb466bcb231615a3d73de139ffbe0600"});
const at=1795878000000n;

function proposal():TippingDataLike{return {
  target_lock_hash:recipient.hash(),proposer_lock_hash:wallet.hash(),supporter_lock_hashes:[],
  metadata:{contribution_title:"QA tipping A1 first / A3 endorse",contribution_type_tags:[],
    short_description:"Independent QA test only. Account1 gives the first approval; registered approver Account3 gives the final endorsement. Pay 1000 tCKB to Account2.",
    long_description:"",creation_timestamp:at},
  rewards:{ckb_amount:1000n*CKB,points_amount:0n,nft_assets:[],udt_assets:[]},status:"created",granted_at:0n,
};}
function fixture(){
  const hashes=Object.fromEntries(["protocol_type","protocol_lock","campaign_type","funding_lock","user_type","points_udt_type","tipping_type","achievement_type"].map(name=>[`ckb_boost_${name}_code_hash`,zero]));
  const data={campaigns_approved:[],tippings_approved:[],tipping_config:{approval_requirement_thresholds:[],expiration_duration:0},endorsers_whitelist:[],last_updated:at,
    protocol_config:{admin_lock_hash_vec:[wallet.hash()],streak_bonus_interval:0,streak_bonus_amount:0,achievement_type_hashes:[],script_code_hashes:{...hashes,ckb_boost_protocol_lock_code_hash:protocolLockCode,ckb_boost_tipping_type_code_hash:tipCode,accepted_udt_type_scripts:[],accepted_dob_type_scripts:[]}}} as unknown as ProtocolDataLike;
  const protocol=ccc.Cell.from({outPoint:{txHash:h("1"),index:0},cellOutput:{capacity:841n*CKB,lock:wallet,type:{codeHash:"0x53769be2ed1d09a9da7c1d71488347449bb76f1212068f7e366939d0d5fd59fa",hashType:"type",args:"0x53a5053bed009ff6bcfe2762b5c186fdbbffa215cde85868c7becb501f0ef462"}},outputData:ccc.hexFrom(ProtocolData.encode(data))});
  const connection=(id:ccc.Hex)=>ccc.hexFrom(ConnectedTypeID.encode({type_id:id,connected_key:protocol.cellOutput.type!.hash()}));
  const type=ccc.Script.from({codeHash:tipCode,hashType:"type",args:connection(h("2"))});
  const ownerLock=ccc.Script.from({codeHash:protocolLockCode,hashType:"type",args:connection(wallet.hash())});
  const funding=ccc.Cell.from({outPoint:{txHash:h("3"),index:0},cellOutput:{capacity:2000n*CKB,lock:wallet},outputData:"0x"});
  return {protocol,connection,type,ownerLock,funding};
}

/** The executor response deliberately round-trips Molecule, including the
 * undersized capacity and missing resolved input metadata seen in production. */
async function update(options:{before?:TippingDataLike;after?:TippingDataLike;capacity?:bigint;ownerCapacity?:bigint;actor?:ccc.Script;extraOutputs?:ccc.CellOutputLike[];extraData?:ccc.Hex[];returnedArgs?:ccc.Hex;legacy?:boolean}={}){
  const f=fixture(),after=options.after??proposal(),isNew=!options.before;
  const encoded=ccc.hexFrom(TippingData.encode(after));
  const previous=isNew?undefined:ccc.Cell.from({outPoint:{txHash:h("4"),index:0},cellOutput:{capacity:options.ownerCapacity??ccc.CellOutput.from({lock:f.ownerLock,type:f.type},ccc.hexFrom(TippingData.encode(options.before!))).capacity,lock:f.ownerLock,type:f.type},outputData:ccc.hexFrom(TippingData.encode(options.before!))});
  const returnedType=ccc.Script.from({...f.type,args:options.returnedArgs??f.type.args});
  const draftLock=isNew?wallet:f.ownerLock;
  const draftCapacity=options.capacity??(isNew?ccc.CellOutput.from({lock:draftLock,type:returnedType},encoded).capacity:previous!.cellOutput.capacity);
  const returned=ccc.Transaction.from({inputs:[...(previous?[{previousOutput:previous.outPoint,since:123}]:[]),{previousOutput:f.funding.outPoint}],outputs:[{capacity:draftCapacity,lock:draftLock,type:returnedType},...(options.extraOutputs??[])],outputsData:[encoded,...(options.extraData??[])]});
  const runScript=jest.fn(async(_code:unknown,_method:string,_args:unknown[])=>({map:(map:(bytes:ccc.Hex)=>unknown)=>({res:map(ccc.hexFrom(returned.toBytes()))})}));
  const sendTransaction=jest.fn(()=>{throw new Error("No signing or broadcasting in a capacity test");});
  const signer={client:{async *findCellsByType(){if(previous)yield previous;},getCell:jest.fn(async(point:ccc.OutPoint)=>point.eq(f.funding.outPoint)?f.funding:previous),getKnownScript:jest.fn(async()=>({codeHash:h("e"),hashType:"type"}))},
    getRecommendedAddressObj:jest.fn(async()=>({script:options.actor??wallet})),prepareTransaction:jest.fn(async(tx:ccc.Transaction)=>tx),sendTransaction} as unknown as ccc.Signer;
  const script=ccc.Script.from({...f.type,args:isNew?f.connection(zero):f.type.args});
  const tipping=new Tipping({txHash:h("5"),index:0},script,f.protocol,{executor:{runScript} as never});
  const result=await tipping.updateTipping(signer,after,ccc.Transaction.from({inputs:[{previousOutput:f.funding.outPoint}]}),options.legacy?undefined:at+1n);
  return {...f,previous,returned,tx:result.res,signer,sendTransaction,runScript};
}

describe("Tip output capacity after final scripts and data",()=>{
  it("reproduces the real MetaMask 576 CKB draft and returns a valid 630 CKB protocol-owned output",async()=>{
    const f=await update(),data=f.tx.outputsData[0],out=f.tx.outputs[0];
    expect(ccc.bytesFrom(data)).toHaveLength(404);
    expect(f.returned.outputs[0].capacity).toBe(576n*CKB);
    expect(out.lock.eq(f.ownerLock)).toBe(true);
    expect(ccc.bytesFrom(out.lock.args)).toHaveLength(76);
    expect(ccc.bytesFrom(out.type!.args)).toHaveLength(76);
    expect(out.capacity).toBe(ccc.CellOutput.from({lock:out.lock,type:out.type},data).capacity);
    expect(out.capacity).toBe(630n*CKB);
    expect(data).toBe(f.returned.outputsData[0]);
    expect(f.sendTransaction).not.toHaveBeenCalled();
  });
  it.each(["0x",h("6")])("also prices the final full type args when SSRI returned %s",async returnedArgs=>{
    const f=await update({returnedArgs:returnedArgs as ccc.Hex});
    const out=f.tx.outputs[0];expect(out.capacity).toBe(ccc.CellOutput.from({lock:out.lock,type:out.type},f.tx.outputsData[0]).capacity);
    expect(out.type!.args).toHaveLength(154);expect(out.capacity).toBe(630n*CKB);
  });
  it("derives the floor from UTF-8 payload length and keeps an intentionally larger creation capacity",async()=>{
    const after=proposal();after.metadata.long_description="更长的实际内容🐰".repeat(75);
    const dynamic=await update({after}),out=dynamic.tx.outputs[0];
    expect(out.capacity).toBe(ccc.CellOutput.from({lock:out.lock,type:out.type},dynamic.tx.outputsData[0]).capacity);
    expect(out.capacity).toBeGreaterThan(630n*CKB);
    const overfunded=await update({capacity:1000n*CKB});expect(overfunded.tx.outputs[0].capacity).toBe(1000n*CKB);
  });
  it("grows the first approval for its supporter and longer status, preserving the original owner",async()=>{
    const before=proposal(),after=TippingData.decode(TippingData.encode(before));after.supporter_lock_hashes=[wallet.hash()];after.status="approved";
    const f=await update({before,after});expect(f.tx.outputs[0].capacity).toBe(663n*CKB);expect(f.tx.outputs[0].lock.eq(f.ownerLock)).toBe(true);
    expect(f.tx.outputs[0].capacity).toBe(ccc.CellOutput.from({lock:f.ownerLock,type:f.type},f.tx.outputsData[0]).capacity);
  });
  it("prices final endorsement while restoring input metadata and preserving every exact payout/pool output",async()=>{
    const before=TippingData.decode(TippingData.encode(proposal()));before.supporter_lock_hashes=[wallet.hash()];before.status="approved";
    const after=TippingData.decode(TippingData.encode(before));after.supporter_lock_hashes.push(approver.hash());after.status="granted";after.granted_at=at+1n;
    const pool=ccc.Script.from({codeHash:h("7"),hashType:"type",args:h("8")});
    const f=await update({before,after,actor:approver,extraOutputs:[{capacity:1000n*CKB,lock:recipient},{capacity:222n*CKB,lock:pool,type:{codeHash:h("9"),hashType:"type",args:h("a")}}],extraData:["0x",ccc.hexFrom(ccc.numLeToBytes(400n,16))]});
    expect(f.tx.outputs[0].capacity).toBe(694n*CKB);expect(f.tx.outputs[0].lock.eq(f.ownerLock)).toBe(true);
    expect(f.returned.inputs[0].cellOutput).toBeUndefined();
    expect(f.tx.inputs[0].cellOutput!.type!.eq(f.type)).toBe(true);
    expect(f.tx.inputs[0].outputData).toBe(f.previous!.outputData);
    expect(ccc.hexFrom(f.tx.inputs[0].toBytes())).toBe(ccc.hexFrom(f.returned.inputs[0].toBytes()));
    for(let index=1;index<f.tx.outputs.length;index++){
      expect(ccc.hexFrom(f.tx.outputs[index].toBytes())).toBe(ccc.hexFrom(f.returned.outputs[index].toBytes()));
      expect(f.tx.outputsData[index]).toBe(f.returned.outputsData[index]);
    }
  });
  it("keeps an overfunded existing state floor and also fixes legacy supporter growth",async()=>{
    const before=proposal(),after=TippingData.decode(TippingData.encode(before));after.supporter_lock_hashes=[wallet.hash()];after.status="approved";
    const preserved=await update({before,after,ownerCapacity:1000n*CKB});expect(preserved.tx.outputs[0].capacity).toBe(1000n*CKB);
    const legacy=await update({before,after,legacy:true});expect(legacy.tx.outputs[0].capacity).toBe(663n*CKB);
    expect(legacy.runScript.mock.calls[0][2]).toHaveLength(2);
    const legacyOverfunded=await update({before,after,legacy:true,ownerCapacity:1000n*CKB,capacity:630n*CKB});expect(legacyOverfunded.tx.outputs[0].capacity).toBe(1000n*CKB);
  });
  it("survives actual CCC unsigned fee completion with enough actor funds and its final state floor intact",async()=>{
    const f=await update();await f.tx.completeFeeBy(f.signer,1000n,undefined,{shouldAddInputs:false});
    expect(f.tx.outputs[0].capacity).toBe(630n*CKB);
    expect(f.tx.outputs[0].capacity).toBeGreaterThanOrEqual(ccc.CellOutput.from({lock:f.tx.outputs[0].lock,type:f.tx.outputs[0].type},f.tx.outputsData[0]).capacity);
    expect(await f.tx.getFee(f.signer.client)).toBeGreaterThan(0n);
    expect(f.tx.outputs[1].lock.eq(wallet)).toBe(true);expect(f.tx.outputs[1].capacity).toBeGreaterThan(0n);
    expect(f.sendTransaction).not.toHaveBeenCalled();
  });
  it("rejects insufficient actor funding without reducing the final state to its old undersized capacity",async()=>{
    const f=await update();f.funding.cellOutput.capacity=600n*CKB;
    await expect(f.tx.completeFeeBy(f.signer,1000n,undefined,{shouldAddInputs:false})).rejects.toThrow();
    expect(f.tx.outputs[0].capacity).toBe(630n*CKB);expect(f.sendTransaction).not.toHaveBeenCalled();
  });
});
