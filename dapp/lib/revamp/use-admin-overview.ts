"use client";

import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ccc } from "@ckb-ccc/connector-react";
import { useProtocol } from "@/lib/providers/protocol-provider";
import { currentDeployment } from "@/lib/ckb/current-deployment";
import { makeProfileReadScope, withProfileDeadline, type ProfileReadScope } from "./profile-model";
import { getDiscoveryReadClient } from "./discovery-read-client";
import { shouldRetryDiscovery } from "./discovery-loader";
import { adminNeedActions, adminRecordedActivity, isOverviewAdmin, readAdminCurrentSnapshot, readAdminFunding, readAdminOverviewMetrics,
  type AdminPeriod, type AdminResource, type AdminActionItem, type AdminActivityItem } from "./admin-overview-model";

export type AdminOverviewAccess = "checking" | "disconnected" | "denied" | "allowed" | "error";
const ids = new WeakMap<object, number>(); let sequence = 1;
function objectId(value: object | undefined): number {if (!value) return 0; const existing = ids.get(value); if (existing) return existing; const id = sequence++; ids.set(value, id); return id;}
const message = (error: unknown) => error instanceof Error ? error.message : "The Admin overview could not be loaded.";
function resource<T>(query: {data: T | undefined;isPending: boolean;isFetching: boolean;error: Error | null}, enabled: boolean): AdminResource<T> {
  return {data: enabled && !query.error ? query.data ?? null : null, loading: enabled && (query.isPending || query.isFetching), error: enabled && query.error ? message(query.error) : null};
}

/** Read-only overview. Admin access is checked from the authoritative protocol
 * cell, never the provider's editable local whitelist or a cached role label. */
