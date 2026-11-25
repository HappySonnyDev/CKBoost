import { ccc } from "@ckb-ccc/connector-react";
import { ProtocolData } from "ssri-ckboost/types";
import { fetchProtocolCell } from "@/lib/ckb/protocol-cells";
import { getIsolatedRuntime } from "@/lib/ckb/isolated-runtime.mjs";
import { assertRewardsAdmin, validateActivityBonus } from "./admin-rewards-model";
import { makeProfileReadScope, withProfileDeadline, type ProfileReadScope } from "./profile-model";

export interface ActivityBonusReceipt {transactionHash:ccc.Hex;seconds:string;points:string}
export function assertIsolatedRewardsWrite(scope:ProfileReadScope){
  const runtime=getIsolatedRuntime();
  if(!runtime||scope.network!=="testnet"||runtime.protocol.typeHash!==scope.protocolHash)throw new Error("Reward configuration writes are enabled only in the explicitly isolated QA protocol.");
}
export async function confirmAdminActivityBonus(scope:ProfileReadScope,signer:ccc.Signer,receipt:ActivityBonusReceipt,isCurrent:()=>Promise<void>,confirmationTarget=1):Promise<ActivityBonusReceipt>{
  await isCurrent();
  const response=await signer.client.waitTransaction(receipt.transactionHash,confirmationTarget,300_000,2_000);
  if(!response)throw new Error("The activity bonus transaction is not confirmed yet. Check it before sending again.");
  if(response.status!=="committed"||response.transaction.hash()!==receipt.transactionHash)throw new Error("The activity bonus receipt does not match a confirmed transaction.");
  const outputs=response.transaction.outputs.flatMap((output,index)=>output.type?.eq(scope.protocolCell.cellOutput.type!)?[index]:[]);
  if(outputs.length!==1)throw new Error("The confirmed transaction does not uniquely update this protocol.");
  const saved=ProtocolData.decode(response.transaction.outputsData[outputs[0]]);
  if(BigInt(saved.protocol_config.streak_bonus_interval).toString()!==receipt.seconds||BigInt(saved.protocol_config.streak_bonus_amount).toString()!==receipt.points)throw new Error("The confirmed transaction does not contain the requested activity bonus.");
  await isCurrent();
  const current=await withProfileDeadline(()=>fetchProtocolCell(scope.client));
  if(!current||!current.cellOutput.type?.eq(scope.protocolCell.cellOutput.type!))throw new Error("The confirmed bonus configuration could not be read for this protocol.");
  const data=ProtocolData.decode(current.outputData);
  if(BigInt(data.protocol_config.streak_bonus_interval).toString()!==receipt.seconds||BigInt(data.protocol_config.streak_bonus_amount).toString()!==receipt.points)throw new Error("The transaction confirmed, but the updated activity bonus is not indexed yet. Check again before resubmitting.");
  await isCurrent();
  return receipt;
}

/** Called only by an explicit Save action. A receipt is exposed immediately
 * after send so a confirmation retry never creates a second transaction. */
export async function saveAdminActivityBonus({scope,signer,days,points,isCurrent,onBroadcast,confirmationTarget=1}:{
  scope:ProfileReadScope;signer:ccc.Signer;days:string;points:string;isCurrent:()=>Promise<void>;
  onBroadcast:(receipt:ActivityBonusReceipt)=>void;confirmationTarget?:number;
}):Promise<ActivityBonusReceipt>{
  assertIsolatedRewardsWrite(scope);
  assertRewardsAdmin(scope);
  const values=validateActivityBonus(days,points);
  await isCurrent();
  const address=await signer.getRecommendedAddressObj();
  if(address.script.hash().toLowerCase()!==scope.lockHash.toLowerCase())throw new Error("The administrator wallet changed.");
  const cell=await withProfileDeadline(()=>fetchProtocolCell(scope.client));
  if(!cell||!cell.cellOutput.type?.eq(scope.protocolCell.cellOutput.type!))throw new Error("The current protocol is unavailable.");
  const fresh=makeProfileReadScope(scope.client,cell,address,scope.network);
  assertRewardsAdmin(fresh);
  const unchanged=async()=>{
    await isCurrent();
    const actual=(await signer.getRecommendedAddressObj()).script.hash();
    if(actual.toLowerCase()!==fresh.lockHash.toLowerCase())throw new Error("The administrator wallet changed before broadcast.");
    const latest=await withProfileDeadline(()=>fetchProtocolCell(scope.client));
    if(!latest||latest.outPoint.txHash!==cell.outPoint.txHash||latest.outPoint.index!==cell.outPoint.index||latest.outputData!==cell.outputData)throw new Error("The protocol changed. Reload its current configuration before saving.");
    assertRewardsAdmin(makeProfileReadScope(scope.client,latest,address,scope.network));
    await isCurrent();
  };
  const data={...fresh.protocol,protocol_config:{...fresh.protocol.protocol_config,streak_bonus_interval:values.seconds,streak_bonus_amount:values.points},last_updated:BigInt(Math.floor(Date.now()/1000))};
  const {ProtocolService}=await import("@/lib/services/protocol-service");
  let observed:ActivityBonusReceipt|undefined;
  const client=new Proxy(signer.client,{get(target,key){
    if(key==="sendTransaction")return async(...args:Parameters<ccc.Client["sendTransaction"]>)=>{
      await unchanged();
      observed={transactionHash:ccc.Transaction.from(args[0]).hash(),seconds:values.seconds.toString(),points:values.points.toString()};
      // Keep the exact public hash even if submission loses its acknowledgement.
      onBroadcast(observed);
      return target.sendTransaction(...args);
    };
    const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;
  }});
  const guarded=new Proxy(signer,{get(target,key,receiver){
    if(key==="client")return client;
    if(key==="sendTransaction")return async(...args:Parameters<ccc.Signer["sendTransaction"]>)=>{await unchanged();return target.sendTransaction.apply(receiver,args);};
    const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;
  }});
  const service=new ProtocolService(guarded,{allowFeeRetry:false});
  await unchanged();
  const transactionHash=await service.updateProtocol(data);
  const receipt={transactionHash,seconds:values.seconds.toString(),points:values.points.toString()};
  if(observed&&observed.transactionHash!==transactionHash)throw new Error("The wallet returned an unexpected activity bonus transaction ID. Inspect the recorded transaction before retrying.");
  if(!observed)onBroadcast(receipt);
  return confirmAdminActivityBonus(scope,signer,receipt,isCurrent,confirmationTarget);
}
