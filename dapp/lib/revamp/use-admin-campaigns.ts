"use client";
import {useEffect,useMemo,useRef,useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {ccc} from "@ckb-ccc/connector-react";
import {useProtocol} from "@/lib/providers/protocol-provider";
import {currentDeployment} from "@/lib/ckb/current-deployment";
import {getDiscoveryReadClient} from "./discovery-read-client";
import {makeProfileReadScope,withProfileDeadline} from "./profile-model";
import {isOverviewAdmin} from "./admin-overview-model";
import {adminCampaignRows,readAdminCampaigns} from "./admin-campaigns-model";
const identities=new WeakMap<object,number>();let nextId=1;
function id(object:object|undefined){if(!object)return 0;let value=identities.get(object);if(!value){value=nextId++;identities.set(object,value);}return value;}
const message=(e:unknown)=>e instanceof Error?e.message:"Unable to load current campaigns.";
/** Current authoritative cell only. Never consume the editable protocol form. */
export function useAdminCampaigns(){
 const signer=ccc.useSigner(),{client:walletClient,signerInfo,open}=ccc.useCcc(),protocol=useProtocol();
 const[revision,setRevision]=useState(0);
 const configuration=useMemo(()=>{try{const network=currentDeployment.getCurrentNetwork();return{network,client:getDiscoveryReadClient(network),error:null};}catch(e){return{network:null,client:null,error:message(e)};}},[walletClient]);
 const cell=protocol.protocolCell,cellKey=cell?`${cell.cellOutput.type?.hash()}:${cell.outPoint.txHash}:${cell.outPoint.index}:${ccc.hashCkb(cell.outputData)}`:"pending";
 const session=[id(signer),id(signerInfo),id(walletClient),id(configuration.client??undefined),configuration.network,cellKey,revision].join(":");const current=useRef(session);current.current=session;
 useEffect(()=>{current.current=session;return()=>{if(current.current===session)current.current="retired";};},[session]);
 const enabled=Boolean(signer&&cell&&!protocol.isLoading&&!protocol.error&&configuration.client);
 const scopeQuery=useQuery({queryKey:["revamp-admin-campaigns-scope",session],enabled,retry:false,staleTime:15_000,refetchOnWindowFocus:true,queryFn:({signal})=>withProfileDeadline(async()=>{if(!signer||!cell||!configuration.client||!configuration.network)throw Error("Connect a wallet and load the current protocol.");const address=await signer.getRecommendedAddressObj();if(current.current!==session)throw Error("The wallet or protocol changed.");return makeProfileReadScope(configuration.client,cell,address,configuration.network);},signal,12_000)});
 const scope=enabled?scopeQuery.data??null:null,error=protocol.error??configuration.error??(scopeQuery.error?message(scopeQuery.error):null),allowed=!!scope&&isOverviewAdmin(scope);
 const access=!signer?"disconnected":error?"error":!scope?"checking":allowed?"allowed":"denied";
 const records=useQuery({queryKey:["revamp-admin-campaigns",session,scope?.protocolHash,scope?.lockHash],enabled:allowed,retry:false,staleTime:15_000,refetchOnWindowFocus:false,queryFn:({signal})=>withProfileDeadline(async signal=>{if(!scope||!signer)throw Error("Current Admin access is required.");const address=await signer.getRecommendedAddressObj();if(current.current!==session||address.script.hash()!==scope.lockHash)throw Error("The wallet changed. Reopen Campaigns.");const result=await readAdminCampaigns(scope,signal);if(current.current!==session||(await signer.getRecommendedAddressObj()).script.hash()!==scope.lockHash)throw Error("The wallet changed. Reopen Campaigns.");return result;},signal,20_000)});
 let data=null,readError=records.error?message(records.error):null;
 try{if(allowed&&scope&&records.data&&!readError)data=adminCampaignRows(scope,records.data);}catch(e){readError=message(e);}
 function reload(){setRevision(value=>value+1);void protocol.refreshProtocolData().catch(()=>{});}
 return{access:access as "disconnected"|"checking"|"error"|"allowed"|"denied",error,scope:allowed?scope:null,signer,session,isCurrent:()=>current.current===session,campaigns:{data:allowed?data:null,loading:allowed&&(records.isPending||records.isFetching),error:allowed?readError:null},onConnect:open,reload};
}
