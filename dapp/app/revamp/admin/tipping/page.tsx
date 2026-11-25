import {Suspense} from "react";
import {AdminTippingPage} from "@/components/revamp/admin-tipping";
export default function Page(){return <Suspense fallback={<p>Loading Tipping…</p>}><AdminTippingPage/></Suspense>;}
