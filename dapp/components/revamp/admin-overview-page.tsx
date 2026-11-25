"use client";

import { useAdminOverview } from "@/lib/revamp/use-admin-overview";
import { ADMIN_OVERVIEW_NAVIGATION } from "@/lib/revamp/admin-navigation";
import { AdminOverview } from "./admin-overview";
import { RevampSiteShell } from "./site-shell";

const navigation = ADMIN_OVERVIEW_NAVIGATION.map(({id, href}) => ({id, href}));

export function AdminOverviewPage() {
  const overview = useAdminOverview();
  return <RevampSiteShell><AdminOverview {...overview} navigation={navigation} /></RevampSiteShell>;
}
