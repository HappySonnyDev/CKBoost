import {notFound} from "next/navigation";
import {getIsolatedRuntime} from "@/lib/ckb/isolated-runtime.mjs";
import {TestnetAdminUpgradeWorkspace} from "@/components/revamp/testnet-admin-upgrade-workspace";
export const dynamic="force-dynamic";
export default function TestnetAdminUpgradePage(){
  const runtime=getIsolatedRuntime();
  if(!runtime||runtime.network!=="testnet"||runtime.protocol.typeHash!=="0x4eacaf9b1a120d2bfd99f26fcedfdcfe6ef116484e9b478b0a104a872316e034")notFound();
  return <TestnetAdminUpgradeWorkspace/>;
}
