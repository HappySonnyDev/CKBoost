import {notFound} from "next/navigation";
import {getIsolatedRuntime} from "@/lib/ckb/isolated-runtime.mjs";
import {TestnetAdminFinancialOperatorWorkspace} from "@/components/revamp/testnet-admin-financial-operator-workspace";

export const dynamic="force-dynamic";
export default function Page(){
  const runtime=getIsolatedRuntime();
  if(!runtime||runtime.network!=="testnet"||runtime.protocol.typeHash!=="0x4eacaf9b1a120d2bfd99f26fcedfdcfe6ef116484e9b478b0a104a872316e034")notFound();
  return <TestnetAdminFinancialOperatorWorkspace/>;
}
