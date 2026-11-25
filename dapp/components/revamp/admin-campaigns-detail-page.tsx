"use client";
import Link from "next/link";
import {usePathname,useRouter,useSearchParams} from "next/navigation";
import {useAdminCampaigns} from "@/lib/revamp/use-admin-campaigns";
import {useAdminCampaignsApproval} from "@/lib/revamp/use-admin-campaigns-approval";
import {useAdminCampaignContent} from "@/lib/revamp/use-admin-campaigns-content";
import {adminCampaignReturnQuery} from "@/lib/revamp/admin-campaigns-model";
import {RevampSiteShell} from "./site-shell";
import {AdminSectionShell} from "./admin-section-shell";
import {AdminCampaignAccessState} from "./admin-campaigns";
import {AdminCampaignDetail} from "./admin-campaigns-detail";
import {AdminCampaignApprovalStatus} from "./admin-campaigns-approval-status";
import {RevampButton} from "./ui";
import styles from "./admin-campaigns.module.css";
export function AdminCampaignDetailPage({campaignTypeId}:{campaignTypeId:string}){const data=useAdminCampaigns(),approval=useAdminCampaignsApproval(data),content=useAdminCampaignContent(data,campaignTypeId),params=useSearchParams(),router=useRouter(),pathname=usePathname(),row=data.campaigns.data?.find(row=>row.id===campaignTypeId.toLowerCase()),backHref=`/revamp/admin/campaigns?${adminCampaignReturnQuery(params.get("from"))}`;
if(data.access!=="allowed")return <AdminSectionShell title="Campaigns" description="Review and manage campaigns across the platform." activeTab="campaigns"><AdminCampaignAccessState access={data.access} error={data.error} onConnect={data.onConnect} onRetry={data.reload}/></AdminSectionShell>;
if(!row)return <AdminSectionShell title="Campaigns" description="Review and manage campaigns across the platform." activeTab="campaigns"><section className={styles.access}><h2>{data.campaigns.loading?"Loading campaign…":data.campaigns.error?"Campaign unavailable":"Campaign not found"}</h2>{data.campaigns.error&&<p role="alert">{data.campaigns.error}</p>}<RevampButton variant="secondary" onClick={data.reload}>Retry campaign</RevampButton><Link prefetch={false} href={backHref}>Return to campaigns</Link></section></AdminSectionShell>;
return <RevampSiteShell><main id="revamp-main"><AdminCampaignDetail row={row} backHref={backHref} tab={params.get("tab")==="quests"?"quests":"overview"} onTabChange={tab=>{const next=new URLSearchParams(params.toString());if(tab==="overview")next.delete("tab");else next.set("tab",tab);router.replace(`${pathname}?${next}`,{scroll:false});}} content={content.content} stats={content.stats} onRetryContent={content.retryContent} onRetryStats={content.retryStats} onApprove={()=>{void approval.preview(row.record).then(plan=>{if(plan)void approval.approve(plan);});}} approvalStatus={<AdminCampaignApprovalStatus approval={approval} network={data.scope?.network}/>} writeUnavailableReason={approval.writeUnavailableReason} busy={approval.busy||approval.pending.length>0}/></main></RevampSiteShell>;}
