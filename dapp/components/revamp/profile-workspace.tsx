"use client";

import {useEffect, useId, useMemo, useRef, useState, type ReactNode} from "react";
import Link from "next/link";
import {RevampButton, RevampInput, RevampTag} from "./ui";
import {FigmaIcon} from "./figma-icon";
import styles from "./profile-workspace.module.css";

export type ProfileTab = "campaigns" | "activities" | "rewards";
export type ProfileResource<T> = {data: T | null; loading: boolean; error: string | null};
export type ProfileIdentity = {address: string; lockHash: string; userTypeId: string | null; displayName: string | null; lastActiveAt: number | null; verifiedTelegram?: boolean};
export type ProfileCampaignRow = {id: string; title: string; questsSubmitted: number | null; pointsEarned: bigint | null};
export type ProfileActivityRow = {id: string; campaignId: string; campaignTitle: string; questId: number; questTitle?: string; submittedAt: number | null; status: "pending" | "approved"};
export type ProfileRewardRow = {id: string; campaignId: string | null; campaignTitle: string; amount: bigint; assetLabel?: string; transactionHash: string | null; explorerUrl: string | null; occurredAt: number | null};
/** Supply confirmed claims only. Unknown badge kinds retain their real name. */
export type ProfileClaimedBadge = {id: string; name: string; kind?: "telegram" | "first-submission"};
export type ProfileWorkspaceProps = {
  status: "disconnected" | "loading" | "ready" | "no-user" | "error";
  error?: string | null;
  identity: ProfileIdentity | null;
  roleLabel?: string | null;
  points: ProfileResource<bigint>;
  campaigns: ProfileResource<{participated: ProfileCampaignRow[]; created: ProfileCampaignRow[]}>;
  activities: ProfileResource<ProfileActivityRow[]>;
  rewards: ProfileResource<ProfileRewardRow[]>;
  achievements: ProfileResource<ProfileClaimedBadge[]>;
  onConnect?: () => void;
  onRetry?: () => void;
  onRetryPoints?: () => void;
  onRetryCampaigns?: () => void;
  onRetryActivities?: () => void;
  onRetryRewards?: () => void;
  onRetryAchievements?: () => void;
  /** Resolve only after the actual name transaction is confirmed. */
  onSaveName?: (name: string) => Promise<void>;
  onTabChange?: (tab: ProfileTab) => void;
  rewardsDescription?: string;
  rewardsActions?: ReactNode;
};

function number(value: bigint | number | null | undefined) {return value == null ? "—" : value.toLocaleString("en-US");}
function message(error: unknown) {return error instanceof Error ? error.message : "Unable to complete this action. Try again.";}
function initials(name: string | null) {return name?.trim().split(/\s+/u).slice(0, 2).map(word => Array.from(word)[0]).join("").toUpperCase() || "?";}
function offset(date: Date) {const minutes = -date.getTimezoneOffset(); return `UTC${minutes < 0 ? "-" : "+"}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, "0")}:${String(Math.abs(minutes) % 60).padStart(2, "0")}`;}
function dateLabel(ms: number | null, mounted: boolean, withZone = true) {
  if (ms == null || !Number.isFinite(ms) || !Number.isFinite(new Date(ms).getTime())) return "Unavailable";
  if (!mounted) return "Loading local time…";
  const date = new Date(ms);
  const value = new Intl.DateTimeFormat("en-US", {month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false}).format(date);
  return withZone ? `${value} (${offset(date)})` : value;
}
function safeExternal(value: string | null) {try {if (!value) return null; const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;} catch {return null;}}
function shortHash(value: string) {return value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-6)}` : value;}

function ResourceNotice({resource, label, retry}: {resource: {loading: boolean; error: string | null}; label: string; retry?: () => void}) {
  if (resource.error) return <div className={styles.resourceError} role="alert"><span>{resource.error}</span>{retry && <button type="button" onClick={retry}>Retry {label}</button>}</div>;
  return resource.loading ? <p role="status" className={styles.resourceStatus}>Loading {label}…</p> : null;
}
function Empty({children, retry}: {children: ReactNode; retry?: () => void}) {return <div className={styles.empty}><p>{children}</p>{retry && <RevampButton variant="secondary" size="small" onClick={retry}>Retry</RevampButton>}</div>;}
function AssetIcon({kind}: {kind: "edit" | "copy" | "sort"}) {
  const id = `profile-icon-${useId().replaceAll(":", "")}`;
  // These exact Figma PNGs contain opaque theme-colored canvases. Normalize
  // their foreground/background into a luminance mask without changing or
  // tracing the source pixels; an alpha mask would paint a solid square.
  const {size, background, foreground} = {
    edit: {size: 24, background: [16, 16, 27], foreground: [247, 247, 252]},
    copy: {size: 16, background: [16, 16, 27], foreground: [192, 192, 212]},
    sort: {size: 14, background: [25, 25, 39], foreground: [165, 165, 192]},
  }[kind];
  const transfer = (channel: number) => ({type: "linear" as const, slope: 255 / (foreground[channel] - background[channel]), intercept: -background[channel] / (foreground[channel] - background[channel])});
  return <svg aria-hidden="true" className={`${styles.icon} ${styles[kind]}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
    <defs><filter id={`${id}-filter`} colorInterpolationFilters="sRGB"><feComponentTransfer><feFuncR {...transfer(0)} /><feFuncG {...transfer(1)} /><feFuncB {...transfer(2)} /></feComponentTransfer></filter><mask id={`${id}-mask`} x="0" y="0" width={size} height={size} maskUnits="userSpaceOnUse" style={{maskType: "luminance"}}><image href={`/assets/revamp/profile-${kind}.png`} width={size} height={size} filter={`url(#${id}-filter)`} /></mask></defs>
    <rect width={size} height={size} fill="currentColor" mask={`url(#${id}-mask)`} />
  </svg>;
}

