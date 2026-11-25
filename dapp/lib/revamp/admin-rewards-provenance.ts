import { ccc } from "@ckb-ccc/connector-react";
import { AchievementDataVec, TransactionRecipe } from "ssri-ckboost/types";
import { coalesceDiscoveryRead, discoveryAbortError, runDiscoveryRequest } from "./discovery-loader";
import { withProfileDeadline, type ProfileReadScope } from "./profile-model";
import { assertRewardsAdmin, rewardsConnectedCell, rewardsHash, type AdminAchievement } from "./admin-rewards-model";

export interface AdminClaimProof {transactionHash: ccc.Hex; confirmedAt: number; blockNumber: string}
export interface AdminClaimProvenance {proofs: Map<string,AdminClaimProof>; unavailableReason: string|null}
const MAX_HISTORY_PAGES=4, HISTORY_PAGE_SIZE=50;
const claimMethod=ccc.hexFrom(new TextEncoder().encode("CKBoostAchievement.claim_achievement"));

/** Match the contract parser: the first valid recipe in witness order wins.
 * A later appended claim label cannot relabel an update as an actual claim. */
export function isAchievementClaimTransaction(tx: ccc.Transaction): boolean {
  for(const raw of tx.witnesses){
    try{
      const witness=ccc.WitnessArgs.fromBytes(raw);
      if(!witness.outputType)continue;
      const recipe=TransactionRecipe.decode(witness.outputType);
      if(ccc.hexFrom(TransactionRecipe.encode(recipe))!==witness.outputType.toLowerCase())continue;
      return ccc.hexFrom(recipe.method_path)===claimMethod&&recipe.arguments.length===0;
    }catch{/* Wallet signatures and empty witnesses are not recipes. */}
  }
  return false;
}
const recordKey=(record:{receiver_user_type_hash:ccc.BytesLike;granted_at:ccc.NumLike})=>`${rewardsHash(record.receiver_user_type_hash)}:${BigInt(ccc.numFrom(record.granted_at))}`;

/** Prove a recorded receiver was added by this confirmed claim transition.
 * This does not assert off-chain eligibility or reconstruct removed history. */
export function proveAchievementClaimTransition({achievement,transaction,transactionHash,parents,header}:{
  achievement:AdminAchievement;transaction:ccc.ClientTransactionResponse;transactionHash:ccc.Hex;
  parents:ReadonlyMap<string,ccc.ClientTransactionResponse>;header:ccc.ClientBlockHeader;
}):Map<string,AdminClaimProof>{
  const result=new Map<string,AdminClaimProof>(),tx=transaction.transaction,type=achievement.cell.cellOutput.type;
  if(!type||transaction.status!=="committed"||transaction.blockNumber==null||tx.hash().toLowerCase()!==transactionHash.toLowerCase()||!isAchievementClaimTransaction(tx))return result;
  if(header.number!==transaction.blockNumber||transaction.blockHash&&header.hash!==transaction.blockHash)throw new Error("The recorded claim's confirmed block does not match its transaction.");
  const confirmedAt=Number(header.timestamp);
  if(!Number.isSafeInteger(confirmedAt)||confirmedAt<=0||confirmedAt>8_640_000_000_000_000)throw new Error("The recorded claim's block time is unavailable.");
  const outputs=tx.outputs.flatMap((output,index)=>output.type?.eq(type)?[index]:[]);
  if(outputs.length!==1)return result;
  const previous:ccc.Cell[]=[];
  for(const input of tx.inputs){
    const parent=parents.get(input.previousOutput.txHash.toLowerCase());
    if(!parent||parent.status!=="committed"||parent.transaction.hash().toLowerCase()!==input.previousOutput.txHash.toLowerCase())throw new Error("A recorded claim input parent could not be verified.");
    const index=Number(input.previousOutput.index),output=parent.transaction.outputs[index],data=parent.transaction.outputsData[index];
    if(!output||data===undefined)throw new Error("A recorded claim input points outside its canonical parent transaction.");
    if(output.type?.eq(type))previous.push(ccc.Cell.from({outPoint:input.previousOutput,cellOutput:output,outputData:data}));
  }
  if(previous.length!==1||!previous[0].cellOutput.lock.eq(tx.outputs[outputs[0]].lock))return result;
  const before=AchievementDataVec.decode(previous[0].outputData),after=AchievementDataVec.decode(tx.outputsData[outputs[0]]);
  if(before.length!==after.length)return result;
  for(let index=0;index<before.length;index++){
    const old=before[index],next=after[index];
    if(old.achievement_title!==next.achievement_title||old.achievement_metadata!==next.achievement_metadata||next.receiver_user_record_vec.length<old.receiver_user_record_vec.length)return result;
    if(old.receiver_user_record_vec.some((record,recordIndex)=>recordKey(record)!==recordKey(next.receiver_user_record_vec[recordIndex])))return result;
  }
  const matching=after.flatMap((entry,index)=>entry.achievement_title===achievement.title?[index]:[]);
  if(matching.length!==1)return result;
  const index=matching[0],oldKeys=new Set(before[index].receiver_user_record_vec.map(recordKey));
  const added=after[index].receiver_user_record_vec.slice(before[index].receiver_user_record_vec.length).map(recordKey);
  for(const claim of achievement.claims){
    const key=`${claim.receiverTypeHash}:${claim.grantedAtRaw}`;
    // Duplicate records cannot be assigned a transaction unambiguously.
    if(oldKeys.has(key)||added.filter(value=>value===key).length!==1||achievement.claims.filter(row=>`${row.receiverTypeHash}:${row.grantedAtRaw}`===key).length!==1)continue;
    if(added.includes(key))result.set(claim.id,{transactionHash,confirmedAt,blockNumber:transaction.blockNumber.toString()});
  }
  return result;
}

