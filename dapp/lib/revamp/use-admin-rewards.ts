"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ccc } from "@ckb-ccc/connector-react";
import { useProtocol } from "@/lib/providers/protocol-provider";
import { usePendingTransactions } from "@/lib/providers/pending-transaction-provider";
import { useNostr, DEFAULT_NOSTR_RELAYS } from "@/lib/providers/nostr-provider";
import { currentDeployment } from "@/lib/ckb/current-deployment";
import { getDiscoveryReadClient } from "./discovery-read-client";
import { makeProfileReadScope, withProfileDeadline, type ProfileReadScope } from "./profile-model";
import { assertRewardsAdmin, readAdminAchievements, readAdminAchievementUsers, readAdminRewardsAssets, validateActivityBonus, type AdminRewardPeriod } from "./admin-rewards-model";
import { readAdminClaimProvenance } from "./admin-rewards-provenance";
import { readAdminRewardPeriods, saveAdminRewardPeriod } from "./admin-registry-service";
import { confirmAdminActivityBonus, saveAdminActivityBonus, type ActivityBonusReceipt } from "./admin-rewards-transactions";
import type { RewardsOperation, RewardsResource } from "@/components/revamp/admin-rewards";

const objects=new WeakMap<object,number>();let nextObject=1;
function objectId(value:object|undefined){if(!value)return 0;const existing=objects.get(value);if(existing)return existing;const id=nextObject++;objects.set(value,id);return id;}
const message=(error:unknown)=>error instanceof Error?error.message:"Rewards & Recognition could not be loaded.";
function resource<T>(query:{data:T|undefined;isPending:boolean;isFetching:boolean;error:Error|null},enabled:boolean):RewardsResource<T>{return{data:enabled&&!query.error?query.data??null:null,loading:enabled&&(query.isPending||query.isFetching),error:enabled&&query.error?message(query.error):null};}
const idle:RewardsOperation={phase:"idle",transactionHash:null,error:null};

