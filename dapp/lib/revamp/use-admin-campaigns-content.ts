"use client";
import {useQuery} from "@tanstack/react-query";
import {ccc} from "@ckb-ccc/connector-react";
import {DEFAULT_NOSTR_RELAYS,useNostr} from "@/lib/providers/nostr-provider";
import {fetchNeventWithCache} from "@/lib/nostr/browser-fetch";
import {withProfileDeadline} from "./profile-model";
import {readAdminCampaignContent,readAdminCampaignStats} from "./admin-campaigns-content";
import type {useAdminCampaigns} from "./use-admin-campaigns";
export function useAdminCampaignContent(data:ReturnType<typeof useAdminCampaigns>,campaignId:string){
 const{nostr}=useNostr(),record=data.campaigns.data?.find(row=>row.id===campaignId)?.record??null,scope=data.scope;
 const key=["revamp-admin-campaign-content",data.session,record?.cell.outPoint.txHash,record?ccc.hashCkb(record.cell.outputData):null];
 const content=useQuery({queryKey:[...key,"nostr"],enabled:!!scope&&!!record,retry:false,staleTime:60_000,refetchOnWindowFocus:false,queryFn:({signal})=>withProfileDeadline(active=>readAdminCampaignContent(record!,async ref=>(await fetchNeventWithCache({nostr,neventId:ref,configuredRelays:DEFAULT_NOSTR_RELAYS})).event.content,active),signal,20_000)});
 const stats=useQuery({queryKey:[...key,"stats"],enabled:!!scope&&!!record,retry:false,staleTime:30_000,refetchOnWindowFocus:false,queryFn:({signal})=>withProfileDeadline(active=>readAdminCampaignStats(scope!,record!,active),signal,20_000)});
 return{content:{data:record&&!content.error?content.data??null:null,loading:!!record&&(content.isPending||content.isFetching),error:content.error?.message??null},stats:{data:record&&!stats.error?stats.data??null:null,loading:!!record&&(stats.isPending||stats.isFetching),error:stats.error?.message??null},retryContent:()=>void content.refetch(),retryStats:()=>void stats.refetch()};
}
