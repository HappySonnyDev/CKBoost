export const LEGACY_ADMIN_TABS = ["overview", "campaigns", "users", "tips", "rewards", "achievements", "protocol"] as const;
export type LegacyAdminTab = typeof LEGACY_ADMIN_TABS[number];

export function legacyAdminTab(value: string | null): LegacyAdminTab {
  return LEGACY_ADMIN_TABS.find(tab => tab === value) ?? "overview";
}

/** Remaining workflows keep their existing working routes during the redesign. */
export const ADMIN_OVERVIEW_NAVIGATION = [
  {id: "overview", label: "Overview", href: "/revamp/admin"},
  {id: "campaigns", label: "Campaigns", href: "/platform-admin?tab=campaigns"},
  {id: "users", label: "Users", href: "/platform-admin?tab=users"},
  {id: "tipping", label: "Tipping", href: "/tipping"},
  {id: "rewards", label: "Rewards & Recognition", href: "/platform-admin?tab=rewards"},
] as const;

export function legacyAdminHref(currentQuery: string, tab: LegacyAdminTab): string {
  const query = new URLSearchParams(currentQuery);
  query.set("tab", tab);
  return `/platform-admin?${query}`;
}
