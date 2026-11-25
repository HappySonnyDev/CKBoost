"use client";

import {useEffect, useId, useRef, useState, type ReactNode} from "react";
import Link from "next/link";
import {RevampButton} from "./ui";
import {FigmaIcon} from "./figma-icon";
import styles from "./admin-overview.module.css";

export type AdminPeriod = "weekly" | "quarterly" | "yearly";
export type AdminResource<T> = {data: T | null; loading: boolean; error: string | null};
export type AdminMetric = {value: number | bigint | null; deltaPercent: number | null; unavailableReason?: string; retryable?: boolean};
export type AdminMetrics = {newUsers: AdminMetric; campaignsCreated: AdminMetric; questParticipants: AdminMetric};
export type AdminActionItem = {id: string; type: "campaign" | "tipping"; title: string; description: string; at: number | null; actionLabel: "Approve" | "Review" | "Endorse"; href?: string};
export type AdminHistoryPoint = {at: number; value: bigint};
export type AdminFundingAsset = {id: string; symbol: string; decimals: number | null; campaignAmount: bigint | null; tippingAmount: bigint | null};
export type AdminFunding = {campaignCkbShannons: bigint | null; tippingCkbShannons: bigint | null; assets: AdminFundingAsset[]; campaignHistory: AdminHistoryPoint[] | null; tippingHistory: AdminHistoryPoint[] | null; historyUnavailableReason?: string};
export type AdminActivityItem = {id: string; kind: "campaign" | "tipping" | "user" | "achievement" | "reward"; title: string; description: string; at: number | null; href?: string};
export type AdminNavigationItem = {id: "overview" | "campaigns" | "users" | "tipping" | "rewards"; href: string};
export type AdminOverviewProps = {
  access: "checking" | "disconnected" | "denied" | "allowed" | "error";
  error?: string | null;
  period: AdminPeriod;
  onPeriodChange: (period: AdminPeriod) => void;
  metrics: AdminResource<AdminMetrics>;
  actions: AdminResource<AdminActionItem[]>;
  funding: AdminResource<AdminFunding>;
  activity: AdminResource<AdminActivityItem[]>;
  navigation?: AdminNavigationItem[];
  metricsDescription?: string;
  currentDataDescription?: string;
  onConnect?: () => void;
  onRetry?: () => void;
  onRetryMetrics?: () => void;
  onRetryActions?: () => void;
  onRetryFunding?: () => void;
  onRetryActivity?: () => void;
  onAction?: (item: AdminActionItem) => void | Promise<void>;
};

