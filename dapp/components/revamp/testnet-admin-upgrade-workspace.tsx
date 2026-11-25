"use client";

import {useEffect,useMemo,useRef,useState} from "react";
import {ccc} from "@ckb-ccc/connector-react";
import {RevampButton} from "./ui";
import {ADMIN_UPGRADE_PROTOCOL,ADMIN_UPGRADE_REGISTRY,ADMIN_UPGRADE_RELEASE,assertAdminUpgradeQa,broadcastAdminRegistryUpgrade,confirmAdminRegistryUpgrade,readAdminUpgradeReceipt,reviewAdminRegistryUpgrade,signAdminRegistryUpgrade,validateAdminRegistryUpgradePlan,type AdminRegistryUpgradeConfirmation,type AdminRegistryUpgradeReceipt,type AdminRegistryUpgradeReview,type AdminRegistryUpgradeStage} from "@/lib/revamp/testnet-admin-upgrade";
import styles from "./testnet-admin-upgrade.module.css";

const stages=["code","state"] as const;
const amount=(value:string|bigint)=>{const n=BigInt(value);return `${n/100000000n}.${(n%100000000n).toString().padStart(8,"0")}`.replace(/\.?0+$/,"");};
function download(value:unknown,name:string){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:"application/json"}));const link=document.createElement("a");link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}

/** Each signature and send requires a separate user click. Rendering, wallet
 * connection and public confirmation cannot deploy or activate anything. */
