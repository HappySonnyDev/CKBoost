"use client";
import {useEffect,useState} from "react";
import {usePathname,useRouter,useSearchParams} from "next/navigation";
import {useAdminCampaigns} from "@/lib/revamp/use-admin-campaigns";
import {useAdminCampaignsApproval} from "@/lib/revamp/use-admin-campaigns-approval";
import {adminCampaignQueryString,adminCampaignRows,parseAdminCampaignQuery} from "@/lib/revamp/admin-campaigns-model";
import {AdminSectionShell} from "./admin-section-shell";
import {AdminCampaignsWorkspace} from "./admin-campaigns";
import {AdminCampaignApprovalStatus} from "./admin-campaigns-approval-status";
export function AdminCampaignsPage(){const data=useAdminCampaigns(),approval=useAdminCampaignsApproval(data),params=useSearchParams(),router=useRouter(),pathname=usePathname();const query=parseAdminCampaignQuery(new URLSearchParams(params.toString()));const[now,setNow]=useState(Date.now);useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),60_000);return()=>clearInterval(timer);},[]);let campaigns=data.campaigns;try{if(data.scope&&data.campaigns.data)campaigns={...campaigns,data:adminCampaignRows(data.scope,data.campaigns.data.map(row=>row.record),now)};}catch{}return <AdminSectionShell title="Campaigns" description="Review and manage campaigns across the platform." activeTab="campaigns"><AdminCampaignApprovalStatus approval={approval} network={data.scope?.network}/><AdminCampaignsWorkspace access={data.access} error={data.error} campaigns={campaigns} query={query} onQueryChange={next=>router.replace(`${pathname}?${adminCampaignQueryString(next)}`,{scroll:false})} onConnect={data.onConnect} onRetry={data.reload} onApprove={row=>{void approval.preview(row.record).then(plan=>{if(plan)void approval.approve(plan);});}} writeUnavailableReason={approval.writeUnavailableReason} approvingId={approval.busy?approval.operation?.campaignId:approval.pending.length?"pending":null}/></AdminSectionShell>;}
