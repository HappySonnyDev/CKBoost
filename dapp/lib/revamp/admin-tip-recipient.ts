import {ccc} from "@ckb-ccc/connector-react";
import {UserData} from "ssri-ckboost/types";
import {adminUserId} from "./admin-users-model";
import {assertTippingProtocolScope} from "./admin-tipping-model";
import {runDiscoveryRequest} from "./discovery-loader";
import {readProfilePages,withProfileDeadline,type ProfileReadScope} from "./profile-model";

/** Absence alone can use a separately verified address-resolution path.
 * Conflicts and failed chain proofs must never be treated as absence. */
export class TipRecipientUserNotFoundError extends Error {
  constructor(){super("No current User Cell in this protocol proves the recipient lock. Payment preparation stopped.");this.name="TipRecipientUserNotFoundError";}
}

function completeHash(value:ccc.HexLike):ccc.Hex {
  const hash=ccc.hexFrom(value).toLowerCase();
  if(!/^0x[0-9a-f]{64}$/.test(hash)||/^0x0{64}$/.test(hash))throw new Error("A complete nonzero recipient lock hash is required.");
  return hash as ccc.Hex;
}
function sameOutput(a:ccc.CellOutput,b:ccc.CellOutput):boolean {
  return ccc.hexFrom(a.toBytes())===ccc.hexFrom(b.toBytes());
}

/** Resolve a payment destination from this protocol's actual User state.
 * Public reads do not require Admin access and never grant permission to pay.
 * The caller must obtain the hash from the fresh, exact Tip and retain its
 * normal actor, policy, QA-only and final transaction guards. */
export async function resolveProtocolTipRecipient(scope:ProfileReadScope,lockHash:ccc.HexLike,signal?:AbortSignal):Promise<ccc.Script> {
  assertTippingProtocolScope(scope);const target=completeHash(lockHash);
  const codeHash=completeHash(scope.protocol.protocol_config.script_code_hashes.ckb_boost_user_type_code_hash);
  if(typeof scope.client.getTransactionNoCache!=="function"||typeof scope.client.getCellLiveNoCache!=="function")throw new Error("Recipient verification requires uncached transaction and live-cell reads. No cached or explorer fallback is allowed.");
  return withProfileDeadline(async active=>{
    const rows=await readProfilePages(scope,{script:{codeHash,hashType:"type",args:"0x"},scriptType:"type",scriptSearchMode:"prefix",withData:true},`tip-recipient:${scope.network}:${scope.protocolHash}:${codeHash}:${target}`,active);
    const candidates=rows.filter(cell=>adminUserId(scope,cell)!==null&&cell.cellOutput.lock.hash().toLowerCase()===target);
    if(!candidates.length)throw new TipRecipientUserNotFoundError();
    if(candidates.length!==1)throw new Error("Multiple current User Cells match this recipient. Resolve the conflicting identities before payment.");
    const candidate=candidates[0],index=Number(candidate.outPoint.index);
    try{if(ccc.hexFrom(UserData.encode(UserData.decode(candidate.outputData)))!==candidate.outputData)throw new Error("Noncanonical User data");}
    catch{throw new Error("The recipient User Cell data is not canonical. Payment preparation stopped.");}
    const read=<T,>(operation:()=>Promise<T>)=>runDiscoveryRequest(scope.client,operation,{signal:active});
    const parent=await read(()=>scope.client.getTransactionNoCache(candidate.outPoint.txHash));
    if(!parent||parent.status!=="committed"||parent.blockNumber==null||ccc.numFrom(parent.blockNumber)<0n||!parent.transaction||parent.transaction.hash()!==candidate.outPoint.txHash)throw new Error("The recipient User Cell's committed parent transaction could not be verified.");
    const output=parent.transaction.outputs[index],outputData=parent.transaction.outputsData[index];
    if(!output||outputData===undefined||!sameOutput(output,candidate.cellOutput)||outputData!==candidate.outputData)throw new Error("The recipient User Cell differs from its exact committed parent output.");
    // Include pending spends in this final live check. A concurrent User update
    // therefore requires a fresh lookup rather than accepting an old point.
    const live=await read(()=>scope.client.getCellLiveNoCache(candidate.outPoint,true,true));
    if(!live||!live.outPoint.eq(candidate.outPoint)||!sameOutput(live.cellOutput,candidate.cellOutput)||live.outputData!==candidate.outputData||adminUserId(scope,live)!==adminUserId(scope,candidate)||live.cellOutput.lock.hash().toLowerCase()!==target)throw new Error("The exact recipient User Cell is no longer live or its lock/data changed. Retry the read-only lookup.");
    if(active.aborted)throw new Error("The recipient lookup was cancelled.");
    // Return an independent copy, without retaining mutable indexer objects.
    return ccc.Script.fromBytes(live.cellOutput.lock.toBytes());
  },signal,12_000);
}
