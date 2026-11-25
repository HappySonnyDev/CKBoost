import {ccc} from "@ckb-ccc/core";
import {Tipping} from "../../../../packages/ssri-ckboost/src/tipping";
import {ConnectedTypeID,TippingData} from "ssri-ckboost/types";
jest.mock("../../../../packages/ssri-ckboost/src/logging/index",()=>({createScopedLogger:()=>({info:jest.fn(),log:jest.fn()})}));
const h=(n:number):ccc.Hex=>`0x${n.toString(16).padStart(64,"0")}`;
// The standalone SDK and dapp currently install different CCC versions. The
// serialized transaction boundary is compatible; keep test types scoped to
// the SDK signature rather than conflating the two protected Signer classes.
function fixture(){
  const lock=ccc.Script.from({codeHash:h(1),hashType:"type",args:"0x"}),protocol=ccc.Cell.from({outPoint:{txHash:h(2),index:0},cellOutput:{capacity:10000000000n,lock,type:lock},outputData:"0x"});
  const script=ccc.Script.from({codeHash:h(3),hashType:"type",args:ccc.hexFrom(ConnectedTypeID.encode({type_id:h(4),connected_key:lock.hash()}))});
  const runScript=jest.fn().mockRejectedValue(new Error("Read-only executor boundary"));
  const tipping=new Tipping({txHash:h(5),index:0},script,protocol as unknown as ConstructorParameters<typeof Tipping>[2],{executor:{runScript} as never});
  const data= TippingData.decode(TippingData.encode({target_lock_hash:h(6),proposer_lock_hash:h(7),supporter_lock_hashes:[],metadata:{contribution_title:"QA",contribution_type_tags:[],short_description:"Test",long_description:"",creation_timestamp:1n},rewards:{points_amount:1n,ckb_amount:0n,udt_assets:[],nft_assets:[]},status:"created",granted_at:0n}));
  return {tipping,runScript,data};
}
test("legacy Tip callers keep exactly their existing two SSRI arguments",async()=>{
  const f=fixture();await expect(f.tipping.updateTipping({} as Parameters<Tipping["updateTipping"]>[0],f.data,ccc.Transaction.from({}) as unknown as Parameters<Tipping["updateTipping"]>[2])).rejects.toThrow("Read-only executor boundary");
  expect(f.runScript.mock.calls[0][1]).toBe("CKBoostTipping.update_tipping");expect(f.runScript.mock.calls[0][2]).toHaveLength(2);
});
test("the reviewed V2 Tip path passes the signed millisecond declaration as a separate eight-byte argument",async()=>{
  const f=fixture(),at=1795560000000n;await expect(f.tipping.updateTipping({} as Parameters<Tipping["updateTipping"]>[0],f.data,ccc.Transaction.from({}) as unknown as Parameters<Tipping["updateTipping"]>[2],at)).rejects.toThrow("Read-only executor boundary");
  expect(f.runScript.mock.calls[0][2]).toHaveLength(3);expect(ccc.numLeFromBytes(f.runScript.mock.calls[0][2][2])).toBe(at);
});
test("invalid V2 declarations never reach the executor or a wallet",async()=>{
  for(const value of [0n,-1n,1n<<64n]){const f=fixture();await expect(f.tipping.updateTipping({} as Parameters<Tipping["updateTipping"]>[0],f.data,ccc.Transaction.from({}) as unknown as Parameters<Tipping["updateTipping"]>[2],value)).rejects.toThrow(/positive Uint64/);expect(f.runScript).not.toHaveBeenCalled();}
});
test("V2 updates retain an overfunded Tip cell instead of returning its capacity to the approver",async()=>{
  const f=fixture(),lock=ccc.Script.from({codeHash:h(8),hashType:"type",args:"0x"}),type=ccc.Script.from({codeHash:f.tipping.script.codeHash,hashType:f.tipping.script.hashType,args:f.tipping.script.args}),data=ccc.hexFrom(TippingData.encode(f.data));
  const previous=ccc.Cell.from({outPoint:{txHash:h(9),index:0},cellOutput:{capacity:100000000000n,lock,type},outputData:data});
  const returned=ccc.Transaction.from({inputs:[{previousOutput:previous.outPoint}],outputs:[ccc.CellOutput.from({lock,type},data)],outputsData:[data]});
  f.runScript.mockResolvedValue({map:(map:(bytes:ccc.Hex)=>unknown)=>({res:map(ccc.hexFrom(returned.toBytes()))})});
  const signer={client:{async *findCellsByType(){yield previous;}}} as unknown as Parameters<Tipping["updateTipping"]>[0];
  const result=await f.tipping.updateTipping(signer,f.data,undefined,1795560000000n);
  expect(result.res.outputs[0].capacity).toBe(previous.cellOutput.capacity);
});
