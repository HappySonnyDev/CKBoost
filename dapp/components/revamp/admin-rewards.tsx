"use client";

import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import * as Dialog from "@radix-ui/react-dialog";
import { RevampButton, RevampInput } from "./ui";
import { useRevampTheme } from "./theme";
import { ContributorRichText } from "./contributor-rich-text";
import { formatCampaignSchedule } from "@/lib/revamp/campaign-discovery";
import { formatRewardAmount, periodStatus, type AdminAchievement, type AdminAchievementClaim, type AdminRewardPeriod } from "@/lib/revamp/admin-rewards-model";
import type { AdminClaimProvenance } from "@/lib/revamp/admin-rewards-provenance";
import styles from "./admin-rewards.module.css";

export interface RewardsResource<T> {data:T|null;loading:boolean;error:string|null}
export interface RewardsOperation {phase:"idle"|"preparing"|"signing"|"confirming"|"confirmed"|"error";transactionHash:string|null;error:string|null}
export interface AdminRewardsProps {
  scopeKey:string;access:"checking"|"disconnected"|"denied"|"allowed"|"error";accessError:string|null;
  tab:"achievements"|"leaderboard";achievement:AdminAchievement|null;period:AdminRewardPeriod|null;
  achievements:RewardsResource<AdminAchievement[]>;periods:RewardsResource<AdminRewardPeriod[]>;
  registryAvailable:boolean|null;registryUnavailableReason:string|null;
  metadata:RewardsResource<string>;provenance:RewardsResource<AdminClaimProvenance>;
  users:RewardsResource<Map<string,{name:string|null;address:string;lockHash:string}>>;currentLockHash:string|null;network:"mainnet"|"testnet";
  bonusDays:string;bonusPoints:string;bonusOperation:RewardsOperation;
  onSaveBonus:(days:string,points:string)=>Promise<void>;
  onConnect:()=>void;onRetryAccess:()=>void;onRetryAchievements:()=>void;onRetryPeriods:()=>void;onRetryMetadata:()=>void;onRetryProvenance:()=>void;
}
function Icon({file,close=false}:{file:string;close?:boolean}){return <span aria-hidden="true" className={styles.icon} style={{"--rewards-icon":`url('/assets/revamp/${file}.svg')`,...(close?{width:24,height:24}:{})} as CSSProperties}/>;}
function short(value:string){return value.length>16?`${value.slice(0,8)}…${value.slice(-6)}`:value;}
function href(tab:"achievements"|"leaderboard",id?:string){const params=new URLSearchParams({tab});if(id)params.set(tab==="achievements"?"achievement":"period",id);return`/revamp/admin/rewards?${params}`;}
function date(value:number|null,mounted:boolean){return value==null?"—":mounted?formatCampaignSchedule(value):"Loading local time…";}
function Notice({resource,retry}:{resource:{loading:boolean;error:string|null};retry?:()=>void}){return resource.error?<div className={styles.error} role="alert"><p>{resource.error}</p>{retry&&<button className={styles.retry} onClick={retry}>Retry</button>}</div>:resource.loading?<p className={styles.notice} role="status">Loading…</p>:null;}
function Sort({label,active,direction,onClick}:{label:string;active:boolean;direction:"ascending"|"descending";onClick:()=>void}){return <button type="button" className={styles.sort} aria-pressed={active} data-direction={direction} onClick={onClick}>{label}<span className={styles.sortIcon} aria-hidden="true"/></button>;}

