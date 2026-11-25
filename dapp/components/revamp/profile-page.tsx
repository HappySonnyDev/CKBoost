"use client";

import Link from "next/link";
import { useProtocol } from "@/lib/providers/protocol-provider";
import { useProfileWorkspace } from "@/lib/revamp/use-profile-workspace";
import { useProfileBadges } from "@/lib/revamp/use-profile-badges";
import { ProfileWorkspace, type ProfileClaimedBadge } from "./profile-workspace";
import { RevampSiteShell } from "./site-shell";
import { RevampButton } from "./ui";

export function ProfilePage() {
  const workspace = useProfileWorkspace();
  const { protocolCell } = useProtocol();
  const badges = useProfileBadges({ protocolCell, identity: workspace.identity });
  const claimed: ProfileClaimedBadge[] = badges.badges.filter(badge => badge.claimed).map(badge => ({
    id: badge.id,
    name: badge.title,
    kind: badge.classification === "telegram-verification" ? "telegram" : badge.classification === "first-submission" ? "first-submission" : undefined,
  }));
  async function saveName(name: string) {
    try { await workspace.onSaveName(name); }
    catch (error) {
      if (error instanceof Error && error.message === "Telegram validation failed at server") {
        throw new Error("The profile verification service is unavailable. Your saved name is unchanged. Please try again later.");
      }
      throw error;
    }
  }
  return <RevampSiteShell><ProfileWorkspace {...workspace}
    onSaveName={saveName}
    rewardsDescription={workspace.rewardsLabel}
    rewardsActions={<RevampButton asChild size="small" variant="secondary"><Link prefetch={false} href="/profile">Manage reward claims</Link></RevampButton>}
    achievements={{ data: workspace.identity && !badges.isLoading && !badges.error ? claimed : null, loading: badges.isLoading, error: badges.error }}
    onRetryAchievements={badges.retry}
  /></RevampSiteShell>;
}
