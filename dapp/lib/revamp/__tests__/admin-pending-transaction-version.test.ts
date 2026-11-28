import {ccc} from "@ckb-ccc/connector-react";
import {observeAdminTransactionAttempt} from "../admin-pending-transaction";
import proof from "./fixtures/tip-create-016c-invalid-capacity-proof.json";
// Top-level 1.19 normalizes this body while the actual connector uses 1.12.
// An incompatible decoder must stop rather than change the user's raw hash.
jest.mock("@ckb-ccc/connector-react",()=>({ccc:jest.requireActual("@ckb-ccc/core")}));

test("rejects a decoder that raises an insufficient output while parsing exact public bytes",async()=>{
  const client={sendTransaction:jest.fn()},remember=jest.fn();
  const signer={client,sendTransaction:async function(this:ccc.Signer,value:ccc.TransactionLike){return this.client.sendTransaction(value);}} as unknown as ccc.Signer;
  const foreign={toBytes:()=>ccc.bytesFrom(proof.diagnosticReceipt.transactionHex)} as unknown as ccc.Transaction;
  await expect(observeAdminTransactionAttempt(signer,remember).sendTransaction(foreign)).rejects.toThrow(/decoder changed the exact public bytes/);
  expect(remember).not.toHaveBeenCalled();expect(client.sendTransaction).not.toHaveBeenCalled();
});
