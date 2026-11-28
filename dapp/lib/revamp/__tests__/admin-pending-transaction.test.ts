import {ccc} from "@ckb-ccc/connector-react";
import {observeAdminTransactionAttempt} from "../admin-pending-transaction";
jest.mock("@ckb-ccc/connector-react",()=>({ccc:jest.requireActual("../../../../packages/ssri-ckboost/node_modules/@ckb-ccc/core")}));

test("records and forwards exact serialized bytes across CCC versions without normalizing an insufficient output",async()=>{
  const script={codeHash:`0x${"11".repeat(32)}` as ccc.Hex,hashType:"type" as const,args:`0x${"00".repeat(76)}` as ccc.Hex};
  const tx=ccc.Transaction.from({outputs:[{lock:script,type:script}],outputsData:[`0x${"00".repeat(404)}`]});
  tx.outputs[0].capacity=57600000000n;
  const bytes=ccc.hexFrom(tx.toBytes()),hash=tx.hash(),events:string[]=[];
  const client={sendTransaction:jest.fn(async(actual:ccc.Transaction,validator?:string)=>{
    events.push("send");expect(ccc.hexFrom(actual.toBytes())).toBe(bytes);expect(actual.hash()).toBe(hash);expect(validator).toBe("passthrough");return hash;
  })};
  const signer={client,sendTransaction:async function(this:ccc.Signer,value:ccc.TransactionLike){return this.client.sendTransaction(value,"passthrough");}} as unknown as ccc.Signer;
  // A foreign instance exposes serialized bytes while its enumerable shape is
  // insufficient to reconstruct the transaction. The bytes are authoritative.
  const foreign={toBytes:()=>ccc.bytesFrom(bytes)} as unknown as ccc.Transaction;
  const observed=observeAdminTransactionAttempt(signer,async actual=>{events.push("remember");expect(ccc.hexFrom(actual.toBytes())).toBe(bytes);expect(actual.outputs[0].capacity).toBe(57600000000n);});
  await expect(observed.sendTransaction(foreign)).resolves.toBe(hash);
  expect(events).toEqual(["remember","send"]);
});

test("does not send when durable attempt recording fails",async()=>{
  const client={sendTransaction:jest.fn()};
  const signer={client,sendTransaction:async function(this:ccc.Signer,value:ccc.TransactionLike){return this.client.sendTransaction(value);}} as unknown as ccc.Signer;
  const observed=observeAdminTransactionAttempt(signer,()=>{throw Error("Receipt could not be saved");});
  await expect(observed.sendTransaction(ccc.Transaction.from({}))).rejects.toThrow("Receipt could not be saved");
  expect(client.sendTransaction).not.toHaveBeenCalled();
});
