import {ccc} from "@ckb-ccc/connector-react";
import {getIsolatedRuntime} from "@/lib/ckb/isolated-runtime.mjs";
import {ProtocolData} from "ssri-ckboost/types";
import {isOverviewAdmin} from "./admin-overview-model";
import {adminCampaignRows} from "./admin-campaigns-model";
import type {AdminCampaignRecord} from "./admin-overview-model";
import {profileTimestamp,withProfileDeadline,type ProfileReadScope} from "./profile-model";
import {coalesceDiscoveryRead,runDiscoveryRequest} from "./discovery-loader";
/** New Admin writes are deliberately restricted to the explicitly configured isolated QA protocol. */
export function assertAdminQaScope(scope:Pick<ProfileReadScope,"network"|"protocolHash">):void{const runtime=getIsolatedRuntime();if(!runtime||runtime.network!=="testnet"||scope.network!=="testnet"||runtime.protocol.typeHash.toLowerCase()!==scope.protocolHash.toLowerCase())throw Error("New Admin writes are enabled only for the explicitly configured isolated Testnet QA protocol. This environment is read-only.");}
export type AdminCampaignApprovalPlan={campaignId:ccc.Hex;campaignTitle:string;protocolHash:ccc.Hex;protocolOutPoint:string;protocolDataHash:ccc.Hex;campaignOutPoint:string;campaignDataHash:ccc.Hex;actorLockHash:ccc.Hex;updated:ReturnType<typeof ProtocolData.decode>};
export const adminCampaignPoint=(cell:ccc.Cell)=>`${cell.outPoint.txHash}:${cell.outPoint.index}`;
export function makeAdminCampaignApprovalPlan(scope:ProfileReadScope,campaign:AdminCampaignRecord,now=Date.now()):AdminCampaignApprovalPlan{
 assertAdminQaScope(scope);
 if(!isOverviewAdmin(scope))throw Error("Only a current platform Admin can approve campaigns.");
 const row=adminCampaignRows(scope,[campaign],now)[0];
 if(row.status!=="under-review")throw Error("This campaign is already approved. Reload its current status.");
 if(!row.ownerLockHash)throw Error("This campaign's full ownership and protocol lock could not be verified.");
 const updated=ProtocolData.decode(ProtocolData.encode(scope.protocol));updated.campaigns_approved.push(campaign.id);updated.last_updated=BigInt(now);
 return{campaignId:campaign.id,campaignTitle:row.title,protocolHash:scope.protocolHash,protocolOutPoint:adminCampaignPoint(scope.protocolCell),protocolDataHash:ccc.hashCkb(scope.protocolCell.outputData),campaignOutPoint:adminCampaignPoint(campaign.cell),campaignDataHash:ccc.hashCkb(campaign.cell.outputData),actorLockHash:scope.lockHash,updated};
}
export function assertAdminCampaignApprovalPlan(plan:AdminCampaignApprovalPlan,scope:ProfileReadScope,campaign:AdminCampaignRecord){
 if(scope.protocolHash!==plan.protocolHash||scope.lockHash!==plan.actorLockHash||adminCampaignPoint(scope.protocolCell)!==plan.protocolOutPoint||ccc.hashCkb(scope.protocolCell.outputData)!==plan.protocolDataHash||adminCampaignPoint(campaign.cell)!==plan.campaignOutPoint||ccc.hashCkb(campaign.cell.outputData)!==plan.campaignDataHash)throw Error("The protocol permissions or campaign changed after review. Reload before approving.");
 const rebuilt=makeAdminCampaignApprovalPlan(scope,campaign,Number(plan.updated.last_updated));
 if(ccc.hexFrom(ProtocolData.encode(rebuilt.updated))!==ccc.hexFrom(ProtocolData.encode(plan.updated)))throw Error("The approval preview does not match the current protocol.");
}
export type PendingAdminCampaignApproval={schema:"ckboost-admin-campaign-approval/v1";network:"testnet"|"mainnet";protocolHash:ccc.Hex;campaignId:ccc.Hex;actorLockHash:ccc.Hex;transactionHash:ccc.Hex};
/** A receipt is a lookup key, not approval evidence. Bind the confirmed body
 * to one canonical protocol input/output and the input state's actual Admin.
 * Plain actor capacity must decrease, disabling unsigned ACP deposit unlocks. */