export function useAdminOverview() {
  const signer = ccc.useSigner(), {client: walletClient, signerInfo, open} = ccc.useCcc();
  const protocol = useProtocol();
  const [period, setPeriod] = useState<AdminPeriod>("weekly"), [revision, setRevision] = useState(0);
  const configuration = useMemo(() => {
    try {const network = currentDeployment.getCurrentNetwork(); return {network, client: getDiscoveryReadClient(network), error: null};}
    catch (error) {return {network: null, client: null, error: message(error)};}
  }, [walletClient]);
  const protocolCell = protocol.protocolCell;
  const protocolKey = protocolCell ? `${protocolCell.cellOutput.type?.hash()}:${protocolCell.outPoint.txHash}:${protocolCell.outPoint.index}:${ccc.hashCkb(protocolCell.outputData)}` : "pending";
  const sessionKey = [objectId(signer), objectId(signerInfo), objectId(walletClient), objectId(configuration.client ?? undefined), configuration.network, protocolKey, revision].join(":");
  const currentSession = useRef(sessionKey); currentSession.current = sessionKey;
  const rootKey = ["revamp-admin-overview", sessionKey] as const;
  const scopeEnabled = Boolean(signer && protocolCell && !protocol.isLoading && !protocol.error && configuration.client);
  const scopeQuery = useQuery<ProfileReadScope, Error>({
    queryKey: [...rootKey, "scope"], enabled: scopeEnabled, retry: false, staleTime: 30_000, refetchOnWindowFocus: true,
    queryFn: ({signal}) => withProfileDeadline(async () => {
      if (!signer || !protocolCell || !configuration.client || !configuration.network) throw new Error("Connect a wallet and load the current protocol.");
      const address = await signer.getRecommendedAddressObj();
      if (currentSession.current !== sessionKey) throw new Error("The wallet or protocol changed.");
      return makeProfileReadScope(configuration.client, protocolCell, address, configuration.network);
    }, signal, 12_000),
  });
  const scope = scopeEnabled ? scopeQuery.data ?? null : null;
  const error = protocol.error ?? configuration.error ?? (scopeQuery.error ? message(scopeQuery.error) : null);
  const allowed = Boolean(scope && isOverviewAdmin(scope));
  const access: AdminOverviewAccess = !signer ? "disconnected" : error ? "error" : !scope ? "checking" : allowed ? "allowed" : "denied";
  const key = [...rootKey, scope?.protocolHash ?? null, scope?.lockHash ?? null] as const;
  const current = useRef({sessionKey, signer, scope}); current.current = {sessionKey, signer, scope};
  async function guard(captured = current.current) {
    if (!captured.scope || !captured.signer || current.current.sessionKey !== captured.sessionKey || current.current.signer !== captured.signer || !isOverviewAdmin(captured.scope)) throw new Error("The current wallet is not authorized for this overview.");
    const lockHash = (await captured.signer.getRecommendedAddressObj()).script.hash().toLowerCase();
    if (current.current.sessionKey !== captured.sessionKey || lockHash !== captured.scope.lockHash.toLowerCase()) {
      if (current.current.sessionKey === captured.sessionKey) setRevision(value => value + 1);
      throw new Error("The wallet account changed. Reopen the Admin overview.");
    }
  }
  const recordsQuery = useQuery({
    queryKey: [...key, "current-records"], enabled: allowed, retry: shouldRetryDiscovery, staleTime: 30_000, refetchOnWindowFocus: false,
    queryFn: ({signal}) => withProfileDeadline(async signal => {const captured = current.current; await guard(captured); const result = await readAdminCurrentSnapshot(scope!, signal); await guard(captured); return result;}, signal, 20_000),
  });
  const snapshot = allowed && !recordsQuery.error ? recordsQuery.data ?? null : null;
  const fundingQuery = useQuery({
    queryKey: [...key, "funding", recordsQuery.dataUpdatedAt], enabled: Boolean(allowed && snapshot), retry: shouldRetryDiscovery, staleTime: 30_000, refetchOnWindowFocus: false,
    queryFn: ({signal}) => withProfileDeadline(async signal => {const captured = current.current; await guard(captured); const result = await readAdminFunding(scope!, snapshot!, signal); await guard(captured); return result;}, signal, 20_000),
  });
  // Historical proof is independent of the current records, action links and
  // funding. Changing the selected rolling period only reloads this query.
  const metricsQuery = useQuery({
    queryKey: [...key, "period", period, recordsQuery.dataUpdatedAt], enabled: Boolean(allowed && snapshot), retry: false, staleTime: 30_000, refetchOnWindowFocus: false,
    queryFn: ({signal}) => withProfileDeadline(async signal => {const captured = current.current; await guard(captured); const result = await readAdminOverviewMetrics(scope!, snapshot!, period, signal); await guard(captured); return result;}, signal, 20_000),
  });
  const currentResource = resource(recordsQuery, allowed);
  let actionsData: AdminActionItem[] | null = null, activityData: AdminActivityItem[] | null = null, recordsError = currentResource.error;
  try {if (scope && snapshot) {actionsData = adminNeedActions(scope, snapshot); activityData = adminRecordedActivity(scope, snapshot);}}
  catch (error) {recordsError = message(error);}
  const actions: AdminResource<AdminActionItem[]> = {data: recordsError ? null : actionsData, loading: currentResource.loading, error: recordsError};
  const activity: AdminResource<AdminActivityItem[]> = {data: recordsError ? null : activityData, loading: currentResource.loading, error: recordsError};
  const funding = resource(fundingQuery, Boolean(allowed && snapshot));
  if (allowed && recordsError) funding.error = recordsError;
  const metrics = resource(metricsQuery, Boolean(allowed && snapshot));
  if (allowed && recordsError) metrics.error = recordsError;
  return {access, error, period, onPeriodChange: (value: AdminPeriod) => setPeriod(value), metrics, actions, funding, activity,
    protocolTypeHash: scope?.protocolHash ?? null,
    metricsDescription: metrics.data?.coverageNote ?? "Rolling 7/90/365-day periods. Only verified registration births and current campaign creation records are counted; complete participant history is unavailable.",
    currentDataDescription: "Current campaign and tip records and funding only. Activity shows up to 20 current record timestamps, not inferred approval events or a complete transaction ledger.",
    onConnect: open, onRetry: () => {setRevision(value => value + 1); void protocol.refreshProtocolData().catch(() => {});},
    onRetryMetrics: () => {if (allowed && snapshot) void metricsQuery.refetch();}, onRetryActions: () => {if (allowed) void recordsQuery.refetch();},
    onRetryFunding: () => {if (allowed && snapshot) void fundingQuery.refetch(); else if (allowed) void recordsQuery.refetch();},
    onRetryActivity: () => {if (allowed) void recordsQuery.refetch();},
  };
}