export function TestnetAdminUpgradeWorkspace(){
  const signer=ccc.useSigner(),{open}=ccc.useCcc();
  const readClient=useMemo(()=>new ccc.ClientPublicTestnet({url:"https://testnet.ckbapp.dev/",fallbacks:[]}),[]);
  const planResult=useMemo(()=>{try{assertAdminUpgradeQa(readClient);return {plan:validateAdminRegistryUpgradePlan(),error:null};}catch(cause){return {plan:null,error:cause instanceof Error?cause.message:"The isolated QA plan is unavailable."};}},[readClient]);
  const [address,setAddress]=useState<string|null>(null),[storageReady,setStorageReady]=useState(false),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false);
  const [receipts,setReceipts]=useState<Partial<Record<AdminRegistryUpgradeStage,AdminRegistryUpgradeReceipt>>>({});
  const [reviews,setReviews]=useState<Partial<Record<AdminRegistryUpgradeStage,AdminRegistryUpgradeReview>>>({});
  const [confirmations,setConfirmations]=useState<Partial<Record<AdminRegistryUpgradeStage,AdminRegistryUpgradeConfirmation>>>({});
  const mounted=useRef(true),inFlight=useRef(false),scope=useRef({signer});if(scope.current.signer!==signer)scope.current={signer};
  const refreshReceipts=()=>{const next:typeof receipts={};for(const stage of stages){const saved=readAdminUpgradeReceipt(stage);if(saved)next[stage]=saved;}setReceipts(next);};
  useEffect(()=>{mounted.current=true;try{refreshReceipts();setStorageReady(true);}catch(cause){setError(cause instanceof Error?cause.message:"The saved upgrade receipts cannot be read. No wallet action is allowed.");}return()=>{mounted.current=false;};},[]);// eslint-disable-line react-hooks/exhaustive-deps
  useEffect(()=>{let stale=false;setReviews({});setAddress(null);if(signer)void signer.getRecommendedAddressObj().then(a=>{if(!stale)setAddress(a.toString());}).catch(()=>{});return()=>{stale=true;};},[signer]);
  async function run(task:(guard:()=>boolean)=>Promise<void>){
    if(inFlight.current||!planResult.plan)return;inFlight.current=true;setBusy(true);setError(null);const captured=scope.current,guard=()=>mounted.current&&scope.current===captured;
    try{await task(guard);}catch(cause){if(guard())setError(cause instanceof Error?cause.message:"The operation stopped. Inspect the saved receipt before another wallet action.");}
    finally{inFlight.current=false;if(mounted.current){setBusy(false);try{refreshReceipts();}catch(cause){setStorageReady(false);setError(cause instanceof Error?cause.message:"Receipt storage is unavailable.");}}}
  }
  const check=(stage:AdminRegistryUpgradeStage)=>run(async guard=>{const result=await confirmAdminRegistryUpgrade(readClient,stage,guard);if(guard()){setConfirmations(previous=>({...previous,[stage]:result}));if(result.status==="confirmed")setReviews(previous=>({...previous,[stage]:undefined}));}});
  const review=(stage:AdminRegistryUpgradeStage)=>run(async guard=>{if(!signer)return;const result=await reviewAdminRegistryUpgrade(signer,stage,guard);if(guard())setReviews(previous=>({...previous,[stage]:result}));});
  const sign=(stage:AdminRegistryUpgradeStage)=>run(async guard=>{if(!signer)return;const receipt=await signAdminRegistryUpgrade(signer,stage,guard);if(guard()){setReceipts(previous=>({...previous,[stage]:receipt}));setReviews(previous=>({...previous,[stage]:undefined}));}});
  const broadcast=(stage:AdminRegistryUpgradeStage)=>run(async guard=>{if(!signer)return;const receipt=await broadcastAdminRegistryUpgrade(signer,stage,guard);if(guard())setReceipts(previous=>({...previous,[stage]:receipt}));});
  const codeConfirmed=confirmations.code?.status==="confirmed";
  const manifest=confirmations.state?.status==="confirmed"?confirmations.state.manifest:null;
  const plan=planResult.plan;
  return <main id="revamp-main" className={styles.workspace}>
    <p className={styles.eyebrow}>ISOLATED QA · PUBLIC CKB TESTNET · OPERATOR REVIEW</p>
    <h1>Create the QA Admin registry</h1>
    <p>Review two fixed transactions. Account 1 deploys the Registry code first, then creates its protocol-bound state. Each stage has separate sign and broadcast buttons.</p>
    <p className={styles.notice}>This tool never updates the app configuration, activates a registry, upgrades the other contracts, or changes Organizer roles. Existing protocol, campaign, User, Points and claim-pool identities are retained.</p>
    {planResult.error&&<p role="alert" className={styles.error}>{planResult.error}</p>}
    {plan&&<>
      <section className={styles.card} aria-label="Fixed QA scope">
        <h2>Fixed public scope</h2><dl><dt>Protocol</dt><dd><code>{ADMIN_UPGRADE_PROTOCOL}</code></dd><dt>Registry full type hash</dt><dd><code>{ADMIN_UPGRADE_REGISTRY}</code></dd><dt>Reviewed Registry ELF</dt><dd>{ADMIN_UPGRADE_RELEASE.byteLength.toLocaleString()} bytes · <code>{ADMIN_UPGRADE_RELEASE.dataHash}</code></dd></dl>
        <p>Connected: <code>{address??"No wallet connected"}</code></p>
        <RevampButton variant="secondary" onClick={()=>open()} disabled={busy}>Connect Account 1 · address ending 2rlz</RevampButton>
        <p>Initial settings preserve the reviewed protocol snapshot: {Number(plan.registry.tipping.expirationSeconds)/86400} days, thresholds {plan.registry.tipping.thresholdsShannons.map(amount).join(" / ")} tCKB. Tip approvers are the existing endorser locks listed below; this grants no Organizer role.</p>
        <ul>{plan.registry.tipping.approverLockHashes.map(hash=><li key={hash}><code>{hash}</code></li>)}</ul>
        <p>Public funding snapshot ({plan.source.financialCheckedAt}): no old QA Tips, shared Funding cells, or Funding cells for either of the two QA Campaigns. This snapshot is not a migration or a guarantee about future chain state.</p>
      </section>
      {stages.map(stage=>{const fixed=plan.source[stage],receipt=receipts[stage],reviewed=reviews[stage],confirmation=confirmations[stage],confirmed=confirmation?.status==="confirmed",enabled=stage==="code"||codeConfirmed;
        return <section className={styles.card} key={stage} aria-label={`${stage} stage`}>
          <h2>{stage==="code"?"1. Registry code deployment":"2. Registry state creation"}</h2>
          <p>{stage==="code"?"Spends the one fixed empty Account 1 input. Output 0 stores the reviewed code under a fresh TypeID; output 1 returns ordinary capacity to Account 1.":"Spends only output 1 of the exact code transaction. Output 0 uses the same complete custom Registry script for type and lock. It is unavailable until the exact code is committed and live."}</p>
          <dl><dt>Fixed transaction hash</dt><dd><code>{fixed.transactionHash}</code></dd><dt>Occupied output capacity</dt><dd>{amount(fixed.occupiedOutputShannons)} tCKB</dd><dt>Network fee</dt><dd>{amount(fixed.feeShannons!)} tCKB</dd></dl>
          {stage==="state"&&!codeConfirmed&&<p className={styles.notice}>Confirm the exact live code deployment before reviewing or signing this stage. The planned state input does not exist yet.</p>}
          {confirmed?<p role="status">Confirmed: actual committed transaction and exact current live output verified.</p>:<>
            {!receipt&&<><RevampButton variant="secondary" disabled={!signer||busy||!enabled||!storageReady} onClick={()=>void review(stage)}>Review {stage} stage · reads only</RevampButton>{reviewed&&<RevampButton disabled={!signer||busy||!enabled||!storageReady} onClick={()=>void sign(stage)}>Sign {stage} transaction · save only</RevampButton>}</>}
            {receipt?.phase==="signed"&&<><p>Signed transaction saved. It has not been broadcast by this tool.</p><RevampButton disabled={!signer||busy||!enabled||!storageReady} onClick={()=>void broadcast(stage)}>Verify &amp; broadcast {stage} once</RevampButton></>}
            {receipt?.phase==="broadcast-attempted"&&<p className={styles.notice}>A broadcast attempt is recorded. A missing acknowledgement does not permit another send. Use confirmation below.</p>}
          </>}
          <RevampButton variant="secondary" disabled={busy} onClick={()=>void check(stage)}>Check {stage} confirmation · no signing</RevampButton>
          {receipt&&<RevampButton variant="secondary" onClick={()=>download(receipt,`ckboost-qa-admin-registry-${stage}-signed.json`)}>Export saved public signed receipt</RevampButton>}
          {confirmation&&confirmation.status!=="confirmed"&&<p role="status">{confirmation.message}</p>}
        </section>;
      })}
      <section className={styles.card}><h2>Anchor and recovery rules</h2><p>Changing the code transaction body, its first input, or output positions changes the linked Registry identity. The wallet must preserve the fixed raw body hash. If it changes, stop, recompute the anchor and recompile the dependent candidate contracts.</p><p>Saved signed receipts prevent repeat signing. An attempted broadcast can only be checked for confirmation. Do not delete a receipt to deploy another copy.</p>{manifest&&<><p>Both stages are independently confirmed. Exporting this public manifest does not activate it.</p><RevampButton variant="secondary" onClick={()=>download(manifest,"ckboost-qa-admin-registry-confirmed.json")}>Export confirmed Registry manifest</RevampButton></>}</section>
    </>}
    {busy&&<p role="status">Working… Complete any wallet request already open.</p>}
    {error&&<p role="alert" className={styles.error}>{error}</p>}
  </main>;
}