export function assertAdminCampaignApprovalEvidence(scope:ProfileReadScope,receipt:PendingAdminCampaignApproval,response:ccc.ClientTransactionResponse,parents:ReadonlyMap<string,ccc.ClientTransactionResponse>):void {
 assertAdminQaScope(scope);
 if(!isOverviewAdmin(scope)||receipt.network!==scope.network||receipt.protocolHash!==scope.protocolHash)throw Error("The approval receipt belongs to another administrator or protocol scope.");
 const tx=response.transaction,type=scope.protocolCell.cellOutput.type;
 if(response.status!=="committed"||tx.hash()!==receipt.transactionHash||!type)throw Error("The approval transaction is not a verified committed body.");
 const outputIndices=tx.outputs.flatMap((output,index)=>output.type?.eq(type)?[index]:[]);
 if(outputIndices.length!==1)throw Error("The approval transaction must contain one exact protocol output.");
 const inputs=tx.inputs.map(input=>{
  const parent=parents.get(input.previousOutput.txHash);
  if(!parent||parent.status!=="committed"||parent.transaction.hash()!==input.previousOutput.txHash)throw Error("A protocol approval input parent could not be verified.");
  const index=Number(input.previousOutput.index),output=parent.transaction.outputs[index],data=parent.transaction.outputsData[index];
  if(!output||data===undefined)throw Error("A protocol approval input points outside its canonical parent.");
  return {output,data};
 });
 const protocolInputs=inputs.filter(input=>input.output.type?.eq(type));
 if(protocolInputs.length!==1)throw Error("The approval transaction did not consume one exact protocol input.");
 const previous=protocolInputs[0],outputIndex=outputIndices[0],output=tx.outputs[outputIndex],outputData=tx.outputsData[outputIndex];
 if(!previous.output.lock.eq(output.lock)||output.capacity<previous.output.capacity)throw Error("The approval changed the protocol authorization lock or released its capacity.");
 const before=ProtocolData.decode(previous.data),after=ProtocolData.decode(outputData);
 if(ccc.hexFrom(ProtocolData.encode(before))!==previous.data||ccc.hexFrom(ProtocolData.encode(after))!==outputData)throw Error("The approval protocol data is not canonical.");
 if(!before.protocol_config.admin_lock_hash_vec.some(hash=>ccc.hexFrom(hash)===receipt.actorLockHash))throw Error("The recorded approval actor was not an Admin in the consumed protocol state.");
 if(before.campaigns_approved.some(hash=>ccc.hexFrom(hash)===receipt.campaignId))throw Error("The consumed protocol already approved this campaign; this is not its approval transaction.");
 const expected=ProtocolData.decode(previous.data);expected.campaigns_approved.push(receipt.campaignId);expected.last_updated=after.last_updated;
 const oldTime=profileTimestamp(before.last_updated),newTime=profileTimestamp(after.last_updated);
 if(newTime===null||oldTime!==null&&newTime<oldTime||ccc.hexFrom(ProtocolData.encode(expected))!==outputData)throw Error("The committed transaction does not prove only the requested campaign approval and timestamp update.");
 const actorInputs=inputs.filter(input=>input.output.lock.hash()===receipt.actorLockHash),actorOutputs=tx.outputs.filter(output=>output.lock.hash()===receipt.actorLockHash);
 if(!actorInputs.some(input=>!input.output.type&&input.data==="0x")||actorInputs.reduce((sum,input)=>sum+input.output.capacity,0n)<=actorOutputs.reduce((sum,output)=>sum+output.capacity,0n))throw Error("The recorded approval actor's plain signed capacity spend is not proven.");
}
export async function readAdminCampaignApprovalEvidence(scope:ProfileReadScope,receipt:PendingAdminCampaignApproval,response:ccc.ClientTransactionResponse,signal?:AbortSignal):Promise<void>{
 assertAdminQaScope(scope);if(!isOverviewAdmin(scope))throw Error("Current Admin access is required to check an approval.");
 const hashes=[...new Set(response.transaction.inputs.map(input=>input.previousOutput.txHash))];if(hashes.length>100)throw Error("Approval evidence exceeds the 100-parent proof budget.");
 const parents=new Map(await Promise.all(hashes.map(async hash=>{
  const parent=await withProfileDeadline(()=>coalesceDiscoveryRead(scope.client,`admin-approval-parent:${hash}`,()=>runDiscoveryRequest(scope.client,()=>scope.client.getTransaction(hash))),signal,12_000);
  if(!parent)throw Error("An approval input parent is unavailable. Retry confirmation.");return[hash,parent]as const;
 })));
 assertAdminCampaignApprovalEvidence(scope,receipt,response,parents);
}
export function parseAdminCampaignApprovals(raw:string|null):PendingAdminCampaignApproval[]{try{if(!raw||raw.length>32_000)return[];const input:unknown=JSON.parse(raw);if(!Array.isArray(input))return[];return input.slice(0,50).filter(value=>value&&typeof value==="object"&&value.schema==="ckboost-admin-campaign-approval/v1"&&(value.network==="testnet"||value.network==="mainnet")&&[value.protocolHash,value.campaignId,value.actorLockHash,value.transactionHash].every(v=>typeof v==="string"&&/^0x[0-9a-f]{64}$/.test(v))).map(value=>({schema:"ckboost-admin-campaign-approval/v1",network:value.network,protocolHash:value.protocolHash,campaignId:value.campaignId,actorLockHash:value.actorLockHash,transactionHash:value.transactionHash}));}catch{return[];}}
