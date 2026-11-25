import {notFound} from "next/navigation";
import {AdminTipDetailPage} from "@/components/revamp/admin-tipping";
export default async function Page({params}:{params:Promise<{id:string}>}){const {id}=await params;if(!/^0x[0-9a-f]{64}$/i.test(id))notFound();return <AdminTipDetailPage tipId={id.toLowerCase()}/>;}
