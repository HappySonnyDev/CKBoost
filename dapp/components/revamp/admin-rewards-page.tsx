"use client";
import { useSearchParams } from "next/navigation";
import { useAdminRewards } from "@/lib/revamp/use-admin-rewards";
import { AdminSectionShell } from "./admin-section-shell";
import { AdminRewards } from "./admin-rewards";
import { AdminRewardPeriodForm } from "./admin-rewards-period-form";
import { RevampSiteShell } from "./site-shell";

export function AdminRewardsPage(){
  const query=useSearchParams(),tab=query.get("tab")==="leaderboard"?"leaderboard":"achievements";
  const workspace=useAdminRewards({tab,achievementId:query.get("achievement"),periodId:query.get("period")});
  return <AdminSectionShell title="Rewards & Recognition" description="View published achievements, recorded claims, and leaderboard rewards." activeTab="rewards"><AdminRewards {...workspace}/></AdminSectionShell>;
}
export function AdminNewRewardPeriodPage(){
  const workspace=useAdminRewards({tab:"leaderboard",formOnly:true});
  return <RevampSiteShell><AdminRewardPeriodForm scopeKey={workspace.scopeKey} access={workspace.access} accessError={workspace.accessError} assets={workspace.assets} registryAvailable={workspace.registryAvailable} registryUnavailableReason={workspace.registryUnavailableReason} registryLoading={workspace.registryLoading} registryError={workspace.registryError} onRetryConfiguration={workspace.onRetryConfiguration} operation={workspace.periodOperation} onSave={workspace.onSavePeriod} onRetry={workspace.onRetryAccess} onConnect={workspace.onConnect}/></RevampSiteShell>;
}
