import {AdminUsersPage} from "@/components/revamp/admin-users-page";
import {notFound} from "next/navigation";
export default async function UserPage({params}: {params: Promise<{fullUserTypeId: string}>}) {
  const {fullUserTypeId} = await params;
  if (!/^0x[0-9a-f]{64}$/i.test(fullUserTypeId)) notFound();
  return <AdminUsersPage userId={fullUserTypeId.toLowerCase()} />;
}
