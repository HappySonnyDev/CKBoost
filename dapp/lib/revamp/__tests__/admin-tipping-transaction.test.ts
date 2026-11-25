import {ccc} from "@ckb-ccc/connector-react";
import {appendAdminTipUdtDistribution,selectAdminTipCkbFunding} from "../admin-tipping-transaction";
jest.mock("@ckb-ccc/connector-react",()=>({ccc:jest.requireActual("@ckb-ccc/core")}));
const hash=(n:number):ccc.Hex=>`0x${n.toString(16).padStart(64,"0")}`;
const pool=ccc.Script.from({codeHash:hash(1),hashType:"type",args:hash(2)}),target=ccc.Script.from({codeHash:hash(3),hashType:"type",args:"0x1234"}),type=ccc.Script.from({codeHash:hash(4),hashType:"type",args:hash(5)}),code={txHash:hash(6),index:0};
const cell=(balance:bigint,capacity=100000000000n,index=0)=>ccc.Cell.from({outPoint:{txHash:hash(7),index},cellOutput:{capacity,lock:pool,type},outputData:ccc.hexFrom(ccc.numLeToBytes(balance,16))});
test("a partial UDT grant preserves every shannon of the selected pool storage",()=>{
  const tx=ccc.Transaction.from({}),input=cell(500n);
  const result=appendAdminTipUdtDistribution(tx,{pool,target,type,amount:100n,cells:[input],code});
  expect(result.changeAmount).toBe(400n);expect(tx.inputs[0].previousOutput.eq(input.outPoint)).toBe(true);
  expect(tx.outputs[0].lock.eq(target)).toBe(true);expect(tx.outputs[0].type?.eq(type)).toBe(true);expect(ccc.numLeFromBytes(tx.outputsData[0])).toBe(100n);
  expect(tx.outputs[1].lock.eq(pool)).toBe(true);expect(ccc.numLeFromBytes(tx.outputsData[1])).toBe(400n);expect(tx.outputs[1].capacity).toBe(input.cellOutput.capacity);
});
test("an exact UDT grant returns all treasury storage as untyped protocol capacity",()=>{
  const tx=ccc.Transaction.from({}),input=cell(100n);appendAdminTipUdtDistribution(tx,{pool,target,type,amount:100n,cells:[input],code});
  expect(tx.outputs[1].lock.eq(pool)).toBe(true);expect(tx.outputs[1].type).toBeUndefined();expect(tx.outputsData[1]).toBe("0x");expect(tx.outputs[1].capacity).toBe(input.cellOutput.capacity);
});
test("foreign locks, reused cells, shortfalls and malformed amounts never partially allocate",()=>{
  for(const cells of [[cell(99n)],[ccc.Cell.from({...cell(100n),cellOutput:{...cell(100n).cellOutput,lock:target}})],[ccc.Cell.from({...cell(100n),outputData:"0x01"})]]){
    const tx=ccc.Transaction.from({});expect(()=>appendAdminTipUdtDistribution(tx,{pool,target,type,amount:100n,cells,code})).toThrow();expect(tx.inputs).toHaveLength(0);expect(tx.outputs).toHaveLength(0);
  }
  const original=cell(100n),tx=ccc.Transaction.from({inputs:[{previousOutput:original.outPoint}]});expect(()=>appendAdminTipUdtDistribution(tx,{pool,target,type,amount:100n,cells:[original],code})).toThrow(/reused/);
});
test("multiple cells preserve the exact asset and total treasury capacity without using wallet assets",()=>{
  const tx=ccc.Transaction.from({}),first=cell(60n,90000000000n),second=cell(70n,80000000000n,1);
  appendAdminTipUdtDistribution(tx,{pool,target,type,amount:100n,cells:[first,second],code});
  expect(tx.inputs).toHaveLength(2);expect(ccc.numLeFromBytes(tx.outputsData[1])).toBe(30n);expect(tx.outputs[1].capacity).toBe(170000000000n);
  expect(tx.cellDeps.some(dep=>dep.outPoint.eq(code))).toBe(true);
});
test("native payout selection continues past dust and reports a genuine storage reserve shortfall",()=>{
  const native=(amount:bigint,index:number)=>ccc.Cell.from({outPoint:{txHash:hash(8),index},cellOutput:{capacity:amount*100000000n,lock:pool},outputData:"0x"});
  const first=native(150n,0),second=native(500n,1),required=10000000000n;
  expect(selectAdminTipCkbFunding([first,second],pool,required).cells).toHaveLength(2);
  expect(()=>selectAdminTipCkbFunding([first],pool,required)).toThrow(/Funding Lock remainder/);
  expect(selectAdminTipCkbFunding([native(100n,2)],pool,required).total).toBe(required);
});
