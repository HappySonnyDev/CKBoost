"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CreationDateTimeField } from "./creation-schedule";
import { RevampButton, RevampInput, RevampSelect } from "./ui";
import { formatRewardAmount, newAdminRewardPeriodDraft, parseRewardAmount, validateAdminRewardPeriod, type AdminRewardPeriod, type AdminRewardPeriodDraft, type AdminRewardsAsset, type AdminRewardValidation } from "@/lib/revamp/admin-rewards-model";
import type { RewardsOperation, RewardsResource } from "./admin-rewards";
import styles from "./admin-rewards.module.css";

export interface AdminRewardPeriodFormProps {
  scopeKey:string;access:"checking"|"disconnected"|"denied"|"allowed"|"error";accessError:string|null;
  assets:RewardsResource<AdminRewardsAsset[]>;registryAvailable:boolean|null;registryUnavailableReason:string|null;registryLoading:boolean;registryError:string|null;
  operation:RewardsOperation;onSave:(period:AdminRewardPeriod)=>Promise<{transactionHash:string}>;onRetry:()=>void;onRetryConfiguration:()=>void;onConnect:()=>void;
}
export function AdminRewardPeriodForm(props:AdminRewardPeriodFormProps){
  const router=useRouter(),uid=useId(),form=useRef<HTMLFormElement>(null),periodId=useRef(""),currentScope=useRef(props.scopeKey);currentScope.current=props.scopeKey;
  const [draft,setDraft]=useState<AdminRewardPeriodDraft>(()=>newAdminRewardPeriodDraft()),[errors,setErrors]=useState<AdminRewardValidation>({}),[submitError,setSubmitError]=useState<string|null>(null);
  const busy=["preparing","signing","confirming"].includes(props.operation.phase);
  useEffect(()=>{periodId.current=`period-${Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,"0")).join("")}`;setDraft(newAdminRewardPeriodDraft());setErrors({});setSubmitError(null);},[props.scopeKey]);
  const assets=props.assets.data??[],asset=assets.find(item=>item.id===draft.assetId);
  const configurationPending=props.registryLoading||props.registryAvailable===null&&!props.registryError;
  const configurationReady=props.registryAvailable===true&&!props.registryLoading&&!props.registryError&&!props.assets.loading&&!props.assets.error;
  const configurationError=props.registryError??props.assets.error??(props.registryAvailable===false?props.registryUnavailableReason??"Reward period storage is not configured for this protocol.":null);
  function change<K extends keyof AdminRewardPeriodDraft>(key:K,value:AdminRewardPeriodDraft[K]){setDraft(old=>({...old,[key]:value}));setErrors(old=>{const next={...old};delete next[key];return next;});}
  function preview(index:number){try{if(!asset)return"—";const total=parseRewardAmount(draft.totalAmount,asset.decimals),share=parseRewardAmount(draft.shares[index],2);if(total*share%10000n)return"—";return`${formatRewardAmount(total*share/10000n,asset.decimals)} ${asset.symbol}`;}catch{return"—";}}
  async function submit(event:FormEvent){
    event.preventDefault();if(busy)return;const capturedScope=props.scopeKey;setSubmitError(null);
    if(!configurationReady){if(configurationError)setSubmitError(configurationError);return;}
    const result=await validateAdminRewardPeriod(draft,assets,periodId.current);
    if(currentScope.current!==capturedScope)return;
    setErrors(result.errors);
    if(!result.period){requestAnimationFrame(()=>form.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus());return;}
    try{await props.onSave(result.period);if(currentScope.current!==capturedScope)return;router.push(`/revamp/admin/rewards?${new URLSearchParams({tab:"leaderboard",period:result.period.id})}`);}catch(error){if(currentScope.current===capturedScope)setSubmitError(error instanceof Error?error.message:"The reward period could not be saved.");}
  }
  const error=(key:string)=>errors[key]?<p id={`${uid}-${key}-error`} className={styles.fieldError} role="alert">{errors[key]}</p>:null;
  const input=(key:"name"|"totalAmount"|"minimumPoints"|"minimumApprovedQuests",label:string,required=false)=><div className={styles.field}><label htmlFor={`${uid}-${key}`}>{label}{required&&<> <span className={styles.required}>*</span></>}</label><RevampInput id={`${uid}-${key}`} name={key} value={draft[key]} disabled={busy} inputMode={key==="name"?"text":"decimal"} aria-invalid={Boolean(errors[key])} aria-describedby={errors[key]?`${uid}-${key}-error`:undefined} onChange={event=>change(key,event.target.value)}/>{error(key)}</div>;
  return <main id="revamp-main" className={styles.formPage}>
    <nav className={styles.breadcrumbs} aria-label="Breadcrumb"><Link prefetch={false} href="/revamp/admin">Platform admin</Link><span aria-hidden="true">›</span><Link prefetch={false} href="/revamp/admin/rewards?tab=leaderboard">Rewards & Recognition</Link><span aria-hidden="true">›</span><span aria-current="page">New reward period</span></nav>
    <h1>New reward period</h1><p className={styles.formDescription}>Set the schedule, reward pool and distribution for a leaderboard period.</p>
    {props.access!=="allowed"?<section className={styles.notice} role="status"><p>{props.accessError??(props.access==="checking"?"Checking administrator access…":props.access==="disconnected"?"Connect your administrator wallet.":"Only current platform administrators can create reward periods.")}</p>{props.access==="disconnected"?<RevampButton onClick={props.onConnect}>Connect wallet</RevampButton>:props.access!=="checking"&&<button className={styles.retry} onClick={props.onRetry}>Retry access</button>}</section>:<form ref={form} className={styles.periodForm} onSubmit={event=>void submit(event)} noValidate>
      {(configurationPending||props.assets.loading||configurationError)&&<div className={styles.notice} role="status"><p>{configurationError??(configurationPending?"Checking reward period storage…":"Loading reward assets…")}</p><p>Your entries are kept while configuration loads or is retried. Nothing is saved until its transaction confirms.</p>{configurationError&&<button className={styles.retry} type="button" onClick={props.onRetryConfiguration}>Retry configuration</button>}</div>}
      <section className={styles.formBasics} aria-label="Period schedule and reward asset">{input("name","Period name",true)}
      <div className={styles.formRow}>{(["start","end"] as const).map(key=><div key={key} className={styles.field} role="group" aria-label={`${key==="start"?"Start":"End"} time`} aria-invalid={Boolean(errors[key])} aria-describedby={errors[key]?`${uid}-${key}-error`:undefined} data-invalid={Boolean(errors[key])}><label>{key==="start"?"Start time":"End time"} <span className={styles.required}>*</span></label><CreationDateTimeField label={key==="start"?"Start time":"End time"} value={draft[key]} timeZone={draft.timeZone} disabled={busy} onChange={value=>change(key,value)}/>{error(key)}</div>)}</div>
      <div className={styles.formRow}><div className={styles.field}><label>Reward asset</label><RevampSelect label="Reward asset" value={draft.assetId} disabled={busy||props.assets.loading} options={assets.map(item=>({value:item.id,label:item.symbol}))} onValueChange={value=>change("assetId",value)}/>{error("assetId")}</div>{input("totalAmount","Total prize pool",true)}</div></section>
      <section className={styles.distribution}><h2>Reward tiers</h2>
      <div className={styles.tableScroll}><table className={styles.formTiers}><thead><tr><th scope="col">Rank</th><th scope="col">Share</th><th scope="col">Reward</th></tr></thead><tbody>{["1st place","2nd place","3rd place","4th–10th, combined"].map((label,index)=><tr key={label}><td>{label}</td><td><div className={styles.shareField}><RevampInput aria-label={`${label} share (%)`} inputMode="decimal" value={draft.shares[index]} disabled={busy} aria-invalid={Boolean(errors[`share${index}`])} aria-describedby={errors[`share${index}`]?`${uid}-share${index}-error`:undefined} onChange={event=>{const shares=[...draft.shares] as AdminRewardPeriodDraft["shares"];shares[index]=event.target.value.replace(/%$/,"");change("shares",shares);setErrors(old=>{const next={...old};delete next[`share${index}`];return next;});}}/></div>{error(`share${index}`)}</td><td>{preview(index)}</td></tr>)}</tbody></table></div>{error("shares")}</section>
      <section className={styles.eligibility}><h2>Eligibility</h2><div className={styles.formRow}>{input("minimumPoints","Minimum points")}{input("minimumApprovedQuests","Approved quests")}</div><div className={styles.field}><label>Account verification</label><RevampSelect label="Account verification" value={draft.verification} disabled={busy} options={[{value:"none",label:"Not required"},{value:"telegram",label:"Required · Telegram verified"},{value:"manual",label:"Required · Manually verified"},{value:"any",label:"Required · Telegram or Manual"}]} onValueChange={value=>change("verification",value as AdminRewardPeriodDraft["verification"])}/>{error("verification")}</div></section>
      {(submitError||props.operation.error)&&<p className={styles.error} role="alert">{submitError??props.operation.error}</p>}
      {props.operation.transactionHash&&<p className={styles.scopeNote}>Transaction: <code>{props.operation.transactionHash}</code></p>}
      {busy&&<p className={styles.notice} role="status">{props.operation.phase==="confirming"?"Waiting for transaction confirmation…":"Confirm the reward period in your wallet. Your form will be kept if it fails."}</p>}
      <div className={styles.actions}><RevampButton variant="secondary" asChild><Link prefetch={false} href="/revamp/admin/rewards?tab=leaderboard" aria-disabled={busy} onClick={event=>{if(busy)event.preventDefault();}}>Cancel</Link></RevampButton><RevampButton type="submit" loading={busy} disabled={!configurationReady}>Add reward period</RevampButton></div>
    </form>}
  </main>;
}
