import {Suspense} from "react";
import {AdminTipNewPage} from "@/components/revamp/admin-tipping";
export default function Page(){return <Suspense fallback={<p>Loading proposal form…</p>}><AdminTipNewPage/></Suspense>;}
