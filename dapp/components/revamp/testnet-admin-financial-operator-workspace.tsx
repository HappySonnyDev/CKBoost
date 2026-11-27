"use client";

import {useEffect,useMemo,useRef,useState} from "react";
import Link from "next/link";
import {ccc} from "@ckb-ccc/connector-react";
import {ADMIN_TIPPING_RELEASE} from "../../../contracts/admin-tipping/release-pins.mjs";
import {getDiscoveryReadClient} from "@/lib/revamp/discovery-read-client";
import {withProfileDeadline} from "@/lib/revamp/profile-model";
import {UPGRADE_OWNER} from "@/lib/revamp/testnet-permission-upgrade";
import {FINANCIAL_REVIEW_IDS,validateFinancialReviewFile,type FinancialReviewId} from "@/lib/revamp/testnet-admin-financial-review";
import {validateAdminFinancialBinaries} from "@/lib/revamp/testnet-admin-financial-upgrade";
import {prepareFinancialCodeStage,prepareFinancialProtocolStage,signFinancialStage,broadcastFinancialStage,confirmFinancialStage,readFinancialReceipt,type FinancialOperatorStage,type FinancialPrepared,type FinancialSignedReceipt} from "@/lib/revamp/testnet-admin-financial-operator";
import {RevampButton} from "./ui";
import styles from "./testnet-admin-financial-operator-workspace.module.css";

const stages=["codes","protocol"] as const;
const titles:Record<FinancialReviewId,string>={tippingType:"Tipping Type",fundingLock:"Funding Lock",protocolLock:"QA Protocol Lock"};
type Upload={fileName:string;bytes:ccc.Hex|null;loading:boolean;error:string|null};
type Confirmation=Awaited<ReturnType<typeof confirmFinancialStage>>;
const empty=():Upload=>({fileName:"",bytes:null,loading:false,error:null});
const RELEASE_MAX_BYTES=1100000;
async function readReviewedRelease(signal:AbortSignal){
  const response=await fetch("/qa/admin-financial-reviewed-release.json",{cache:"no-store",signal});
  if(!response.ok)throw new Error(`The reviewed release is unavailable (HTTP ${response.status}). Use the manual files or retry this read.`);
  const length=response.headers.get("content-length");
  if(length!==null&&(!/^\d+$/.test(length)||Number(length)>RELEASE_MAX_BYTES))throw new Error("The reviewed release exceeds its bounded download size.");
  if(!response.body)throw new Error("The reviewed release response has no readable body.");
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let total=0;
  try{for(;;){const {done,value}=await reader.read();if(signal.aborted)throw new Error("The reviewed release read was cancelled.");if(done)break;total+=value.byteLength;if(total>RELEASE_MAX_BYTES)throw new Error("The reviewed release exceeds its bounded download size.");chunks.push(value);}}
  finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
  const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  const payload:unknown=JSON.parse(new TextDecoder().decode(bytes));
  if(!payload||typeof payload!=="object"||Array.isArray(payload))throw new Error("Invalid reviewed release manifest.");
  const record=payload as Record<string,unknown>;
  if(record.schema!=="ckboost-qa-admin-financial-reviewed-release/v1"||record.releaseId!==ADMIN_TIPPING_RELEASE.releaseId||Object.keys(record).some(key=>!["schema","releaseId","binaries"].includes(key)))throw new Error("The release schema or source-pinned release ID does not match.");
  if(!record.binaries||typeof record.binaries!=="object"||Array.isArray(record.binaries))throw new Error("The reviewed release must contain all three pinned binaries.");
  const binaries=record.binaries as Record<string,unknown>;
  if(Object.keys(binaries).length!==FINANCIAL_REVIEW_IDS.length||FINANCIAL_REVIEW_IDS.some(id=>typeof binaries[id]!=="string"||!/^0x[0-9a-f]+$/.test(binaries[id] as string)))throw new Error("The reviewed release must contain exactly the three canonical hex binaries.");
  return validateAdminFinancialBinaries(binaries as Record<FinancialReviewId,ccc.Hex>);
}
const errorText=(cause:unknown)=>cause instanceof Error?cause.message:"The operation stopped. Inspect any saved receipt before another wallet action.";
const amount=(value:string)=>{const n=BigInt(value),fraction=(n%100000000n).toString().padStart(8,"0").replace(/0+$/,"");return `${(n/100000000n).toLocaleString("en-US")}${fraction?"."+fraction:""} tCKB`;};
function download(value:unknown,name:string){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:"application/json"})),link=document.createElement("a");link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}

