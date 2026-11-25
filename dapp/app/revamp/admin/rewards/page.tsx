import { Suspense } from "react";
import { AdminRewardsPage } from "@/components/revamp/admin-rewards-page";
export default function Page(){return <Suspense fallback={<p role="status">Loading Rewards & Recognition…</p>}><AdminRewardsPage/></Suspense>;}
