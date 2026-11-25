"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import type { ProfileBadge } from "@/lib/revamp/profile-badges";
import { RevampButton } from "./ui";
import styles from "./profile-badges.module.css";

export interface ProfileBadgesProps {
  connected: boolean;
  scopeKey: string;
  loading: boolean;
  error: string | null;
  eligibilityUnavailableReason: string | null;
  badges: ProfileBadge[];
  onConnect: () => void;
  onRetry: () => void;
}

function ClaimedIcon() {
  const id = `badge-check-${useId().replaceAll(":", "")}`;
  const background = [25, 25, 39], foreground = [74, 222, 128];
  const transfer = (channel: number) => ({ type: "linear" as const, slope: 255 / (foreground[channel] - background[channel]), intercept: -background[channel] / (foreground[channel] - background[channel]) });
  return <svg className={styles.check} aria-hidden="true" width="16" height="16" viewBox="0 0 16 16"><defs>
    <filter id={`${id}-filter`} colorInterpolationFilters="sRGB"><feComponentTransfer><feFuncR {...transfer(0)} /><feFuncG {...transfer(1)} /><feFuncB {...transfer(2)} /></feComponentTransfer></filter>
    <mask id={`${id}-mask`} x="0" y="0" width="16" height="16" maskUnits="userSpaceOnUse" style={{ maskType: "luminance" }}><image href="/assets/revamp/profile-check-circle.png" width="16" height="16" filter={`url(#${id}-filter)`} /></mask>
  </defs><rect width="16" height="16" fill="currentColor" mask={`url(#${id}-mask)`} /></svg>;
}

function claimedDate(timestamp: number) {
  const date = new Date(timestamp), offset = -date.getTimezoneOffset();
  const timezone = `UTC${offset < 0 ? "-" : "+"}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}:${String(Math.abs(offset) % 60).padStart(2, "0")}`;
  return `${new Intl.DateTimeFormat("en-US", {year:"numeric", month:"short", day:"numeric", hour:"2-digit", minute:"2-digit", hour12:false}).format(date)} (${timezone})`;
}

/** The view distinguishes unknown eligibility from an eligible list of zero. */
export function ProfileBadges(props: ProfileBadgesProps) {
  const [tab, setTab] = useState<"claimable" | "claimed">("claimable");
  const [mounted, setMounted] = useState(false);
  const uid = useId();
  useEffect(() => setMounted(true), []);
  useEffect(() => setTab("claimable"), [props.scopeKey]);
  const claimed = props.badges.filter(badge => badge.claimed);
  const claimable = props.badges.filter(badge => !badge.claimed && badge.claimable === true);
  const eligibilityUnknown = props.badges.some(badge => !badge.claimed && badge.claimable === null);
  const rows = tab === "claimed" ? claimed : claimable;
  const ready = props.connected && !props.loading && !props.error;
  const unknown = Boolean(props.eligibilityUnavailableReason || eligibilityUnknown);
  return <main id="revamp-main" className={styles.main}>
    <div className={styles.container}>
      <nav className={styles.breadcrumb} aria-label="Breadcrumb"><Link prefetch={false} href="/revamp/profile">My profile</Link><span className={styles.chevron} aria-hidden="true" /><span aria-current="page">Badges</span></nav>
      <div className={styles.heading}><h1>Platform badges</h1><p>Claim badges for your platform milestones. Claimed badges appear on your profile.</p></div>
      {!props.connected ? <section className={styles.empty}><h2>Connect your wallet</h2><p>View badges for your current account.</p><RevampButton onClick={props.onConnect}>Connect wallet</RevampButton></section> : <>
        <div role="tablist" aria-label="Badge status" className={styles.segmented}>
          {(["claimable", "claimed"] as const).map((value, index) => <button type="button" key={value} role="tab" id={`${uid}-${value}`} aria-controls={`${uid}-list`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={event => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? "claimable" : event.key === "End" ? "claimed" : index === 0 ? "claimed" : "claimable";
            setTab(next); document.getElementById(`${uid}-${next}`)?.focus();
          }}>{value === "claimable" ? "Claimable" : "Claimed"} ({!ready || value === "claimable" && unknown ? "—" : value === "claimable" ? claimable.length : claimed.length})</button>)}
        </div>
        <div role="tabpanel" id={`${uid}-list`} aria-labelledby={`${uid}-${tab}`} aria-busy={props.loading} className={styles.list}>
          {props.loading ? <p role="status" className={styles.notice}>Loading badges…</p> : props.error ? <div role="alert" className={styles.error}><p>{props.error}</p><RevampButton variant="secondary" onClick={props.onRetry}>Retry badges</RevampButton></div> : <>
            {tab === "claimable" && unknown && <div className={styles.notice} role="status"><p>Badge eligibility is unavailable for this environment.</p><p>Claimed records are available in the Claimed tab.</p><RevampButton variant="secondary" size="small" onClick={props.onRetry}>Retry badges</RevampButton></div>}
            {rows.map(badge => <article key={badge.id} className={styles.card}>
              {badge.classification !== "other" && <img src={`/assets/revamp/profile-${badge.classification === "telegram-verification" ? "telegram" : "first-submission"}-80.svg`} width="80" height="80" alt="" />}
              <div className={styles.information}><h2>{badge.title}</h2><p>{badge.description || (badge.claimed ? badge.claimedAt && mounted ? `Claimed · ${claimedDate(badge.claimedAt)}` : "This badge has been claimed." : "Claim availability is being verified.")}</p></div>
              {badge.claimed ? <span className={styles.claimed}><ClaimedIcon />Claimed</span> : <RevampButton disabled title="Badge claiming is unavailable in this environment.">Claim badge</RevampButton>}
            </article>)}
            {!rows.length && !(tab === "claimable" && unknown) && <section className={styles.empty}><h2>{tab === "claimable" ? "You’re all caught up" : "No claimed badges yet"}</h2><p>{tab === "claimable" ? "You’ve claimed every badge you’re currently eligible for." : "Your claimed platform badges will appear here."}</p>{tab === "claimable" && <button type="button" className={styles.textLink} onClick={() => {setTab("claimed"); document.getElementById(`${uid}-claimed`)?.focus();}}>View claimed badges</button>}</section>}
          </>}
        </div>
      </>}
    </div>
  </main>;
}
