"use client";

import { ccc } from "@ckb-ccc/connector-react";
import { useProtocol } from "@/lib/providers/protocol-provider";
import { useHeaderAccount } from "@/lib/revamp/use-header-account";
import { useProfileBadges } from "@/lib/revamp/use-profile-badges";
import { ProfileBadges } from "./profile-badges";
import { RevampSiteShell } from "./site-shell";

export function ProfileBadgesPage() {
  const { open } = ccc.useCcc();
  const protocol = useProtocol();
  const account = useHeaderAccount({ protocolCell: protocol.protocolCell, protocolLoading: protocol.isLoading, protocolError: protocol.error });
  const identity = account.address && account.lockHash ? { address: account.address, lockHash: account.lockHash } : null;
  const badges = useProfileBadges({ protocolCell: protocol.protocolCell, identity });
  return <RevampSiteShell><ProfileBadges connected={account.isConnected}
    scopeKey={`${identity?.lockHash ?? ""}:${protocol.protocolCell?.cellOutput.type?.hash() ?? ""}`}
    loading={account.isConnected && (protocol.isLoading || !identity && account.isLoading || badges.isLoading)}
    error={protocol.error ?? badges.error ?? (!identity && account.isConnected && !account.isLoading ? account.error ?? "The current wallet could not be loaded." : null)}
    badges={badges.badges} eligibilityUnavailableReason={badges.eligibilityUnavailableReason}
    onConnect={open} onRetry={() => { account.refresh(); badges.retry(); void protocol.refreshProtocolData().catch(() => {}); }}
  /></RevampSiteShell>;
}
