"use client";

import {useEffect,useMemo,useRef,useState} from "react";
import Link from "next/link";
import {ccc} from "@ckb-ccc/connector-react";
import {ADMIN_TIPPING_RELEASE} from "../../../contracts/admin-tipping/release-pins.mjs";
import {getDiscoveryReadClient} from "@/lib/revamp/discovery-read-client";
import {withProfileDeadline} from "@/lib/revamp/profile-model";
import {UPGRADE_OWNER} from "@/lib/revamp/testnet-permission-upgrade";
import {FINANCIAL_REVIEW_IDS,assertFinancialReviewUnchanged,exportAdminFinancialReview,prepareAdminFinancialReview,readAdminFinancialReview,validateFinancialReviewFile,type FinancialReviewId,type FinancialReviewSnapshot} from "@/lib/revamp/testnet-admin-financial-review";
import type {AdminFinancialBinaries,AdminFinancialCodePlan} from "@/lib/revamp/testnet-admin-financial-upgrade";
import {RevampButton} from "./ui";
import styles from "./testnet-setup-workspace.module.css";

type Upload={fileName:string;bytes:ccc.Hex|null;loading:boolean;error:string|null};
const labels:Record<FinancialReviewId,string>={tippingType:"Tipping Type",fundingLock:"Funding Lock",protocolLock:"QA Protocol Lock"};
const blank=():Upload=>({fileName:"",bytes:null,loading:false,error:null});
const amount=(raw:string)=>{const n=BigInt(raw),fraction=(n%100000000n).toString().padStart(8,"0").replace(/0+$/,"");return `${(n/100000000n).toLocaleString("en-US")}${fraction?"."+fraction:""} tCKB`;};
const message=(error:unknown)=>error instanceof Error?error.message:"The read-only review could not be completed.";
export function TestnetAdminFinancialUpgradeWorkspace(){
  const signer=ccc.useSigner(),{client:walletClient,signerInfo,open}=ccc.useCcc();
  const session=useRef({signer,walletClient,signerInfo});if(session.current.signer!==signer||session.current.walletClient!==walletClient||session.current.signerInfo!==signerInfo)session.current={signer,walletClient,signerInfo};
  const mounted=useRef(true),operation=useRef(0),busyRef=useRef(false),versions=useRef<Record<FinancialReviewId,number>>({tippingType:0,fundingLock:0,protocolLock:0});
  const [uploads,setUploads]=useState<Record<FinancialReviewId,Upload>>({tippingType:blank(),fundingLock:blank(),protocolLock:blank()}),[address,setAddress]=useState<ccc.Address|null>(null),[busy,setBusy]=useState(false),[phase,setPhase]=useState<string|null>(null),[error,setError]=useState<string|null>(null),[snapshot,setSnapshot]=useState<FinancialReviewSnapshot|null>(null),[prepared,setPrepared]=useState<{snapshot:FinancialReviewSnapshot;plan:AdminFinancialCodePlan}|null>(null);
  const reader=useMemo(()=>{try{return {client:getDiscoveryReadClient("testnet"),error:null};}catch(error){return {client:null,error:message(error)};}},[]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;operation.current++;};},[]);
  useEffect(()=>{let active=true;operation.current++;setAddress(null);setSnapshot(null);setPrepared(null);setError(null);if(signer)void withProfileDeadline(()=>signer.getRecommendedAddressObj(),undefined,12000).then(value=>{if(active)setAddress(value);},error=>{if(active)setError(message(error));});return()=>{active=false;};},[signer,walletClient,signerInfo]);
  async function choose(id:FinancialReviewId,file:File|undefined){
    const version=++versions.current[id];setPrepared(null);setUploads(previous=>({...previous,[id]:{fileName:file?.name??"",bytes:null,loading:Boolean(file),error:null}}));if(!file)return;
    try{if(file.size!==ADMIN_TIPPING_RELEASE.byteLengths[id])throw new Error(`Expected exactly ${ADMIN_TIPPING_RELEASE.byteLengths[id]} reviewed bytes.`);
      const bytes=await withProfileDeadline(async()=>new Uint8Array(await file.arrayBuffer()),undefined,12000),hex=validateFinancialReviewFile(id,bytes);
      if(mounted.current&&versions.current[id]===version)setUploads(previous=>({...previous,[id]:{fileName:file.name,bytes:hex,loading:false,error:null}}));
    }catch(error){if(mounted.current&&versions.current[id]===version)setUploads(previous=>({...previous,[id]:{fileName:file.name,bytes:null,loading:false,error:message(error)}}));}
  }
  async function run(kind:"read"|"prepare"|"export"){
    if(busyRef.current||!reader.client)return;busyRef.current=true;setBusy(true);setError(null);setPhase(kind==="read"?"Reading exact QA cells, canonical parents and both Registry confirmations…":kind==="prepare"?"Rechecking current QA inputs and calculating the unsigned code proposal…":"Rechecking every prepared input before exporting unsigned JSON…");
    const captured=session.current,id=++operation.current,current=()=>mounted.current&&session.current===captured&&operation.current===id;
    if(kind!=="export")setPrepared(null);
    try{
      const actual=signer?await withProfileDeadline(()=>signer.getRecommendedAddressObj(),undefined,12000):null;if(!current())return;
      const lock=walletClient.addressPrefix==="ckt"?actual?.script??null:null;
      if(kind!=="read"&&(!lock||!lock.eq(UPGRADE_OWNER)))throw new Error("Connect the exact Account 1 owner on CKB Testnet before preparing or exporting.");
      if(kind==="read"){const value=await readAdminFinancialReview(reader.client,lock,current);if(current())setSnapshot(value);}
      else if(kind==="prepare"){
        if(!FINANCIAL_REVIEW_IDS.every(name=>uploads[name].bytes&&!uploads[name].loading))throw new Error("Select and verify all three reviewed release files.");
        const binaries=Object.fromEntries(FINANCIAL_REVIEW_IDS.map(name=>[name,uploads[name].bytes!])) as AdminFinancialBinaries,value=await prepareAdminFinancialReview(reader.client,lock!,binaries,current);
        if(current()){setSnapshot(value.snapshot);setPrepared(value);}
      }else{
        if(!prepared)throw new Error("Prepare a current, fully funded unsigned proposal first.");
        const latest=await readAdminFinancialReview(reader.client,lock,current);assertFinancialReviewUnchanged(prepared.snapshot,latest,prepared.plan);if(!current())return;
        const still=await withProfileDeadline(()=>signer!.getRecommendedAddressObj(),undefined,12000);if(!current())return;if(!actual||!still.script.eq(actual.script))throw new Error("The account changed before export. Review again.");
        const value=exportAdminFinancialReview(prepared.plan,latest),url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:"application/json"})),link=document.createElement("a");link.href=url;link.download="ckboost-qa-admin-financial-unsigned-proposal.json";link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setSnapshot(latest);
      }
      if(signer){const after=await withProfileDeadline(()=>signer.getRecommendedAddressObj(),undefined,12000);if(!current())return;if(!actual||!after.script.eq(actual.script)){setSnapshot(null);setPrepared(null);throw new Error("The connected account changed. Review again.");}setAddress(after);}
    }catch(error){if(current()){setError(message(error));if(kind==="prepare")setPrepared(null);}}
    finally{busyRef.current=false;if(current()){setBusy(false);setPhase(null);}else if(mounted.current)setBusy(false);}
  }
  const allFiles=FINANCIAL_REVIEW_IDS.every(id=>uploads[id].bytes&&!uploads[id].loading),ownerMatches=Boolean(address&&walletClient.addressPrefix==="ckt"&&address.script.eq(UPGRADE_OWNER)),canPrepare=Boolean(ownerMatches&&allFiles&&snapshot?.registryConfirmed&&!snapshot.blockedReasons.length),plan=prepared?.plan;
  return <main id="revamp-main" className={styles.main}>
    <header className={styles.header}><div><p className={styles.eyebrow}>LOCAL REVIEW ONLY · DEDICATED CKB TESTNET QA</p><h1>Financial contract upgrade review</h1><p>Three code candidates. No signature, broadcast, deployment or runtime activation is available on this page.</p></div><RevampButton variant="secondary" onClick={()=>open()}>Open connected wallet</RevampButton></header>
    <div className={styles.notice}><strong>Deployment order</strong><ol className={styles.list}><li>Review and confirm the separate Registry code transaction.</li><li>Review and confirm its linked Registry state transaction.</li><li>Only then prepare this unsigned three-code proposal. A later separately authorized operator must revalidate it before signing.</li><li>Protocol configuration and activation follow actual code confirmation and an empty legacy financial namespace audit.</li></ol><Link href="/revamp/testnet-admin-upgrade" prefetch={false}>Open the separate Registry operator</Link></div>
    <section className={styles.panel}><h2>1. Scope and current public QA state</h2><dl className={styles.facts}><dt>Connected wallet</dt><dd className={styles.code}>{address?.toString()??"Not connected"}</dd><dt>Required owner</dt><dd>Account 1 · {ownerMatches?"Exact owner matched":"Not matched; preparation disabled"}</dd><dt>Protocol type hash</dt><dd className={styles.code}>{ADMIN_TIPPING_RELEASE.protocolTypeHash}</dd><dt>Required Registry</dt><dd className={styles.code}>{ADMIN_TIPPING_RELEASE.registryTypeHash}</dd></dl><RevampButton variant="secondary" loading={busy} onClick={()=>void run("read")}>Read current QA state</RevampButton>
      {snapshot&&<><dl className={styles.facts}><dt>Registry code</dt><dd>{snapshot.registryCode.status}</dd><dt>Registry state</dt><dd>{snapshot.registryState?.status??"Blocked until Registry code is confirmed"}</dd><dt>Verified Account 1 plain balance</dt><dd>{amount(snapshot.liveBalanceShannons)}</dd><dt>Three-code capacity increase</dt><dd>{amount(snapshot.capacityIncreaseShannons)}</dd><dt>Minimum wallet change</dt><dd>{amount(snapshot.minimumChangeShannons)}</dd><dt>Remaining Registry capacity + fees</dt><dd>{amount(snapshot.registryOutstandingShannons)}</dd><dt>Conservative fee allowance</dt><dd>{amount(snapshot.feeBudgetShannons)} · estimate, not the final fee</dd><dt>Estimated additional funding</dt><dd>{amount(snapshot.additionalCapacityEstimateShannons)} · includes remaining Registry steps and the fee allowance</dd></dl>{snapshot.blockedReasons.map(reason=><p key={reason} className={styles.notice}>{reason}</p>)}<details><summary>Verified current inputs</summary><p className={styles.code}>Protocol: {snapshot.protocolCell.outPoint.txHash}:{snapshot.protocolCell.outPoint.index.toString()}</p><p className={styles.code}>QA code: {snapshot.oldProtocolCode.outPoint.txHash}:{snapshot.oldProtocolCode.outPoint.index.toString()}</p><p>{snapshot.fundingCells.length} canonical, live, empty untyped Account 1 cells. Typed balances and other wallets are excluded.</p></details></>}
    </section>
    <section className={styles.panel}><h2>2. Manually select the reviewed files</h2><p className={styles.muted}>Refresh clears selected bytes and the unsigned draft. File names alone do not establish identity.</p>{FINANCIAL_REVIEW_IDS.map(id=><div className={styles.upload} key={id}><label><strong>{labels[id]}</strong><input aria-label={`Reviewed ${labels[id]} binary`} type="file" disabled={busy} onChange={event=>void choose(id,event.target.files?.[0])}/></label><span>{ADMIN_TIPPING_RELEASE.byteLengths[id].toLocaleString("en-US")} bytes</span><span className={styles.code}>{ADMIN_TIPPING_RELEASE.dataHashes[id]}</span>{uploads[id].loading&&<span role="status">Reading and validating…</span>}{uploads[id].bytes&&<span className={styles.success}>Verified: {uploads[id].fileName}</span>}{uploads[id].error&&<span role="alert" className={styles.error}>{uploads[id].error}</span>}</div>)}</section>
    <section className={styles.panel}><h2>3. Unsigned proposal</h2><p>Existing QA Protocol Lock keeps its TypeID and Account 1 owner. Tipping and Funding receive fresh native TypeIDs. Registry, protocol, campaign and user state are not inputs to this code proposal.</p>{!canPrepare&&<p className={styles.notice}>Preparation requires the exact owner, all three verified files and independently confirmed/live Registry code and state. No speculative transaction can be exported.</p>}<RevampButton disabled={!canPrepare||busy} loading={busy} onClick={()=>void run("prepare")}>Prepare unsigned code proposal</RevampButton>
      {plan&&<><dl className={styles.facts}><dt>Proposal status</dt><dd>{plan.status}</dd><dt>Actual calculated fee</dt><dd>{amount(plan.feeShannons)}</dd><dt>Additional capacity needed</dt><dd>{amount(plan.additionalCapacityShannons)}</dd><dt>Raw transaction hash</dt><dd className={styles.code}>{plan.transactionHash}</dd></dl><RevampButton variant="secondary" disabled={busy||plan.status!=="unsigned-prepared"} onClick={()=>void run("export")}>Recheck and export unsigned JSON</RevampButton></>}
    </section>{phase&&<p role="status" className={styles.notice}>{phase}</p>}{(error||reader.error)&&<p role="alert" className={styles.error}>{error??reader.error}</p>}
  </main>;
}