export function useAdminRewards({tab="achievements",achievementId=null,periodId=null,formOnly=false}:{tab?:"achievements"|"leaderboard";achievementId?:string|null;periodId?:string|null;formOnly?:boolean}={}){
  const signer=ccc.useSigner(),{client:walletClient,signerInfo,open}=ccc.useCcc();
  const protocol=useProtocol(),{nostr}=useNostr(),{confirmationTarget}=usePendingTransactions(),queries=useQueryClient();
  const [revision,setRevision]=useState(0),[bonusState,setBonusState]=useState<{key:string;operation:RewardsOperation}|null>(null),[periodState,setPeriodState]=useState<{key:string;operation:RewardsOperation}|null>(null);
  const busy=useRef(new Set<string>()),bonusPending=useRef(new Map<string,ActivityBonusReceipt>());
  const configuration=useMemo(()=>{try{const network=currentDeployment.getCurrentNetwork();return{network,client:getDiscoveryReadClient(network),error:null};}catch(error){return{network:null,client:null,error:message(error)};}},[walletClient]);
  const cell=protocol.protocolCell,protocolKey=cell?`${cell.cellOutput.type?.hash()}:${cell.outPoint.txHash}:${cell.outPoint.index}:${ccc.hashCkb(cell.outputData)}`:"pending";
  const sessionKey=[objectId(signer),objectId(signerInfo),objectId(walletClient),objectId(configuration.client??undefined),configuration.network,protocolKey,revision].join(":");
  const session=useRef(sessionKey);session.current=sessionKey;
  useEffect(()=>signer?.onReplaced?.(()=>setRevision(value=>value+1)),[signer,revision]);
  const scopeEnabled=Boolean(signer&&cell&&!protocol.isLoading&&!protocol.error&&configuration.client);
  const rootKey=["revamp-admin-rewards",sessionKey] as const;
  const scopeQuery=useQuery<ProfileReadScope,Error>({queryKey:[...rootKey,"scope"],enabled:scopeEnabled,retry:false,staleTime:30_000,refetchOnWindowFocus:true,
    queryFn:({signal})=>withProfileDeadline(async()=>{if(!signer||!cell||!configuration.client||!configuration.network)throw new Error("Connect an administrator wallet and load the protocol.");const address=await signer.getRecommendedAddressObj();if(session.current!==sessionKey)throw new Error("The wallet or protocol changed.");return makeProfileReadScope(configuration.client,cell,address,configuration.network);},signal,12_000)});
  const scope=scopeEnabled&&!scopeQuery.error?scopeQuery.data??null:null;
  let allowed=false;try{if(scope){assertRewardsAdmin(scope);allowed=true;}}catch{/* A role label is never authorization. */}
  const error=protocol.error??configuration.error??(scopeQuery.error?message(scopeQuery.error):null);
  const access=!signer?"disconnected":error?"error":!scope?"checking":allowed?"allowed":"denied";
  const key=[...rootKey,scope?.protocolHash??null,scope?.lockHash??null] as const;
  const operationKey=scope?`${scope.network}:${scope.protocolHash}:${scope.lockHash}`:"unresolved";
  const current=useRef({sessionKey,scope,signer,allowed});current.current={sessionKey,scope,signer,allowed};
  async function guard(captured=current.current){
    if(!captured.scope||!captured.signer||!captured.allowed||current.current.sessionKey!==captured.sessionKey||current.current.signer!==captured.signer)throw new Error("The administrator wallet or protocol changed.");
    const hash=(await captured.signer.getRecommendedAddressObj()).script.hash().toLowerCase();
    if(current.current.sessionKey!==captured.sessionKey||hash!==captured.scope.lockHash.toLowerCase()){if(current.current.sessionKey===captured.sessionKey)setRevision(value=>value+1);throw new Error("The wallet account changed. Reload Rewards & Recognition.");}
    assertRewardsAdmin(captured.scope);
  }
  const definitions=useQuery({queryKey:[...key,"achievements"],enabled:allowed&&!formOnly,retry:false,staleTime:30_000,refetchOnWindowFocus:false,
    queryFn:({signal})=>withProfileDeadline(async signal=>{const captured=current.current;await guard(captured);const result=await readAdminAchievements(scope!,signal);await guard(captured);return result;},signal)});
  const achievements=resource(definitions,allowed&&!formOnly);
  const achievement=achievements.data?(achievementId?achievements.data.find(row=>row.id===achievementId)??null:achievements.data[0]??null):null;
  const registry=useQuery({queryKey:[...key,"periods"],enabled:allowed,retry:false,staleTime:30_000,refetchOnWindowFocus:false,
    queryFn:({signal})=>withProfileDeadline(async signal=>{const captured=current.current;await guard(captured);const result=await readAdminRewardPeriods(scope!,signal);await guard(captured);return result;},signal)});
  const periodList=resource(registry,allowed),periods:RewardsResource<AdminRewardPeriod[]>={...periodList,data:periodList.data?.available?periodList.data.periods:null};
  const period=periods.data?(periodId?periods.data.find(row=>row.id===periodId)??null:periods.data[0]??null):null;
  const assetsQuery=useQuery({queryKey:[...key,"assets"],enabled:allowed,retry:false,staleTime:30_000,refetchOnWindowFocus:false,
    queryFn:async()=>{const captured=current.current;await guard(captured);const assets=await readAdminRewardsAssets(scope!);await guard(captured);return assets;}});
  const receiverQuery=useQuery({queryKey:[...key,"claim-users",definitions.dataUpdatedAt],enabled:Boolean(allowed&&achievements.data?.some(row=>row.claims.length)),retry:false,staleTime:30_000,refetchOnWindowFocus:false,
    queryFn:({signal})=>withProfileDeadline(async signal=>{const captured=current.current;await guard(captured);const result=await readAdminAchievementUsers(scope!,achievements.data!,signal);await guard(captured);return result;},signal)});
  const metadataQuery=useQuery({queryKey:[...key,"metadata",achievement?.id,achievement?.metadataNeventId],enabled:Boolean(allowed&&tab==="achievements"&&achievement?.metadataNeventId),retry:false,staleTime:60_000,refetchOnWindowFocus:false,
    queryFn:({signal})=>withProfileDeadline(async()=>{const captured=current.current;await guard(captured);const {fetchNeventWithCache}=await import("@/lib/nostr/browser-fetch");const result=await fetchNeventWithCache({nostr,neventId:achievement!.metadataNeventId,configuredRelays:DEFAULT_NOSTR_RELAYS});await guard(captured);if(result.event.content.length>65_536)throw new Error("The achievement description exceeds the supported size.");let content=result.event.content;try{const payload=JSON.parse(content);if(typeof payload.description_html==="string")content=payload.description_html;else if(typeof payload.content==="string")content=payload.content;else throw new Error("The achievement description format is unavailable.");}catch(error){if(content.trim().startsWith("{"))throw error;}return content;},signal,12_000)});
  const proofQuery=useQuery({queryKey:[...key,"claim-provenance",achievement?.id,achievement?.cell.outPoint.txHash],enabled:Boolean(allowed&&tab==="achievements"&&achievement?.claims.length),retry:false,staleTime:60_000,refetchOnWindowFocus:false,
    queryFn:({signal})=>withProfileDeadline(async signal=>{const captured=current.current;await guard(captured);const result=await readAdminClaimProvenance(scope!,achievement!,signal);await guard(captured);return result;},signal,22_000)});
  async function onSaveBonus(days:string,points:string){
    if(busy.current.has(`bonus:${operationKey}`))throw new Error("An activity bonus update is already in progress.");
    const values=validateActivityBonus(days,points),captured=current.current,stable=operationKey,pending=bonusPending.current.get(stable);
    if(pending&&(pending.seconds!==values.seconds.toString()||pending.points!==values.points.toString()))throw new Error("Confirm the previous activity bonus update before saving different values.");
    busy.current.add(`bonus:${stable}`);
    const publish=(operation:RewardsOperation)=>{if(current.current.scope?.protocolHash===captured.scope?.protocolHash&&current.current.scope?.lockHash===captured.scope?.lockHash)setBonusState({key:stable,operation});};
    try{
      await guard(captured);publish({phase:pending?"confirming":"signing",transactionHash:pending?.transactionHash??null,error:null});
      if(pending)await confirmAdminActivityBonus(captured.scope!,captured.signer!,pending,()=>guard(captured),confirmationTarget);
      else await saveAdminActivityBonus({scope:captured.scope!,signer:captured.signer!,days,points,isCurrent:()=>guard(captured),confirmationTarget,onBroadcast:receipt=>{bonusPending.current.set(stable,receipt);publish({phase:"confirming",transactionHash:receipt.transactionHash,error:null});}});
      const receipt=bonusPending.current.get(stable);bonusPending.current.delete(stable);
      publish({phase:"confirmed",transactionHash:receipt?.transactionHash??pending?.transactionHash??null,error:null});
      await protocol.refreshProtocolData();
    }catch(error){publish({phase:"error",transactionHash:bonusPending.current.get(stable)?.transactionHash??null,error:message(error)});throw error;}finally{busy.current.delete(`bonus:${stable}`);}
  }
  async function onSavePeriod(value:AdminRewardPeriod){
    if(busy.current.has(`period:${operationKey}`))throw new Error("A reward period update is already in progress.");
    const captured=current.current,stable=operationKey;busy.current.add(`period:${stable}`);
    try{
      await guard(captured);setPeriodState({key:stable,operation:{phase:"signing",transactionHash:null,error:null}});
      const result=await saveAdminRewardPeriod(captured.scope!,captured.signer!,value,()=>guard(captured));
      await guard(captured);setPeriodState({key:stable,operation:{phase:"confirmed",transactionHash:result.transactionHash,error:null}});
      await queries.invalidateQueries({queryKey:[...key,"periods"]});
      return result;
    }catch(error){if(current.current.sessionKey===captured.sessionKey)setPeriodState({key:stable,operation:{phase:"error",transactionHash:null,error:message(error)}});throw error;}finally{busy.current.delete(`period:${stable}`);}
  }
  return{scopeKey:sessionKey,access:access as "checking"|"disconnected"|"denied"|"allowed"|"error",accessError:error,tab,achievement,period,achievements,periods,
    registryAvailable:periodList.data?.available??null,registryUnavailableReason:periodList.data?.unavailableReason??null,assets:resource(assetsQuery,allowed),
    metadata:resource(metadataQuery,Boolean(allowed&&tab==="achievements"&&achievement?.metadataNeventId)),provenance:resource(proofQuery,Boolean(allowed&&tab==="achievements"&&achievement?.claims.length)),users:resource(receiverQuery,Boolean(allowed&&achievements.data?.some(row=>row.claims.length))),
    currentLockHash:scope?.lockHash??null,network:configuration.network??"testnet",
    bonusDays:scope&&BigInt(scope.protocol.protocol_config.streak_bonus_interval)%86400n===0n?(BigInt(scope.protocol.protocol_config.streak_bonus_interval)/86400n).toString():"",bonusPoints:scope?BigInt(scope.protocol.protocol_config.streak_bonus_amount).toString():"",
    bonusOperation:bonusState?.key===operationKey?bonusState.operation:idle,periodOperation:periodState?.key===operationKey?periodState.operation:idle,
    onSaveBonus,onSavePeriod,onConnect:open,onRetryAccess:()=>{setRevision(value=>value+1);void protocol.refreshProtocolData().catch(()=>{});},
    onRetryAchievements:()=>{if(allowed)void definitions.refetch();},onRetryPeriods:()=>{if(allowed)void registry.refetch();},onRetryMetadata:()=>{if(allowed&&achievement?.metadataNeventId)void metadataQuery.refetch();},onRetryProvenance:()=>{if(allowed&&achievement?.claims.length)void proofQuery.refetch();},
  };
}