export function ProfileWorkspace(props: ProfileWorkspaceProps) {
  const {identity, status, campaigns, activities, rewards, achievements, points} = props;
  const [tab, setTab] = useState<ProfileTab>("campaigns");
  const [campaignTab, setCampaignTab] = useState<"participated" | "created">("participated");
  const [sort, setSort] = useState<{key: "title" | "questsSubmitted" | "pointsEarned"; direction: "ascending" | "descending"} | null>(null);
  const [activityDirection, setActivityDirection] = useState<"ascending" | "descending" | null>(null);
  const [mounted, setMounted] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [savedName, setSavedName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const uid = useId();
  const scope = `${identity?.lockHash ?? ""}:${identity?.userTypeId ?? ""}`;
  const currentScope = useRef(scope); currentScope.current = scope;
  const nameOperation = useRef(0), busy = useRef(false);
  const copyOperation = useRef(0);
  useEffect(() => {setMounted(true); return () => {nameOperation.current++; copyOperation.current++;};}, []);
  useEffect(() => {nameOperation.current++; copyOperation.current++; busy.current = false; setEditing(false); setSaving(false); setSavedName(null); setNameError(null); setFeedback(""); setTab("campaigns"); setCampaignTab("participated"); setSort(null);}, [scope]);
  useEffect(() => {setSavedName(null);}, [identity?.displayName]);
  const displayName = savedName ?? identity?.displayName ?? (identity?.userTypeId ? "Member" : "Wallet connected");
  const campaignRows = useMemo(() => {
    const values = [...(campaigns.data?.[campaignTab] ?? [])];
    if (!sort) return values;
    return values.sort((a, b) => {
      const x = a[sort.key], y = b[sort.key];
      if (x == null) return y == null ? 0 : 1; if (y == null) return -1;
      const comparison = typeof x === "string" && typeof y === "string" ? x.localeCompare(y, "en") : x < y ? -1 : x > y ? 1 : 0;
      return sort.direction === "ascending" ? comparison : -comparison;
    });
  }, [campaigns.data, campaignTab, sort]);
  const activityRows = useMemo(() => {
    const values = [...(activities.data ?? [])];
    if (activityDirection) values.sort((a, b) => {
      if (a.submittedAt == null) return b.submittedAt == null ? 0 : 1; if (b.submittedAt == null) return -1;
      return activityDirection === "ascending" ? a.submittedAt - b.submittedAt : b.submittedAt - a.submittedAt;
    });
    return values;
  }, [activities.data, activityDirection]);

  function changeTab(next: ProfileTab) {if (next !== tab) {setTab(next); props.onTabChange?.(next);}}
  async function copy(value: string, label: string) {
    const operation = ++copyOperation.current, snapshot = scope;
    try {if (!navigator.clipboard?.writeText) throw Error("Clipboard unavailable. Select and copy the full value below."); await navigator.clipboard.writeText(value); if (operation === copyOperation.current && snapshot === currentScope.current) setFeedback(`${label} copied.`);}
    catch (error) {if (operation === copyOperation.current && snapshot === currentScope.current) setFeedback(message(error));}
  }
  async function saveName() {
    if (busy.current || !props.onSaveName) return;
    const next = draftName.trim();
    if (!next) {setNameError("Enter a display name."); return;}
    const operation = ++nameOperation.current, snapshot = scope;
    busy.current = true; setSaving(true); setNameError(null);
    try {await props.onSaveName(next); if (operation === nameOperation.current && snapshot === currentScope.current) {setSavedName(next); setEditing(false); setFeedback("Display name updated.");}}
    catch (error) {if (operation === nameOperation.current && snapshot === currentScope.current) setNameError(message(error));}
    finally {if (operation === nameOperation.current && snapshot === currentScope.current) {busy.current = false; setSaving(false);}}
  }
  function sortCampaign(key: "title" | "questsSubmitted" | "pointsEarned") {setSort(previous => ({key, direction: previous?.key === key && previous.direction === "ascending" ? "descending" : "ascending"}));}
  function sortable(label: string, key: "title" | "questsSubmitted" | "pointsEarned") {return <th scope="col" aria-sort={sort?.key === key ? sort.direction : "none"}><button type="button" onClick={() => sortCampaign(key)} aria-label={`Sort by ${label.toLowerCase()}`}>{label}<AssetIcon kind="sort" /></button></th>;}

  return <main className={styles.main} id="revamp-main">
    <div className={styles.container}>
      <h1>My profile</h1>
      <p className={feedback ? styles.feedback : styles.srOnly} role="status" aria-live="polite">{feedback}</p>
      {status === "disconnected" ? <div className={styles.connectionState}><h2>Connect your wallet</h2><p>View your profile, campaign activity and on-chain rewards.</p>{props.onConnect && <RevampButton onClick={props.onConnect}>Connect wallet</RevampButton>}</div> : !identity ? <div className={styles.connectionState} aria-busy={status === "loading"}><h2>{status === "loading" ? "Loading your profile…" : "Profile unavailable"}</h2>{props.error && <p role="alert">{props.error}</p>}{props.onRetry && status !== "loading" && <RevampButton variant="secondary" onClick={props.onRetry}>Retry profile</RevampButton>}</div> : <>
        {(props.error || status === "no-user") && <div className={props.error ? styles.pageError : styles.pageNotice} role={props.error ? "alert" : "status"}>{props.error ?? "No on-chain profile yet. Your wallet is connected; a profile is created by your first profile or quest transaction."}{props.error && props.onRetry && <button type="button" onClick={props.onRetry}>Retry profile</button>}</div>}
        <div className={styles.layout}>
          <aside className={styles.sidebar} aria-label="Profile details">
            <div className={styles.portrait}>
              <div className={styles.cover}><img src="/assets/revamp/profile-cover.svg" width="1512" height="112" alt="" /></div>
              <div className={styles.avatar} aria-hidden="true">{initials(savedName ?? identity.displayName)}</div>
            </div>
            <div className={styles.identity}>
              <div className={styles.nameRow}><h2>{displayName}</h2>{props.onSaveName && <button type="button" className={styles.editButton} aria-label="Edit display name" onClick={() => {setDraftName(savedName ?? identity.displayName ?? ""); setNameError(null); setEditing(true);}} disabled={saving || status === "loading"}><AssetIcon kind="edit" /></button>}</div>
              {editing && <form className={styles.nameForm} aria-label="Edit display name" onSubmit={event => {event.preventDefault(); void saveName();}}>
                <label htmlFor={`${uid}-name`}>Display name</label><RevampInput id={`${uid}-name`} value={draftName} onChange={event => setDraftName(event.target.value)} disabled={saving} autoFocus aria-invalid={Boolean(nameError)} aria-describedby={`${uid}-name-note`} />
                <p id={`${uid}-name-note`}>Changing your name is an on-chain transaction. Saving needs the profile verification service and wallet confirmation.</p>
                {nameError && <p className={styles.errorText} role="alert">{nameError}</p>}
                <div><RevampButton type="submit" size="small" loading={saving}>Save name</RevampButton><RevampButton variant="secondary" size="small" disabled={saving} onClick={() => setEditing(false)}>Cancel</RevampButton></div>
              </form>}
              <p className={styles.lastActive}>Last active · {status === "loading" && identity.lastActiveAt == null ? "Loading…" : dateLabel(identity.lastActiveAt, mounted)}</p>
              {identity.verifiedTelegram && <RevampTag tone="blue" pill>Telegram</RevampTag>}
              <p className={styles.role}>{props.roleLabel ?? (status === "loading" ? "Checking role…" : "Role unavailable")}</p>
            </div>
            <div className={styles.totals}>
              <div className={styles.totalPoints}><p title="Spendable Points currently held by this wallet.">Total points</p><strong aria-label={`Total points: ${number(points.data)}`}>{number(points.data)}</strong><ResourceNotice resource={points} label="points" retry={props.onRetryPoints} /></div>
              <dl className={styles.counts}><div><dt>Participated</dt><dd>{number(campaigns.data?.participated.length)}</dd></div><div><dt>Created</dt><dd>{number(campaigns.data?.created.length)}</dd></div><div><dt>Quests</dt><dd>{number(activities.data?.length)}</dd></div></dl>
            </div>
            <div className={styles.identifiers}>
              <div><div className={styles.identifierLabel}>Wallet address<button type="button" aria-label="Copy full wallet address" onClick={() => void copy(identity.address, "Wallet address")}><AssetIcon kind="copy" /></button></div><code>{identity.address}</code></div>
              <div><div className={styles.identifierLabel}>User type ID{identity.userTypeId && <button type="button" aria-label="Copy user type ID" onClick={() => void copy(identity.userTypeId!, "User type ID")}><AssetIcon kind="copy" /></button>}</div>{identity.userTypeId ? <code>{identity.userTypeId}</code> : <p className={styles.unavailable}>{status === "loading" ? "Loading user type ID…" : status === "no-user" ? "Not created yet" : "Unavailable"}</p>}</div>
            </div>
            <section className={styles.achievements} aria-labelledby={`${uid}-achievements`}><h3 id={`${uid}-achievements`}>Achievements</h3><ResourceNotice resource={achievements} label="achievements" retry={props.onRetryAchievements} />
              {achievements.data && achievements.data.length > 0 ? <ul className={styles.badges}>{achievements.data.map(badge => {const kind = badge.kind ?? (badge.id === "telegram" || badge.id === "first-submission" ? badge.id : null); return <li key={badge.id}>{kind ? <img src={`/assets/revamp/profile-${kind === "telegram" ? "telegram" : "first-submission"}-64.svg`} width="64" height="64" alt={badge.name} title={badge.name} /> : <span className={styles.unknownBadge}>{badge.name}</span>}</li>;})}</ul> : achievements.data && !achievements.loading && !achievements.error ? <p className={styles.unavailable}>No claimed badges yet.</p> : !achievements.loading && !achievements.error && <p className={styles.unavailable}>Claimed badges unavailable.</p>}
              <Link prefetch={false} href="/revamp/profile/badges">View claimable badges</Link>
            </section>
          </aside>
          <section className={styles.workspace} aria-label="Profile activity">
            <div className={styles.tabs} role="tablist" aria-label="Profile sections">{(["campaigns", "activities", "rewards"] as const).map((value, index, all) => <button key={value} type="button" role="tab" id={`${uid}-tab-${value}`} aria-selected={tab === value} aria-controls={`${uid}-panel`} tabIndex={tab === value ? 0 : -1} onClick={() => changeTab(value)} onKeyDown={event => {let next: ProfileTab | undefined; if (event.key === "ArrowRight") next = all[(index + 1) % all.length]; if (event.key === "ArrowLeft") next = all[(index + all.length - 1) % all.length]; if (event.key === "Home") next = all[0]; if (event.key === "End") next = all[all.length - 1]; if (next) {event.preventDefault(); changeTab(next); document.getElementById(`${uid}-tab-${next}`)?.focus();}}}>{value[0].toUpperCase() + value.slice(1)}</button>)}</div>
            <div role="tabpanel" id={`${uid}-panel`} aria-labelledby={`${uid}-tab-${tab}`} className={styles.tabPanel} tabIndex={0}>
              {tab === "campaigns" && <>
                <div className={styles.segmented} role="group" aria-label="Campaign list"><button type="button" aria-pressed={campaignTab === "participated"} onClick={() => setCampaignTab("participated")}>Participated ({number(campaigns.data?.participated.length)})</button><button type="button" aria-pressed={campaignTab === "created"} onClick={() => setCampaignTab("created")}>Created ({number(campaigns.data?.created.length)})</button></div>
                <div className={`${styles.panel} ${styles.campaignPanel}`} aria-busy={campaigns.loading}><ResourceNotice resource={campaigns} label="campaigns" retry={props.onRetryCampaigns} />
                  {campaignRows.length > 0 ? <div className={styles.tableScroll}><table className={styles.campaignTable} aria-label={`${campaignTab === "participated" ? "Participated" : "Created"} campaigns`}><colgroup><col /><col className={styles.questColumn} /><col className={styles.pointsColumn} /></colgroup><thead><tr>{sortable("Campaign", "title")}{sortable("Quests submitted", "questsSubmitted")}{sortable("Points earned", "pointsEarned")}</tr></thead><tbody>{campaignRows.map(row => <tr key={row.id}><td><Link prefetch={false} href={`/revamp/campaign/${encodeURIComponent(row.id)}`}>{row.title}</Link></td><td>{number(row.questsSubmitted)}</td><td className={styles.accent}>{number(row.pointsEarned)}</td></tr>)}</tbody></table></div> : campaigns.data && !campaigns.loading && !campaigns.error ? <Empty>{campaignTab === "participated" ? "No participated campaigns yet." : "No created campaigns yet."}</Empty> : !campaigns.loading && !campaigns.error && <Empty retry={props.onRetryCampaigns}>Campaign data unavailable.</Empty>}
                </div>
              </>}
              {tab === "activities" && <div className={styles.panel} aria-busy={activities.loading}><h2>Contribution activity</h2><p className={styles.panelDescription}>Submission history with the current review status.</p><ResourceNotice resource={activities} label="activities" retry={props.onRetryActivities} />
                {activityRows.length > 0 ? <div className={styles.tableScroll}><table className={styles.activityTable} aria-label="Contribution activity"><colgroup><col /><col className={styles.dateColumn} /><col className={styles.statusColumn} /></colgroup><thead><tr><th scope="col">Campaign / Quest</th><th scope="col" aria-sort={activityDirection ?? "none"}><button type="button" onClick={() => setActivityDirection(previous => previous === "ascending" ? "descending" : "ascending")} aria-label="Sort by submitted time">Submitted (local time)<AssetIcon kind="sort" /></button></th><th scope="col">Current status</th></tr></thead><tbody>{activityRows.map(row => <tr key={row.id}><td><Link prefetch={false} href={`/revamp/campaign/${encodeURIComponent(row.campaignId)}?tab=quests`}>{row.campaignTitle} · {row.questTitle || `Quest ${row.questId}`}</Link></td><td>{dateLabel(row.submittedAt, mounted)}</td><td><RevampTag pill tone={row.status === "approved" ? "green" : "amber"}>{row.status === "approved" ? "Approved" : "Under review"}</RevampTag></td></tr>)}</tbody></table></div> : activities.data && !activities.loading && !activities.error ? <Empty>No submissions yet.</Empty> : !activities.loading && !activities.error && <Empty retry={props.onRetryActivities}>Submission activity unavailable.</Empty>}
              </div>}
              {tab === "rewards" && <div className={styles.panel} aria-busy={rewards.loading}><div className={styles.panelHeading}><h2>Reward transactions</h2>{props.rewardsActions}</div><p className={styles.panelDescription}>{props.rewardsDescription ?? "On-chain reward history · Times shown in your local time"}</p><ResourceNotice resource={rewards} label="rewards" retry={props.onRetryRewards} />
                {rewards.data && rewards.data.length > 0 ? <ul className={styles.rewardRows}>{rewards.data.map(row => {const url = safeExternal(row.explorerUrl); return <li key={row.id}><div className={styles.rewardEvent}><strong>{row.campaignId ? <Link prefetch={false} href={`/revamp/campaign/${encodeURIComponent(row.campaignId)}`}>{row.campaignTitle}</Link> : row.campaignTitle}</strong><span className={styles.rewardAmount}><span className={styles.trophy}><FigmaIcon name="trophy" size={20} /></span>{row.amount >= 0n ? "+" : ""}{number(row.amount)} {row.assetLabel ?? "points"}</span></div><div className={styles.rewardDetails}><time>{dateLabel(row.occurredAt, mounted)}</time>{url ? <a href={url} target="_blank" rel="noopener noreferrer">{row.transactionHash && `${shortHash(row.transactionHash)} · `}View on explorer</a> : row.transactionHash ? <span title={row.transactionHash}>{shortHash(row.transactionHash)} · Explorer unavailable</span> : <span>Transaction reference unavailable</span>}</div></li>;})}</ul> : rewards.data && !rewards.loading && !rewards.error ? <Empty>No reward transactions yet.</Empty> : !rewards.loading && !rewards.error && <Empty retry={props.onRetryRewards}>Reward history has not been loaded.</Empty>}
              </div>}
            </div>
          </section>
        </div>
      </>}
    </div>
  </main>;
}
