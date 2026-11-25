import {Suspense} from "react";
import {AdminCampaignsPage} from "@/components/revamp/admin-campaigns-page";
export default function Page(){return <Suspense fallback={<p role="status">Loading campaigns…</p>}><AdminCampaignsPage/></Suspense>;}