async function read<T>(scope:ProfileReadScope,key:string,load:()=>Promise<T>,signal?:AbortSignal){
  if(signal?.aborted)throw discoveryAbortError();
  const result=await runDiscoveryRequest(scope.client,()=>coalesceDiscoveryRead(scope.client,`admin-rewards:${key}`,load),{signal});
  if(signal?.aborted)throw discoveryAbortError();
  return result;
}

export async function readAdminClaimProvenance(scope:ProfileReadScope,achievement:AdminAchievement,signal?:AbortSignal):Promise<AdminClaimProvenance>{
  assertRewardsAdmin(scope);
  const code=rewardsHash(scope.protocol.protocol_config.script_code_hashes.ckb_boost_achievement_type_code_hash);
  if(!rewardsConnectedCell(achievement.cell,code,scope.protocolHash)||!scope.protocol.protocol_config.achievement_type_hashes.some(hash=>rewardsHash(hash)===achievement.cell.cellOutput.type!.hash()))throw new Error("Claim history is available only for a published achievement in this protocol.");
  if(!achievement.claims.length)return{proofs:new Map(),unavailableReason:null};
  return withProfileDeadline(async signal=>{
    const type=achievement.cell.cellOutput.type;
    if(!type)throw new Error("The selected achievement has no full chain identity.");
    const proofs=new Map<string,AdminClaimProof>(),seen=new Set<string>();
    let cursor:string|undefined,complete=false;
    for(let pageNumber=0;pageNumber<MAX_HISTORY_PAGES;pageNumber++){
      const page=await read(scope,`claim-history:${type.hash()}:${cursor??"first"}`,()=>scope.client.findTransactionsPaged({script:type,scriptType:"type",scriptSearchMode:"exact",groupByTransaction:true},"desc",HISTORY_PAGE_SIZE,cursor),signal);
      for(const match of page.transactions){
        const txHash=rewardsHash(match.txHash);
        if(seen.has(txHash))throw new Error("The claim history repeated a transaction. Retry before using provenance.");
        seen.add(txHash);
        const transaction=await read(scope,`transaction:${txHash}`,()=>scope.client.getTransaction(txHash),signal);
        if(!transaction||transaction.status!=="committed"||transaction.blockNumber==null||transaction.transaction.hash().toLowerCase()!==txHash||transaction.blockNumber!==match.blockNumber)throw new Error("A claim history transaction could not be verified.");
        if(!isAchievementClaimTransaction(transaction.transaction))continue;
        const parents=new Map<string,ccc.ClientTransactionResponse>();
        await Promise.all([...new Set(transaction.transaction.inputs.map(input=>input.previousOutput.txHash.toLowerCase()))].map(async hash=>{
          const parent=await read(scope,`transaction:${hash}`,()=>scope.client.getTransaction(hash as ccc.Hex),signal);
          if(!parent)throw new Error("A claim history parent is unavailable.");
          parents.set(hash,parent);
        }));
        const header=await read(scope,`header:${transaction.blockNumber}`,()=>scope.client.getHeaderByNumber(transaction.blockNumber!),signal);
        if(!header)throw new Error("A claim history block is unavailable.");
        for(const[id,proof]of proveAchievementClaimTransition({achievement,transaction,transactionHash:txHash,parents,header}))if(!proofs.has(id))proofs.set(id,proof);
        if(proofs.size===achievement.claims.length)return{proofs,unavailableReason:null};
      }
      if(page.transactions.length<HISTORY_PAGE_SIZE){complete=true;break;}
      if(!page.lastCursor||page.lastCursor===cursor)throw new Error("The claim history did not advance to a new page.");
      cursor=page.lastCursor;
    }
    return{proofs,unavailableReason:complete?"Some claim transaction IDs could not be proven from recorded history. Unverified IDs remain unavailable.":"The claim history exceeds this query's 200-transaction budget. Unverified IDs remain unavailable."};
  },signal,20_000);
}
