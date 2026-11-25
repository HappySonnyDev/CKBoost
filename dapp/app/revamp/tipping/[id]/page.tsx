import {notFound} from "next/navigation";
import {AdminTipDetailPage} from "@/components/revamp/admin-tipping";

/** Standalone proposal review. List, creation, funding and settings retain
 * their separate Admin-only gates; this alias does not grant that role. */
export default async function Page({params}:{params:Promise<{id:string}>}) {
  const {id}=await params;
  if(!/^0x[0-9a-f]{64}$/i.test(id))notFound();
  return <AdminTipDetailPage tipId={id.toLowerCase()} publicView/>;
}
