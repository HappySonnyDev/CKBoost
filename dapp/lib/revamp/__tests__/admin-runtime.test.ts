import {ccc} from "@ckb-ccc/core";
import {ProtocolData} from "ssri-ckboost/types";
import {makeAdminUpgradedIsolatedRuntimeConfig,validateIsolatedRuntimeConfig,isolatedRuntimeEnvironment,getIsolatedRuntime} from "../../ckb/isolated-runtime.mjs";
import {adminRuntimeFixture} from "./admin-runtime-fixtures";
const clone=<T,>(v:T):T=>JSON.parse(JSON.stringify(v));
test("v4 deterministically preserves original sources and all nonfinancial identities",()=>{
 const f=adminRuntimeFixture(),before=JSON.stringify(f.base),runtime=makeAdminUpgradedIsolatedRuntimeConfig(f.base,f.bundle);
 expect(runtime.schema).toBe("ckboost-isolated-testnet-runtime/v4");expect(validateIsolatedRuntimeConfig(runtime)).toEqual(runtime);expect(runtime.profileHash).not.toBe(f.base.profileHash);expect(runtime.protocol).toEqual(f.base.protocol);
 for(const name of ["ckboostProtocolType","ckboostCampaignType","ckboostUserType","ckboostPointsUdt","ckboostAchievementType"])expect(runtime.current.testnet[name]).toEqual(f.base.current.testnet[name as keyof typeof f.base.current.testnet]);expect(runtime.claimablePool).toEqual(f.base.claimablePool);
 for(const name of ["protocolManifest","protocolCodeManifest","campaignCodeManifest","profile","userCodeDeploymentManifest","codeUpgradeManifests"] as const)expect(runtime.sources[name]).toEqual(f.base.sources[name]);expect(runtime.sources.adminParentProfileHash).toBe(f.base.profileHash);expect(JSON.stringify(f.base)).toBe(before);expect(Object.isFrozen(runtime)).toBe(true);
 const env=isolatedRuntimeEnvironment(runtime);expect(getIsolatedRuntime(env)).toEqual(runtime);expect(JSON.parse(env.NEXT_PUBLIC_CKBOOST_ADMIN_REGISTRY).protocolTypeHash).toBe(f.base.protocol.typeHash);expect(JSON.parse(env.NEXT_PUBLIC_CKBOOST_ADMIN_TIPPING).registryTypeHash).toBe("0x97e23b14d33e0445c1eac09f1948e2c3652547bfbb7fb7db56978f48baff9690");expect(env.CKBOOST_NEXT_DIST_DIR).not.toBe(isolatedRuntimeEnvironment(f.base).CKBOOST_NEXT_DIST_DIR);
});
test("unconfirmed, incomplete inventory or wrong parent/binary/full Registry identity fails closed",()=>{
 const f=adminRuntimeFixture();for(const change of [(v:typeof f.bundle)=>{v.confirmation.status="pending";},(v:typeof f.bundle)=>{v.financialInventory.campaignFunding=1;},(v:typeof f.bundle)=>{v.financialInventory.complete=false;},(v:typeof f.bundle)=>{v.financial.fundingLock.dataHash=`0x${"ac".repeat(32)}`;},(v:typeof f.bundle)=>{v.registry.typeScript.args=`0x${"aa".repeat(64)}`;},(v:typeof f.bundle)=>{v.confirmation.liveCells.registryCode.live=false;}]){const value=clone(f.bundle);change(value);expect(()=>makeAdminUpgradedIsolatedRuntimeConfig(f.base,value)).toThrow(/Admin upgrade/);}
 expect(()=>makeAdminUpgradedIsolatedRuntimeConfig({...f.base,profileHash:`0x${"cc".repeat(32)}`},f.bundle)).toThrow();
});
test("wrong atomic batch positions, reused identity, missing consumption and foreign owner cannot pass",()=>{
 const f=adminRuntimeFixture();for(const change of [(v:typeof f.bundle)=>{v.financial.tippingType.index="0x2";},(v:typeof f.bundle)=>{v.financial.fundingLock.transactionHash=`0x${"cc".repeat(32)}`;},(v:typeof f.bundle)=>{const m=v.financial.protocolLock;if(!("upgradeEvidence" in m))throw Error("Expected upgrade fixture");m.upgradeEvidence.consumedOutPoint.index="0x1";},(v:typeof f.bundle)=>{v.financial.tippingType.lockScript.args="0x01";}]){const value=clone(f.bundle);change(value);expect(()=>makeAdminUpgradedIsolatedRuntimeConfig(f.base,value)).toThrow(/Admin upgrade/);}
});
test("an unrelated protocol mutation cannot be hidden behind a valid new raw body/hash",()=>{
 const f=adminRuntimeFixture(),v=clone(f.bundle),tx=ccc.Transaction.fromBytes(v.protocolUpdate.transactionHex),decoded=ProtocolData.decode(tx.outputsData[0]);decoded.protocol_config.admin_lock_hash_vec=[];tx.outputsData[0]=ccc.hexFrom(ProtocolData.encode(decoded));v.protocolUpdate.transactionHash=tx.hash();v.protocolUpdate.transactionHex=ccc.hexFrom(tx.toBytes());v.protocolUpdate.after.outPoint.txHash=tx.hash();v.protocolUpdate.after.dataHex=tx.outputsData[0];v.protocolUpdate.after.dataHash=ccc.hashCkb(tx.outputsData[0]);const live=v.confirmation.liveCells.protocolState;live.outPoint.txHash=tx.hash();live.dataHex=tx.outputsData[0];live.dataHash=ccc.hashCkb(tx.outputsData[0]);live.dataBytes=ccc.bytesFrom(tx.outputsData[0]).length;expect(()=>makeAdminUpgradedIsolatedRuntimeConfig(f.base,v)).toThrow(/only Tip\/Funding/);
});
test("forged live code/protocol snapshot and independently overridden capability environment fail",()=>{
 const f=adminRuntimeFixture(),v=clone(f.bundle);v.confirmation.liveCells.protocolState.capacityShannons="1";expect(()=>makeAdminUpgradedIsolatedRuntimeConfig(f.base,v)).toThrow(/live snapshot/);
 const runtime=makeAdminUpgradedIsolatedRuntimeConfig(f.base,f.bundle),env=isolatedRuntimeEnvironment(runtime);env.NEXT_PUBLIC_CKBOOST_ADMIN_TIPPING="{}";expect(()=>getIsolatedRuntime(env)).toThrow(/capability/);delete env.NEXT_PUBLIC_CKBOOST_ADMIN_REGISTRY;expect(()=>getIsolatedRuntime(env)).toThrow(/capability/);
 expect(isolatedRuntimeEnvironment(f.base).NEXT_PUBLIC_CKBOOST_ADMIN_REGISTRY).toBe("");expect(isolatedRuntimeEnvironment(f.base).NEXT_PUBLIC_CKBOOST_ADMIN_TIPPING).toBe("");
});