const tabLabels = {overview: "Overview", campaigns: "Campaigns", users: "Users", tipping: "Tipping", rewards: "Rewards & Recognition"};
function count(value: number | bigint | null | undefined) {return value == null ? "—" : value.toLocaleString("en-US");}
function errorText(value: unknown) {return value instanceof Error ? value.message : "Unable to complete this action. Try again.";}
function localHref(value: string | undefined) {return value?.startsWith("/") && !value.startsWith("//") && !/[\\\u0000-\u0020]/.test(value) ? value : null;}
function units(value: bigint | null | undefined, decimals: number | null) {
  if (value == null) return "—";
  if (decimals == null || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return `${value.toLocaleString("en-US")} base units`;
  const negative = value < 0n, digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  const integer = (decimals ? digits.slice(0, -decimals) : digits).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = decimals ? digits.slice(-decimals).replace(/0+$/, "") : "";
  return `${negative ? "-" : ""}${integer}${fraction ? `.${fraction}` : ""}`;
}
function dateLabel(ms: number | null, mounted: boolean, full = false) {
  if (ms == null || !Number.isFinite(ms) || !Number.isFinite(new Date(ms).getTime())) return "Time unavailable";
  if (!mounted) return "Loading local time…";
  return new Intl.DateTimeFormat("en-US", {month: "short", day: "numeric", ...(full ? {year: "numeric" as const} : {}), hour: "2-digit", minute: "2-digit", hour12: false}).format(ms);
}
function utcOffset(ms: number) {const minutes = -new Date(ms).getTimezoneOffset(); return `UTC${minutes < 0 ? "-" : "+"}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, "0")}:${String(Math.abs(minutes) % 60).padStart(2, "0")}`;}
function Notice({resource, label, retry}: {resource: {loading: boolean; error: string | null}; label: string; retry?: () => void}) {
  return resource.error ? <div className={styles.error} role="alert"><span>{resource.error}</span>{retry && <button type="button" onClick={retry}>Retry {label}</button>}</div> : resource.loading ? <p className={styles.notice} role="status">Loading {label}…</p> : null;
}
function Empty({children, retry}: {children: ReactNode; retry?: () => void}) {return <div className={styles.empty}><p>{children}</p>{retry && <RevampButton variant="secondary" size="small" onClick={retry}>Retry</RevampButton>}</div>;}

/** Plot supplied observations only. Unknown history never becomes a flat line. */
function FundingHistory({points, name, tone, reason}: {points: AdminHistoryPoint[] | null | undefined; name: string; tone: "green" | "violet"; reason?: string}) {
  const id = `funding-${useId().replaceAll(":", "")}`;
  if (!points || points.length === 0 || points.some(point => !Number.isFinite(point.at) || point.value < 0n)) return <div className={styles.historyUnavailable}><span>{reason ?? "Balance history unavailable."}</span></div>;
  const sorted = [...points].sort((a, b) => a.at - b.at);
  const min = sorted.reduce((value, p) => p.value < value ? p.value : value, sorted[0].value);
  const max = sorted.reduce((value, p) => p.value > value ? p.value : value, sorted[0].value);
  const duration = sorted[sorted.length - 1].at - sorted[0].at;
  const coords = sorted.map((point, i) => [duration ? 4 + (point.at - sorted[0].at) / duration * 372 : i ? 376 : 4, max === min ? 44 : 80 - Number((point.value - min) * 1_000_000n / (max - min)) / 1_000_000 * 72]);
  const line = coords.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(3)} ${y.toFixed(3)}`).join(" ");
  const description = `${points.length} observed balances. First ${sorted[0].value.toString()} shannons, latest ${sorted[sorted.length - 1].value.toString()} shannons.`;
  return <svg className={styles.history} data-tone={tone} viewBox="0 0 380 88" preserveAspectRatio="none" role="img" aria-label={`${name} balance history`}><title>{name} balance history</title><desc>{description}</desc><defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="currentColor" stopOpacity=".3" /><stop offset="100%" stopColor="currentColor" stopOpacity="0" /></linearGradient></defs>{coords.length > 1 ? <><path d={`${line} L${coords[coords.length - 1][0]} 88 L${coords[0][0]} 88 Z`} fill={`url(#${id})`} /><path d={line} stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" fill="none" /></> : <circle cx="190" cy="44" r="3" fill="currentColor" />}</svg>;
}
function ActivityIcon({kind}: {kind: AdminActivityItem["kind"]}) {
  return <span className={styles.eventIcon} data-kind={kind} aria-hidden="true">{kind === "tipping" ? <FigmaIcon name="udt" size={18} /> : <span className={styles.eventGlyph} data-kind={kind} />}</span>;
}

export function AdminOverview(props: AdminOverviewProps) {
  const [mounted, setMounted] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const busy = useRef(false), operation = useRef(0);
  useEffect(() => {setMounted(true); return () => {operation.current++;};}, []);
  useEffect(() => {if (props.access !== "allowed") {operation.current++; busy.current = false; setBusyId(null); setActionError(null);}}, [props.access]);
  const metrics = props.metrics.data, funding = props.funding.data;
  async function activate(item: AdminActionItem) {
    if (props.access !== "allowed" || !props.onAction || busy.current) return;
    busy.current = true; setBusyId(item.id); setActionError(null); const version = ++operation.current;
    try {await props.onAction(item);} catch (error) {if (version === operation.current) setActionError(errorText(error));}
    finally {if (version === operation.current) {busy.current = false; setBusyId(null);}}
  }
  return <main id="revamp-main" className={styles.main}>
    <header className={styles.hero}>
      <img src="/assets/revamp/admin-space.svg" width="1440" height="140" alt="" className={styles.space} />
      <div className={styles.heroContent}><div className={styles.heroTitles}><span className={styles.adminLabel}>Platform Admin</span><h1>Overview</h1><p>Review pending campaigns and monitor platform activity.</p></div><img src="/assets/revamp/admin-rabbit.svg" width="151" height="83" alt="" className={styles.rabbit} /></div>
    </header>
    <div className={styles.container}>
      <nav className={styles.tabs} aria-label="Admin navigation">{(Object.keys(tabLabels) as AdminNavigationItem["id"][]).map(id => {const href = localHref(props.navigation?.find(item => item.id === id)?.href);return href ? <Link key={id} href={href} prefetch={false} aria-current={id === "overview" ? "page" : undefined}>{tabLabels[id]}</Link> : <span key={id} aria-current={id === "overview" ? "page" : undefined} aria-disabled={id !== "overview" || undefined}>{tabLabels[id]}</span>;})}</nav>
      {props.access !== "allowed" ? <section className={styles.accessState} aria-busy={props.access === "checking"}>
        <h2>{props.access === "checking" ? "Checking administrator access…" : props.access === "disconnected" ? "Connect your administrator wallet" : props.access === "error" ? "Administrator access unavailable" : "Platform administrator access required"}</h2>
        <p>{props.error ?? (props.access === "disconnected" ? "Connect a wallet to verify its current platform role." : props.access === "checking" ? "Reading the current protocol permissions." : "Only current platform administrators can access this overview.")}</p>
        {props.access === "disconnected" && props.onConnect && <RevampButton onClick={props.onConnect}>Connect wallet</RevampButton>}
        {(props.access === "error" || props.access === "denied") && props.onRetry && <RevampButton variant="secondary" onClick={props.onRetry}>Retry access</RevampButton>}
      </section> : <div className={styles.columns}>
        <div className={styles.primary}>
          <section className={styles.panel} aria-labelledby="admin-health-heading" aria-busy={props.metrics.loading}>
            <div className={styles.healthHeading}><h2 id="admin-health-heading">Platform Health</h2><div className={styles.periods} role="group" aria-label="Metrics period">{(["weekly", "quarterly", "yearly"] as const).map(period => <button key={period} type="button" aria-pressed={props.period === period} onClick={() => {if (period !== props.period) props.onPeriodChange(period);}}>{period[0].toUpperCase() + period.slice(1)}</button>)}</div></div>
            <Notice resource={props.metrics} label="metrics" retry={props.onRetryMetrics} />
            <dl className={styles.metrics}>{([["New users", metrics?.newUsers], ["Campaigns created", metrics?.campaignsCreated], ["Quest participants", metrics?.questParticipants]] as const).map(([label, metric]) => {const delta = metric?.deltaPercent, valid = delta != null && Number.isFinite(delta); return <div key={label}><dt>{label}</dt><dd><strong title={metric?.value == null ? metric?.unavailableReason : undefined} aria-label={metric?.value == null && metric?.unavailableReason ? `${label} unavailable: ${metric.unavailableReason}` : undefined}>{count(metric?.value)}</strong>{valid && <span className={styles.trend} data-direction={delta > 0 ? "up" : delta < 0 ? "down" : "flat"} aria-label={`${Math.abs(delta)} percent ${delta > 0 ? "increase" : delta < 0 ? "decrease" : "change"}`}>{delta !== 0 && <span className={styles.trendArrow} aria-hidden="true" />}{Math.abs(delta).toLocaleString("en-US", {maximumFractionDigits: 2})}%</span>}</dd></div>;})}</dl>
            {!props.metrics.loading && !props.metrics.error && metrics?.newUsers.value == null && metrics?.newUsers.retryable === true && props.onRetryMetrics && <div><RevampButton variant="secondary" size="small" onClick={props.onRetryMetrics}>Retry metrics</RevampButton></div>}
            {props.metricsDescription && <p className={styles.dataNote}>{props.metricsDescription}</p>}
          </section>
          <section className={`${styles.panel} ${styles.actionPanel}`} aria-labelledby="admin-action-heading" aria-busy={props.actions.loading}>
            <div className={styles.actionHeading}><h2 id="admin-action-heading">Need Action</h2><span className={styles.pendingCount} aria-label={props.actions.data ? `${props.actions.data.length} pending actions` : "Pending action count unavailable"}>{props.actions.data ? count(props.actions.data.length) : "—"}</span></div>
            <Notice resource={props.actions} label="actions" retry={props.onRetryActions} />{actionError && <p role="alert" className={styles.error}>{actionError}</p>}
            {props.actions.data && props.actions.data.length > 0 ? <div className={styles.tableScroll}><table className={styles.actionTable} aria-label="Pending admin actions"><colgroup><col className={styles.typeColumn} /><col /><col className={styles.timeColumn} /><col className={styles.actionColumn} /></colgroup><thead><tr><th scope="col">Type</th><th scope="col">Description</th><th scope="col">Time (local)</th><th scope="col" aria-label="Action" /></tr></thead><tbody>{props.actions.data.map(item => <tr key={item.id}><td>{item.type === "campaign" ? "Campaign" : "Tipping"}</td><td><strong>{item.title}</strong><p>{item.description}</p></td><td title={item.at != null && mounted ? `${dateLabel(item.at, mounted, true)} (${utcOffset(item.at)})` : undefined}>{dateLabel(item.at, mounted)}</td><td>{props.onAction ? <button type="button" className={styles.actionLink} disabled={busyId !== null} aria-busy={busyId === item.id} onClick={() => void activate(item)}>{busyId === item.id ? "Working…" : item.actionLabel}</button> : localHref(item.href) ? <Link href={localHref(item.href)!} prefetch={false} className={styles.actionLink} title={`Open ${item.type} ${item.actionLabel.toLowerCase()}`}>{item.actionLabel}</Link> : <span className={styles.unavailable}>Unavailable</span>}</td></tr>)}</tbody></table></div> : props.actions.data && !props.actions.loading && !props.actions.error ? <Empty>No pending actions.</Empty> : !props.actions.loading && !props.actions.error && <Empty retry={props.onRetryActions}>Pending actions unavailable.</Empty>}
          </section>
          <section className={styles.panel} aria-labelledby="admin-funding-heading" aria-busy={props.funding.loading}>
            <h2 id="admin-funding-heading" className={styles.fundingHeading}>Funding Overview</h2><Notice resource={props.funding} label="funding" retry={props.onRetryFunding} />
            <div className={styles.fundingCards}>{([["Campaign funding", funding?.campaignCkbShannons, funding?.campaignHistory, "green"], ["Tipping pool", funding?.tippingCkbShannons, funding?.tippingHistory, "violet"]] as const).map(([label, amount, history, tone]) => <div key={label} className={styles.fundingCard}><h3>{label}</h3><div className={styles.fundingValue}><strong>{units(amount, 8)}</strong><span>CKB locked</span></div><FundingHistory points={history} name={label} tone={tone} reason={funding?.historyUnavailableReason} /></div>)}</div>
            <div className={styles.assets}><h3>UDT assets</h3>{funding && funding.assets.length > 0 ? <div className={styles.tableScroll}><table className={styles.assetsTable} aria-label="Funding by UDT asset"><colgroup><col /><col /><col /></colgroup><thead><tr><th scope="col">Asset</th><th scope="col">Campaign funding</th><th scope="col">Tipping pool</th></tr></thead><tbody>{funding.assets.map(asset => <tr key={asset.id}><td>{asset.symbol}</td><td>{units(asset.campaignAmount, asset.decimals)}{asset.campaignAmount != null && ` ${asset.symbol}`}</td><td>{units(asset.tippingAmount, asset.decimals)}{asset.tippingAmount != null && ` ${asset.symbol}`}</td></tr>)}</tbody></table></div> : funding && !props.funding.loading && !props.funding.error ? <p className={styles.dataNote}>No UDT assets locked.</p> : !props.funding.loading && !props.funding.error && <p className={styles.dataNote}>UDT balances unavailable.</p>}</div>
            {props.currentDataDescription && <p className={styles.dataNote}>{props.currentDataDescription}</p>}
          </section>
        </div>
        <section className={`${styles.panel} ${styles.activityPanel}`} aria-labelledby="admin-activity-heading" aria-busy={props.activity.loading}>
          <div className={styles.activityHeading}><h2 id="admin-activity-heading">Recent activity</h2></div><Notice resource={props.activity} label="activity" retry={props.onRetryActivity} />
          {props.activity.data && props.activity.data.length > 0 ? <ul className={styles.activityList}>{props.activity.data.map(item => {const body = <><ActivityIcon kind={item.kind} /><span className={styles.eventDetails}><strong>{item.title}</strong><span>{item.description}</span></span><time title={item.at != null && mounted ? `${dateLabel(item.at, mounted, true)} (${utcOffset(item.at)})` : undefined}>{dateLabel(item.at, mounted)}</time></>; const href = localHref(item.href);return <li key={item.id}>{href ? <Link href={href} prefetch={false} className={styles.activityRow}>{body}</Link> : <div className={styles.activityRow}>{body}</div>}</li>;})}</ul> : props.activity.data && !props.activity.loading && !props.activity.error ? <Empty>No recorded activity available.</Empty> : !props.activity.loading && !props.activity.error && <Empty retry={props.onRetryActivity}>Activity history unavailable.</Empty>}
        </section>
      </div>}
    </div>
  </main>;
}
