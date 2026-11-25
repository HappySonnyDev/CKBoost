export const LEGACY_ADMIN_TABS = ["overview", "campaigns", "users", "tips", "rewards", "achievements", "protocol"] as const;
export type LegacyAdminTab = typeof LEGACY_ADMIN_TABS[number];

export function legacyAdminTab(value: string | null): LegacyAdminTab {
  return LEGACY_ADMIN_TABS.find(tab => tab === value) ?? "overview";
}

export const ADMIN_NAVIGATION = [
  {id: "overview", label: "Overview", href: "/revamp/admin"},
  {id: "campaigns", label: "Campaigns", href: "/revamp/admin/campaigns"},
  {id: "users", label: "Users", href: "/revamp/admin/users"},
  {id: "tipping", label: "Tipping", href: "/revamp/admin/tipping"},
  {id: "rewards", label: "Rewards & Recognition", href: "/revamp/admin/rewards"},
] as const;
export const ADMIN_OVERVIEW_NAVIGATION = ADMIN_NAVIGATION;

export function legacyAdminHref(currentQuery: string, tab: LegacyAdminTab): string {
  const query = new URLSearchParams(currentQuery);
  query.set("tab", tab);
  return `/platform-admin?${query}`;
}
