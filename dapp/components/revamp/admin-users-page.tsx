"use client";

import {useAdminUsers} from "@/lib/revamp/use-admin-users";
import {adminUsersRegistryAdapter} from "@/lib/revamp/admin-registry-service";
import {AdminSectionShell} from "./admin-section-shell";
import {AdminUserProfile, AdminUsersDetailLayout, AdminUsersWorkspace} from "./admin-users";
import {RevampSiteShell} from "./site-shell";

export function AdminUsersPage({userId}: {userId?: string}) {
  const workspace = useAdminUsers({userId, registry: adminUsersRegistryAdapter});
  if (userId) return <RevampSiteShell><AdminUsersDetailLayout><AdminUserProfile workspace={workspace} /></AdminUsersDetailLayout></RevampSiteShell>;
  return <AdminSectionShell activeTab="users" title="User management" description="Manage access and identity verification for your community."><AdminUsersWorkspace workspace={workspace} /></AdminSectionShell>;
}