export function ActivityBonusDialog({open,onOpenChange,days:initialDays,points:initialPoints,operation,onSave,scopeKey}:{open:boolean;onOpenChange:(open:boolean)=>void;days:string;points:string;operation:RewardsOperation;onSave:(days:string,points:string)=>Promise<void>;scopeKey:string}){
  const {portalContainer}=useRevampTheme(),[days,setDays]=useState(initialDays),[points,setPoints]=useState(initialPoints),[validation,setValidation]=useState<string|null>(null);
  const busy=["preparing","signing","confirming"].includes(operation.phase),id=useId();
  useEffect(()=>{if(open){setDays(initialDays);setPoints(initialPoints);setValidation(null);}},[open,scopeKey]);
  async function save(){setValidation(null);try{await onSave(days,points);}catch(error){setValidation(error instanceof Error?error.message:"The bonus could not be saved.");}}
  return <Dialog.Root open={open} onOpenChange={next=>{if(!busy)onOpenChange(next);}}><Dialog.Portal container={portalContainer??undefined}><Dialog.Overlay className={styles.overlay}/><Dialog.Content className={styles.dialog} onEscapeKeyDown={event=>{if(busy)event.preventDefault();}} onPointerDownOutside={event=>{if(busy)event.preventDefault();}}>
    <div><div className={styles.dialogTitleRow}><Dialog.Title>Activity bonus settings</Dialog.Title><Dialog.Close className={styles.close} disabled={busy} aria-label="Close activity bonus settings"><Icon file="admin-rewards-close" close/></Dialog.Close></div><Dialog.Description className={styles.dialogDescription}>Set the interval between qualifying rewards and the points awarded for an activity bonus.</Dialog.Description></div>
    <div className={styles.field}><label htmlFor={`${id}-days`}>Days between bonuses <span className={styles.required}>*</span></label><RevampInput id={`${id}-days`} inputMode="numeric" value={days} disabled={busy} onChange={event=>setDays(event.target.value)}/></div>
    <div className={styles.field}><label htmlFor={`${id}-points`}>Bonus points <span className={styles.required}>*</span></label><RevampInput id={`${id}-points`} inputMode="numeric" value={points} disabled={busy} onChange={event=>setPoints(event.target.value)}/></div>
    {(validation||operation.error)&&<div role="alert" className={styles.error}>{validation||operation.error}</div>}
    {operation.phase==="confirming"&&<p role="status" className={styles.notice}>Transaction submitted. Waiting for confirmation.</p>}
    {operation.transactionHash&&<p className={styles.scopeNote}>Transaction: <code>{operation.transactionHash}</code></p>}
    {operation.phase==="confirmed"&&<p role="status" className={styles.notice}>Activity bonus saved and confirmed.</p>}
    <div className={styles.actions}><RevampButton loading={busy} onClick={()=>void save()}>{operation.phase==="confirming"?"Confirming…":operation.phase==="preparing"?"Preparing…":operation.phase==="signing"?"Check wallet":operation.phase==="error"&&operation.transactionHash?"Check transaction":"Save"}</RevampButton></div>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

export function AdminRewards(props:AdminRewardsProps){
  const [settingsOpen,setSettingsOpen]=useState(false),[mounted,setMounted]=useState(false),[now,setNow]=useState(0),[copied,setCopied]=useState<string|null>(null),[copyError,setCopyError]=useState<string|null>(null);
  const [registrySort,setRegistrySort]=useState<{key:"name"|"count"|null;direction:"ascending"|"descending"}>({key:null,direction:"ascending"});
  const [claimSort,setClaimSort]=useState<{key:"user"|"date";direction:"ascending"|"descending"}>({key:"date",direction:"descending"});
  const scope=useRef(props.scopeKey);scope.current=props.scopeKey;
  useEffect(()=>{setMounted(true);setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),60_000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{setSettingsOpen(false);setCopied(null);setCopyError(null);},[props.scopeKey]);
  const ready=props.access==="allowed",achievement=ready?props.achievement:null,period=ready?props.period:null;
  const badges=[...(props.achievements.data??[])].sort((a,b)=>{if(!registrySort.key)return 0;const value=registrySort.key==="count"?a.claims.length-b.claims.length:a.title.localeCompare(b.title);return(registrySort.direction==="ascending"?value:-value)||a.id.localeCompare(b.id);});
  const periods=[...(props.periods.data??[])].sort((a,b)=>b.startAtMs-a.startAtMs||a.id.localeCompare(b.id));
  const enrich=(claim:AdminAchievementClaim)=>({...claim,...props.users.data?.get(claim.receiverTypeHash)});
  const claims=achievement?[...achievement.claims].map(enrich).sort((a,b)=>{const value=claimSort.key==="user"?(a.name??a.address??a.receiverTypeHash).localeCompare(b.name??b.address??b.receiverTypeHash):(a.grantedAt??0)-(b.grantedAt??0);return(claimSort.direction==="ascending"?value:-value)||a.id.localeCompare(b.id);}):[];
  async function copy(hash:string){const captured=props.scopeKey;setCopyError(null);try{await navigator.clipboard.writeText(hash);if(scope.current===captured)setCopied(hash);}catch{if(scope.current===captured)setCopyError("The transaction ID could not be copied.");}}
  if(!ready)return <section className={styles.emptyRegistry}><div><h2>{props.access==="disconnected"?"Connect your administrator wallet":props.access==="checking"?"Checking administrator access…":props.access==="denied"?"Platform administrator access required":"Administrator access unavailable"}</h2><p>{props.accessError}</p>{props.access==="disconnected"?<RevampButton onClick={props.onConnect}>Connect wallet</RevampButton>:props.access!=="checking"&&<RevampButton variant="secondary" onClick={props.onRetryAccess}>Retry access</RevampButton>}</div></section>;
  return <div className={styles.content}>
    <div className={styles.toolbar}><nav className={styles.segmented} aria-label="Recognition categories"><Link prefetch={false} href={href("achievements")} aria-current={props.tab==="achievements"?"page":undefined}>Achievements ({props.achievements.data?badges.length:"—"})</Link><Link prefetch={false} href={href("leaderboard")} aria-current={props.tab==="leaderboard"?"page":undefined}>Leaderboard ({props.registryAvailable&&props.periods.data?periods.length:"—"})</Link></nav><div className={styles.toolbarActions}>{props.tab==="leaderboard"&&<RevampButton asChild><Link prefetch={false} href="/revamp/admin/rewards/new">New reward period</Link></RevampButton>}<button className={styles.settings} type="button" aria-label="Activity bonus settings" onClick={()=>setSettingsOpen(true)}><Icon file="admin-rewards-settings"/></button></div></div>
    {props.tab==="achievements"?<>
      <Notice resource={props.achievements} retry={props.onRetryAchievements}/>
      {props.achievements.data&&!badges.length?<section className={styles.emptyRegistry}><h2>No achievements yet</h2></section>:badges.length>0&&<div className={styles.workspace}>
        <aside className={styles.registry} aria-label="Published achievement registry"><table className={styles.registryTable}><thead><tr><th scope="col"><Sort label="Achievement" active={registrySort.key==="name"} direction={registrySort.direction} onClick={()=>setRegistrySort(previous=>({key:"name",direction:previous.key==="name"&&previous.direction==="ascending"?"descending":"ascending"}))}/></th><th scope="col"><Sort label="Claims" active={registrySort.key==="count"} direction={registrySort.direction} onClick={()=>setRegistrySort(previous=>({key:"count",direction:previous.key==="count"&&previous.direction==="ascending"?"descending":"ascending"}))}/></th></tr></thead><tbody>{badges.map(badge=><tr key={badge.id} data-selected={achievement?.id===badge.id}><td><Link prefetch={false} href={href("achievements",badge.id)} aria-current={achievement?.id===badge.id?"true":undefined}>{badge.title}</Link></td><td>{badge.claims.length}</td></tr>)}</tbody></table></aside>
        <section className={styles.detail} aria-label="Published achievement details">{achievement?<>
          <div className={styles.badgeHeading} data-compact={achievement.classification==="first-submission"}>{achievement.classification!=="other"&&<img src={`/assets/revamp/profile-${achievement.classification==="telegram-verification"?"telegram":"first-submission"}-80.svg`} width={achievement.classification==="first-submission"?64:80} height={achievement.classification==="first-submission"?64:80} alt=""/>}<h2>{achievement.title}</h2></div>
          <div className={styles.section}><h3>Description</h3><Notice resource={props.metadata} retry={props.onRetryMetadata}/>{props.metadata.data?<div className={styles.description}><ContributorRichText content={props.metadata.data}/></div>:!props.metadata.loading&&!props.metadata.error&&<p>Description unavailable.</p>}</div>
          <div className={styles.section}><h3>Recorded claims ({achievement.claims.length})</h3><p className={styles.caption}>{achievement.claims.length?"Eligible users claim achievements from their dashboard.":"Claims appear here after eligible users claim this achievement."}</p>
            {claims.length>0&&<><Notice resource={props.provenance} retry={props.onRetryProvenance}/>{props.provenance.data?.unavailableReason&&<p className={styles.scopeNote}>{props.provenance.data.unavailableReason}</p>}{props.users.error&&<p className={styles.scopeNote}>Some profile names and wallets could not be loaded. Receiver identities remain available.</p>}
              <div className={styles.tableScroll}><table className={styles.claims}><thead><tr><th scope="col"><Sort label="User" active={claimSort.key==="user"} direction={claimSort.direction} onClick={()=>setClaimSort(previous=>({key:"user",direction:previous.key==="user"&&previous.direction==="ascending"?"descending":"ascending"}))}/></th><th scope="col"><Sort label="Claimed (local)" active={claimSort.key==="date"} direction={claimSort.direction} onClick={()=>setClaimSort(previous=>({key:"date",direction:previous.key==="date"&&previous.direction==="ascending"?"descending":"ascending"}))}/></th><th scope="col">Claim transaction ID</th></tr></thead><tbody>{claims.map(claim=>{const proof=props.provenance.data?.proofs.get(claim.id),name=claim.name??(claim.address?short(claim.address):short(claim.receiverTypeHash));return <tr key={claim.id}><td><div className={styles.user}><span className={styles.avatar} aria-hidden="true">{claim.name?claim.name.split(/\s+/).slice(0,2).map(part=>part[0]).join("").toUpperCase():"?"}</span><span className={styles.userText}><span><strong>{name}</strong>{claim.lockHash&&claim.lockHash.toLowerCase()===props.currentLockHash?.toLowerCase()&&<span className={styles.you}>You</span>}</span><small title={claim.address??claim.receiverTypeHash}>{short(claim.address??claim.receiverTypeHash)}</small></span></div></td><td title={date(claim.grantedAt,mounted)}>{date(claim.grantedAt,mounted)}</td><td>{proof?<span className={styles.transaction}><code title={proof.transactionHash}>{short(proof.transactionHash)}</code><button className={styles.iconButton} aria-label={`Copy claim transaction ID for ${name}`} onClick={()=>void copy(proof.transactionHash)}><Icon file="creation-copy"/></button><a className={styles.iconButton} href={`https://${props.network==="testnet"?"testnet.":""}explorer.nervos.org/transaction/${proof.transactionHash}`} target="_blank" rel="noopener noreferrer" aria-label={`View claim transaction for ${name} on explorer`}><Icon file="admin-rewards-external"/></a></span>:<span title="The confirmed claim transaction has not been proven.">—</span>}</td></tr>;})}</tbody></table></div>
            </>}
          </div>
        </>:<p className={styles.notice}>The selected published achievement is unavailable.</p>}</section>
      </div>}
    </>:<>
      <Notice resource={props.periods} retry={props.onRetryPeriods}/>
      {props.registryAvailable===false&&<div className={styles.notice} role="status"><p>{props.registryUnavailableReason??"Reward periods are not available in this environment yet."}</p><button type="button" className={styles.retry} onClick={props.onRetryPeriods}>Retry reward periods</button></div>}
      {props.registryAvailable&&props.periods.data&&!periods.length?<section className={styles.emptyRegistry}><h2>No reward periods yet</h2></section>:props.registryAvailable&&periods.length>0&&<div className={styles.workspace}>
        <aside className={styles.registry} aria-label="Leaderboard reward periods"><table className={styles.registryTable}><thead><tr><th scope="col">Reward period</th><th scope="col">Pool</th><th scope="col">Status</th></tr></thead><tbody>{periods.map(item=><tr key={item.id} data-selected={period?.id===item.id}><td><Link prefetch={false} href={href("leaderboard",item.id)}>{item.name}</Link></td><td>{formatRewardAmount(item.totalAmount,item.asset.decimals)} {item.asset.symbol}</td><td><span className={styles.periodStatus} data-status={mounted?periodStatus(item,now):undefined}>{mounted?periodStatus(item,now):"—"}</span></td></tr>)}</tbody></table></aside>
        <section className={styles.detail} aria-label="Reward period details">{period?<>
          <div className={styles.periodHeading}><h2>{period.name}</h2><span className={styles.periodStatus} data-status={mounted?periodStatus(period,now):undefined}>{mounted?periodStatus(period,now):"—"}</span></div>
          <div className={styles.section}><h3>Schedule (local time)</h3><p className={styles.caption}>{date(period.startAtMs,mounted)} – {date(period.endAtMs,mounted)}</p></div>
          <div className={styles.section}><h3>Total rewards</h3><p className={styles.prize}>{formatRewardAmount(period.totalAmount,period.asset.decimals)} {period.asset.symbol}</p></div>
          <div className={`${styles.section} ${styles.allocation}`}><h3>Reward allocation</h3><table className={styles.tiers}><thead><tr><th scope="col">Rank</th><th scope="col">Share</th><th scope="col">Reward</th></tr></thead><tbody>{period.tiers.map((tier,index)=><tr key={index}><td>{index===0?"1st place":index===1?"2nd place":index===2?"3rd place":"4th–10th, combined"}</td><td>{tier.shareBps/100}%</td><td>{formatRewardAmount(BigInt(period.totalAmount)*BigInt(tier.shareBps)/10000n,period.asset.decimals)} {period.asset.symbol}</td></tr>)}</tbody></table></div>
          <div className={styles.section}><h3>Eligibility</h3><p className={styles.caption}>{period.eligibility.minimumPoints} points · {period.eligibility.minimumApprovedQuests} approved quests{period.eligibility.verification!=="none"?` · ${period.eligibility.verification==="telegram"?"Telegram verified":period.eligibility.verification==="manual"?"Manually verified":"Verified account"}`:""}</p></div>
        </>:<p className={styles.notice}>The selected reward period is unavailable.</p>}</section>
      </div>}
    </>}
    {(copied||copyError)&&<p role={copyError?"alert":"status"} className={styles.scopeNote}>{copyError??"Transaction ID copied."}</p>}
    <ActivityBonusDialog open={settingsOpen} onOpenChange={setSettingsOpen} days={props.bonusDays} points={props.bonusPoints} operation={props.bonusOperation} onSave={props.onSaveBonus} scopeKey={props.scopeKey}/>
  </div>;
}