/** A separate explicit click is required for every read, signature and send.
 * The helper owns fixed QA authorization, exact body validation and durable
 * receipt storage; this view never prepares/signs/sends on mount or refresh. */
export function TestnetAdminFinancialOperatorWorkspace(){
  const signer=ccc.useSigner(),{client:walletClient,signerInfo,open}=ccc.useCcc();
  const session=useRef({signer,walletClient,signerInfo});if(session.current.signer!==signer||session.current.walletClient!==walletClient||session.current.signerInfo!==signerInfo)session.current={signer,walletClient,signerInfo};
  const renderSession=session.current;
  const mounted=useRef(true),inFlight=useRef(false),reviewVersion=useRef(0),releaseRequest=useRef<AbortController|null>(null),fileVersions=useRef<Record<FinancialReviewId,number>>({tippingType:0,fundingLock:0,protocolLock:0});
  const [releaseLoading,setReleaseLoading]=useState(false),[releaseError,setReleaseError]=useState<string|null>(null);
  const [address,setAddress]=useState<ccc.Address|null>(null),[busy,setBusy]=useState(false),[activity,setActivity]=useState<string|null>(null),[error,setError]=useState<string|null>(null),[storageError,setStorageError]=useState<string|null>(null),[storageReady,setStorageReady]=useState(false);
  const [uploads,setUploads]=useState<Record<FinancialReviewId,Upload>>({tippingType:empty(),fundingLock:empty(),protocolLock:empty()});
  const [reviews,setReviews]=useState<Partial<Record<FinancialOperatorStage,FinancialPrepared>>>({}),[receipts,setReceipts]=useState<Partial<Record<FinancialOperatorStage,FinancialSignedReceipt>>>({}),[confirmations,setConfirmations]=useState<Partial<Record<FinancialOperatorStage,Confirmation>>>({});
  const publicReader=useMemo(()=>{try{return {client:getDiscoveryReadClient("testnet"),error:null};}catch(cause){return {client:null,error:errorText(cause)};}},[]);
  function restore(){
    const next:typeof receipts={},failures:string[]=[];
    for(const stage of stages){try{const saved=readFinancialReceipt(stage);if(saved)next[stage]=saved;}catch(cause){failures.push(`${stage}: ${errorText(cause)}`);}}
    if(mounted.current){setReceipts(next);setStorageReady(!failures.length);setStorageError(failures.length?failures.join("\n"):null);}return next;
  }
  useEffect(()=>{mounted.current=true;restore();return()=>{mounted.current=false;releaseRequest.current?.abort();};},[]);// eslint-disable-line react-hooks/exhaustive-deps
  useEffect(()=>{let active=true;const captured=session.current;setReviews({});setConfirmations({});setAddress(null);setError(null);
    if(signer)void withProfileDeadline(()=>signer.getRecommendedAddressObj(),undefined,12000).then(value=>{if(active&&session.current===captured)setAddress(value);},cause=>{if(active&&session.current===captured)setError(errorText(cause));});
    return()=>{active=false;};
  },[signer,walletClient,signerInfo]);
  const ownerMatches=Boolean(address&&signer?.client.addressPrefix==="ckt"&&walletClient.addressPrefix==="ckt"&&address.script.eq(UPGRADE_OWNER));
  const linkedCodeHash=receipts.protocol?.codeTransactionHash;
  const codeHash=receipts.codes?.transactionHash??linkedCodeHash??confirmations.codes?.transactionHash??reviews.codes?.transactionHash;
  const receiptConflict=Boolean(receipts.codes&&linkedCodeHash&&receipts.codes.transactionHash!==linkedCodeHash);
  const codesConfirmed=Boolean(codeHash&&confirmations.codes?.status==="confirmed"&&confirmations.codes.transactionHash===codeHash);
  const allFiles=FINANCIAL_REVIEW_IDS.every(id=>uploads[id].bytes&&!uploads[id].loading);
  async function run(label:string,task:(guard:()=>boolean)=>Promise<void>){
    if(inFlight.current||session.current!==renderSession)return;inFlight.current=true;setBusy(true);setActivity(label);setError(null);const captured=renderSession,guard=()=>mounted.current&&session.current===captured;
    try{await task(guard);}catch(cause){if(guard())setError(errorText(cause));}
    finally{inFlight.current=false;if(mounted.current){setBusy(false);setActivity(null);restore();}}
  }
  async function verifyOwner(guard:()=>boolean){
    if(!signer||!guard())throw new Error("The wallet or operation changed. No wallet action is allowed.");
    const actual=await withProfileDeadline(()=>signer.getRecommendedAddressObj(),undefined,12000);
    if(!guard())throw new Error("The wallet or operation changed. The old review was discarded.");setAddress(actual);
    if(signer.client.addressPrefix!=="ckt"||walletClient.addressPrefix!=="ckt"||!actual.script.eq(UPGRADE_OWNER)){setReviews({});throw new Error("Connect the exact Account 1 owner on CKB Testnet. Other accounts cannot sign or broadcast this upgrade.");}
  }
  async function choose(id:FinancialReviewId,file:File|undefined){
    reviewVersion.current++;const interrupted=Boolean(releaseRequest.current);releaseRequest.current?.abort();releaseRequest.current=null;setReleaseLoading(false);setReleaseError(null);
    if(interrupted)for(const key of FINANCIAL_REVIEW_IDS)fileVersions.current[key]++;
    const version=++fileVersions.current[id];setReviews({});setError(null);setUploads(previous=>({...Object.fromEntries(FINANCIAL_REVIEW_IDS.map(key=>[key,interrupted?empty():previous[key]])) as typeof previous,[id]:{fileName:file?.name??"",bytes:null,loading:Boolean(file),error:null}}));if(!file)return;
    try{
      if(file.size!==ADMIN_TIPPING_RELEASE.byteLengths[id])throw new Error(`Expected exactly ${ADMIN_TIPPING_RELEASE.byteLengths[id]} reviewed bytes.`);
      const bytes=await withProfileDeadline(async()=>new Uint8Array(await file.arrayBuffer()),undefined,12000),validated=validateFinancialReviewFile(id,bytes);
      if(mounted.current&&fileVersions.current[id]===version)setUploads(previous=>({...previous,[id]:{fileName:file.name,bytes:validated,loading:false,error:null}}));
    }catch(cause){if(mounted.current&&fileVersions.current[id]===version)setUploads(previous=>({...previous,[id]:{fileName:file.name,bytes:null,loading:false,error:errorText(cause)}}));}
  }
  async function loadReviewed(){
    if(inFlight.current)return;
    try{if(readFinancialReceipt("codes"))return;}catch(cause){setStorageReady(false);setStorageError(errorText(cause));return;}
    const version=++reviewVersion.current;for(const id of FINANCIAL_REVIEW_IDS)fileVersions.current[id]++;
    releaseRequest.current?.abort();const controller=new AbortController();releaseRequest.current=controller;setReleaseLoading(true);setReleaseError(null);setError(null);setReviews({});setUploads(Object.fromEntries(FINANCIAL_REVIEW_IDS.map(id=>[id,{...empty(),loading:true}])) as typeof uploads);
    try{const binaries=await withProfileDeadline(readReviewedRelease,controller.signal,12000);if(mounted.current&&reviewVersion.current===version)setUploads(Object.fromEntries(FINANCIAL_REVIEW_IDS.map(id=>[id,{fileName:`Reviewed release · ${titles[id]}`,bytes:binaries[id],loading:false,error:null}])) as typeof uploads);}
    catch(cause){if(mounted.current&&reviewVersion.current===version){setUploads(Object.fromEntries(FINANCIAL_REVIEW_IDS.map(id=>[id,empty()])) as typeof uploads);setReleaseError(errorText(cause));}}
    finally{if(releaseRequest.current===controller)releaseRequest.current=null;if(mounted.current&&reviewVersion.current===version)setReleaseLoading(false);}
  }
  const review=(stage:FinancialOperatorStage)=>{const version=reviewVersion.current;return run("Reading current QA cells and preparing the unsigned review…",async sessionGuard=>{const guard=()=>sessionGuard()&&reviewVersion.current===version;
    if(!storageReady||receiptConflict)throw new Error("Receipt storage must be consistent before a new review.");
    const saved=readFinancialReceipt(stage);if(saved){restore();throw new Error("A signed transaction is already saved for this stage. Restore it and check confirmation; do not prepare another body.");}
    await verifyOwner(guard);
    let prepared:FinancialPrepared;
    if(stage==="codes"){
      if(linkedCodeHash)throw new Error("A saved protocol receipt already references a code batch. Check that hash; do not prepare another deployment.");
      if(!allFiles)throw new Error("Select and verify all three pinned release files.");
      const binaries=Object.fromEntries(FINANCIAL_REVIEW_IDS.map(id=>[id,uploads[id].bytes!])) as Record<FinancialReviewId,ccc.Hex>;
      prepared=await prepareFinancialCodeStage(signer!,binaries,guard);
    }else{
      if(!codesConfirmed||!codeHash)throw new Error("Independently confirm the actual code batch before preparing the protocol update.");
      prepared=await prepareFinancialProtocolStage(signer!,codeHash,guard);
    }
    await verifyOwner(guard);if(prepared.stage!==stage||stage==="protocol"&&prepared.codeTransactionHash!==codeHash)throw new Error("The prepared stage or referenced code batch does not match this review.");if(guard())setReviews(previous=>({...previous,[stage]:prepared}));
  });};
  const sign=(stage:FinancialOperatorStage)=>{const version=reviewVersion.current;return run("Waiting for the explicit wallet signature. This action only saves the signed transaction…",async sessionGuard=>{const guard=()=>sessionGuard()&&reviewVersion.current===version;
    const prepared=reviews[stage];if(!prepared||!storageReady||receiptConflict)throw new Error("Review this stage with the current wallet first.");
    if(readFinancialReceipt(stage)){restore();throw new Error("A signed or attempted transaction already exists. Check its saved hash; do not sign again.");}
    await verifyOwner(guard);const receipt=await signFinancialStage(signer!,prepared,guard);
    if(receipt.stage!==stage||receipt.transactionHash!==prepared.transactionHash)throw new Error("The saved signature does not match the reviewed stage. Inspect the retained receipt; do not sign another body.");
    if(guard()){setReceipts(previous=>({...previous,[stage]:receipt}));setReviews(previous=>({...previous,[stage]:undefined}));}
  });};
  const broadcast=(stage:FinancialOperatorStage)=>run("Verifying the saved body and submitting it once. A lost acknowledgement must be checked, never resent…",async guard=>{
    const saved=readFinancialReceipt(stage);
    if(!storageReady||receiptConflict||!saved||saved.phase!=="signed")throw new Error("Only a saved, never-attempted signed transaction may be broadcast. Check any existing attempt.");
    if(stage==="protocol"&&!codesConfirmed)throw new Error("Check the referenced code batch confirmation before broadcasting the saved protocol update.");
    await verifyOwner(guard);const receipt=await broadcastFinancialStage(signer!,stage,guard);if(guard()){setReceipts(previous=>({...previous,[stage]:receipt}));setReviews(previous=>({...previous,[stage]:undefined}));}
  });
  const check=(stage:FinancialOperatorStage)=>run("Checking the actual public transaction and current live state. No signature or send is requested…",async guard=>{
    if(!publicReader.client)throw new Error(publicReader.error??"Public Testnet reads are unavailable.");
    const saved=readFinancialReceipt(stage),hash=saved?.transactionHash??confirmations[stage]?.transactionHash??reviews[stage]?.transactionHash??(stage==="codes"?linkedCodeHash:undefined);
    if(!hash)throw new Error("No known reviewed or saved transaction hash is available for this stage. Do not create a duplicate.");
    const result=await confirmFinancialStage(publicReader.client,stage,hash,guard);
    if(result.stage!==stage||result.transactionHash!==hash)throw new Error("The confirmation result belongs to another transaction or stage.");
    if(guard()){setConfirmations(previous=>({...previous,[stage]:result}));if(result.status==="confirmed")setReviews(previous=>({...previous,[stage]:undefined}));}
  });
  return <main id="revamp-main" className={styles.workspace}>
    <p className={styles.eyebrow}>ISOLATED CKB TESTNET · ACCOUNT 1 · EXPLICIT TWO-STAGE OPERATOR</p>
    <h1>Sign the reviewed financial upgrade</h1>
    <p>Each stage requires separate actions: read the unsigned review, sign and save, verify and broadcast once, then check confirmation.</p>
    <p className={styles.notice}>This tool does not activate a runtime, edit a profile, grant roles, or migrate legacy records. Only the dedicated QA code batch and its exact protocol configuration update are supported.</p>
    <section className={styles.card}><h2>Fixed QA scope</h2><dl><dt>Protocol</dt><dd><code>{ADMIN_TIPPING_RELEASE.protocolTypeHash}</code></dd><dt>Required Registry</dt><dd><code>{ADMIN_TIPPING_RELEASE.registryTypeHash}</code></dd><dt>Reviewed release</dt><dd>{ADMIN_TIPPING_RELEASE.releaseId}</dd><dt>Connected wallet</dt><dd><code>{address?.toString()??"No wallet connected"}</code></dd><dt>Account 1 ownership</dt><dd>{ownerMatches?"Exact Testnet owner matched":"Not matched · wallet actions disabled"}</dd></dl><RevampButton variant="secondary" disabled={busy} onClick={()=>open()}>Open connected wallet</RevampButton><p><Link href="/revamp/testnet-admin-financial-upgrade" prefetch={false}>Read-only financial review</Link> · <Link href="/revamp/testnet-admin-upgrade" prefetch={false}>Registry two-stage operator</Link></p></section>
    <section className={styles.card}><h2>Reviewed code files</h2><p>Explicitly load the public reviewed release or manually select its three files. Both paths check the source-pinned size, data hash and RISC-V ELF. Refresh clears unsigned reviews and selected files; saved signed receipts are retained.</p><RevampButton variant="secondary" disabled={busy||releaseLoading||Boolean(receipts.codes)||!storageReady} onClick={()=>void loadReviewed()}>Load reviewed releases · no signing</RevampButton>{releaseLoading&&<p role="status">Loading the reviewed release · no wallet action…</p>}{releaseError&&<p role="alert" className={styles.error}>{releaseError}</p>}<p>Or manually select files:</p><div className={styles.files}>{FINANCIAL_REVIEW_IDS.map(id=><div className={styles.upload} key={id}><label><strong>{titles[id]}</strong><input aria-label={`Reviewed ${titles[id]} binary`} type="file" disabled={busy||Boolean(receipts.codes)} onChange={event=>void choose(id,event.target.files?.[0])}/></label><span>{ADMIN_TIPPING_RELEASE.byteLengths[id].toLocaleString("en-US")} bytes</span><code>{ADMIN_TIPPING_RELEASE.dataHashes[id]}</code>{uploads[id].loading&&<span role="status">Reading and validating…</span>}{uploads[id].bytes&&<span className={styles.success}>Verified: {uploads[id].fileName}{uploads[id].fileName.startsWith("Reviewed release ·")?" · no manual file selection needed":""}</span>}{uploads[id].error&&<span role="alert" className={styles.error}>{uploads[id].error}</span>}</div>)}</div></section>
    {stages.map(stage=>{
      const prepared=reviews[stage],receipt=receipts[stage],confirmation=confirmations[stage],confirmed=confirmation?.status==="confirmed",enabled=stage==="codes"||codesConfirmed,knownHash=receipt?.transactionHash??confirmation?.transactionHash??prepared?.transactionHash??(stage==="codes"?linkedCodeHash:undefined),canWrite=ownerMatches&&storageReady&&!receiptConflict&&!busy&&enabled&&Boolean(publicReader.client);
      return <section className={styles.card} key={stage} aria-label={`${stage} financial stage`}><h2>{stage==="codes"?"1. Three-code deployment and QA lock upgrade":"2. QA protocol configuration update"}</h2>
        <p>{stage==="codes"?"Requires both Registry stages confirmed/live. The dedicated QA Protocol Lock keeps its TypeID and owner; Tipping and Funding get fresh TypeIDs. Only plain Account 1 capacity funds this batch.":"Unavailable until the actual code batch is independently confirmed. Only the reviewed financial code configuration and update timestamp may change; existing protocol, campaigns, users, Points and claimable pools retain their identities."}</p>
        {stage==="protocol"&&!codesConfirmed&&<p className={styles.notice}>Check the actual referenced code batch before reviewing, signing or broadcasting this stage.</p>}
        {knownHash&&<p className={styles.hash}>Transaction hash: <code>{knownHash}</code></p>}
        {prepared&&!receipt&&<dl><dt>Unsigned review</dt><dd>No signature or broadcast has occurred.</dd><dt>Prepared fee</dt><dd>{amount(prepared.feeShannons)}</dd><dt>Additional code capacity</dt><dd>{amount(prepared.capacityIncreaseShannons)}</dd><dt>Protocol input</dt><dd><code>{prepared.protocolBefore.outPoint.txHash}:{String(prepared.protocolBefore.outPoint.index)}</code></dd><dt>Protocol data hash</dt><dd><code>{prepared.protocolBefore.dataHash}</code></dd>{prepared.codeTransactionHash&&<><dt>Confirmed code batch</dt><dd><code>{prepared.codeTransactionHash}</code></dd></>}</dl>}
        {confirmed?<p className={styles.success} role="status">{confirmation.message}</p>:<>
          {!receipt&&stage==="codes"&&linkedCodeHash&&<p className={styles.notice}>The saved protocol receipt already references this code batch. Check its confirmation; do not prepare or sign another deployment.</p>}
          {!receipt&&(stage!=="codes"||!linkedCodeHash)&&<div className={styles.actions}><RevampButton variant="secondary" disabled={!canWrite||stage==="codes"&&!allFiles} onClick={()=>void review(stage)}>Review {stage} stage · reads only</RevampButton>{prepared&&<RevampButton disabled={!canWrite} onClick={()=>void sign(stage)}>Sign {stage} transaction · save only</RevampButton>}</div>}
          {receipt?.phase==="signed"&&<><p>Signed transaction saved for fixed Account 1. This tool has not recorded a broadcast attempt.</p><RevampButton disabled={!canWrite} onClick={()=>void broadcast(stage)}>Verify &amp; broadcast {stage} once</RevampButton></>}
          {receipt?.phase==="broadcast-attempted"&&<p className={styles.notice}>A broadcast attempt is saved. Do not sign or send another body. A pending, unknown or rejected result remains available for inspection and confirmation.</p>}
        </>}
        <div className={styles.actions}><RevampButton variant="secondary" disabled={busy||!knownHash||!publicReader.client} onClick={()=>void check(stage)}>Check {stage} confirmation · no signing</RevampButton>{receipt&&<RevampButton variant="secondary" disabled={busy} onClick={()=>download(receipt,`ckboost-qa-financial-${stage}-signed-receipt.json`)}>Export saved public signed receipt</RevampButton>}</div>
        {confirmation&&confirmation.status!=="confirmed"&&<p role="status">{confirmation.status}: {confirmation.message}</p>}
      </section>;
    })}
    <section className={styles.card}><h2>After confirmation</h2><p>Use the QA Admin CLI to verify the committed code identities, Registry and exact protocol delta, then generate and review a separate QA runtime configuration. This page never activates that configuration.</p><p>Saved receipts always belong to fixed Account 1. Viewing them with another connected wallet grants no signing or spending permission. Do not delete receipts to prepare another copy.</p></section>
    {busy&&<p className={styles.notice} role="status">{activity}</p>}{(error||storageError||publicReader.error||receiptConflict)&&<p role="alert" className={styles.error}>{error??storageError??publicReader.error??"Saved stages reference different code batches. Writes are blocked; inspect and check the existing receipts."}</p>}
  </main>;
}
