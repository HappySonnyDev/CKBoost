"use client";

import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ccc } from "@ckb-ccc/connector-react";
import { useProtocol } from "@/lib/providers/protocol-provider";
import { usePendingTransactions } from "@/lib/providers/pending-transaction-provider";
import { currentDeployment } from "@/lib/ckb/current-deployment";
import { createContributorSigner } from "./contributor-transaction";
import { getDiscoveryReadClient } from "./discovery-read-client";
import { shouldRetryDiscovery } from "./discovery-loader";
import { makeProfileReadScope, profileRoleLabel, readProfileCampaigns, readProfileIdentity, readProfilePoints, readProfileRewards, withProfileDeadline,
  type ProfileCampaignRow, type ProfileResource, type ProfileReadScope } from "./profile-model";

const objectIds = new WeakMap<object, number>();
let nextId = 1;
const objectId = (value: object | undefined): number => {
  if (!value) return 0;
  const saved = objectIds.get(value); if (saved) return saved;
  const id = nextId++; objectIds.set(value, id); return id;
};
const message = (error: unknown) => error instanceof Error ? error.message : "The profile could not be loaded. Please retry.";
interface QueryState<T> {data: T | undefined; isPending: boolean; isFetching: boolean; error: Error | null}
function resource<T>(query: QueryState<T>, enabled: boolean): ProfileResource<T> {
  return {data: enabled && !query.error ? query.data ?? null : null, loading: enabled && (query.isPending || query.isFetching), error: enabled && query.error ? message(query.error) : null};
}
export type ProfileNamePhase = "idle" | "signing" | "confirming" | "confirmed" | "error";
export type ProfileStatus = "disconnected" | "loading" | "ready" | "no-user" | "error";

/** Current scoped chain facts only. No legacy UserProvider/CampaignProvider,
 * transaction-history provider or Nostr body fetch is mounted here. */
export function useProfileWorkspace() {
  const signer = ccc.useSigner();
  const {client: walletClient, signerInfo, open} = ccc.useCcc();
  const {protocolCell, isLoading: protocolLoading, error: protocolError, refreshProtocolData} = useProtocol();
  const {confirmationTarget} = usePendingTransactions();
  const queryClient = useQueryClient();
  const [rewardsRequested, setRewardsRequested] = useState(false);
  const [revision, setRevision] = useState(0);
  const [nameOperation, setNameOperation] = useState<{scopeKey: string;phase: ProfileNamePhase;txHash?: ccc.Hex;error?: string} | null>(null);
  const nameInFlight = useRef(new Set<string>());
  const pendingNames = useRef(new Map<string, {name: string;txHash: ccc.Hex}>());
  const configuration = useMemo(() => {
    try {
      const network = currentDeployment.getCurrentNetwork();
      const client = getDiscoveryReadClient(network);
      return {network, client, error: null};
    } catch (error) { return {network: null, client: null, error: message(error)}; }
  }, [walletClient]);
  const protocolKey = protocolCell ? `${protocolCell.cellOutput.type?.hash()}:${protocolCell.outPoint.txHash}:${protocolCell.outPoint.index}:${ccc.hashCkb(protocolCell.outputData)}` : "pending";
  const sessionKey = [objectId(signer), objectId(signerInfo), objectId(walletClient), objectId(configuration.client ?? undefined), configuration.network, protocolKey, revision].join(":");
  const currentSession = useRef(sessionKey); currentSession.current = sessionKey;
  const rootKey = ["revamp-profile", sessionKey] as const;
  const scopeEnabled = Boolean(signer && protocolCell && !protocolLoading && !protocolError && configuration.client);
  const scopeQuery = useQuery<ProfileReadScope, Error>({
    queryKey: [...rootKey, "scope"], enabled: scopeEnabled, staleTime: 30_000, retry: false, refetchOnWindowFocus: true,
    queryFn: ({signal}) => withProfileDeadline(async () => {
      if (!signer || !protocolCell || !configuration.client || !configuration.network) throw new Error("Connect the wallet and load the current protocol.");
      const address = await signer.getRecommendedAddressObj();
      if (currentSession.current !== sessionKey) throw new Error("The wallet or protocol changed.");
      return makeProfileReadScope(configuration.client, protocolCell, address, configuration.network);
    }, signal, 12_000),
  });
  const scope = scopeEnabled ? scopeQuery.data ?? null : null;
  const key = [...rootKey, scope?.protocolHash ?? null, scope?.lockHash ?? null] as const;
  const scopeKey = JSON.stringify(key);
  // Stable across refreshes, protocol outpoint updates and client replacement:
  // those change read snapshots, not the identity of an outstanding operation.
  const operationKey = scope ? JSON.stringify([scope.network, scope.protocolHash, scope.lockHash]) : "unresolved-wallet";
  const currentScope = useRef({sessionKey, scopeKey, signer, scope}); currentScope.current = {sessionKey, scopeKey, signer, scope};
  async function assertCurrent(captured = currentScope.current) {
    if (!captured.signer || !captured.scope || currentScope.current.sessionKey !== captured.sessionKey || currentScope.current.scopeKey !== captured.scopeKey || currentScope.current.signer !== captured.signer) throw new Error("The wallet or protocol changed. Reopen the current profile.");
    const lockHash = (await captured.signer.getRecommendedAddressObj()).script.hash().toLowerCase();
    if (currentScope.current.sessionKey !== captured.sessionKey || currentScope.current.scopeKey !== captured.scopeKey || lockHash !== captured.scope.lockHash.toLowerCase()) {
      if (currentScope.current.sessionKey === captured.sessionKey) setRevision(value => value + 1);
      throw new Error("The wallet account changed. Reload the current profile.");
    }
  }
  const identityQuery = useQuery({
    queryKey: [...key, "identity"], enabled: Boolean(scope), staleTime: 30_000, refetchOnWindowFocus: false, retry: shouldRetryDiscovery,
    queryFn: ({signal}) => withProfileDeadline(async signal => {const captured = currentScope.current; await assertCurrent(captured); const result = await readProfileIdentity(scope!, signal); await assertCurrent(captured); return result;}, signal),
  });
  const pointsQuery = useQuery({
    queryKey: [...key, "points"], enabled: Boolean(scope), staleTime: 30_000, refetchOnWindowFocus: false, retry: shouldRetryDiscovery,
    queryFn: ({signal}) => withProfileDeadline(async signal => {const captured = currentScope.current; await assertCurrent(captured); const result = await readProfilePoints(scope!, signal); await assertCurrent(captured); return result;}, signal),
  });
  const identity = scope && !identityQuery.error ? identityQuery.data ?? null : null;
  const campaignsEnabled = Boolean(scope && identity);
  const campaignsQuery = useQuery({
    queryKey: [...key, "campaigns", identity?.userCell?.outPoint.txHash ?? "no-user", identity?.userCell?.outPoint.index ?? null], enabled: campaignsEnabled,
    staleTime: 30_000, refetchOnWindowFocus: false, retry: shouldRetryDiscovery,
    queryFn: ({signal}) => withProfileDeadline(async signal => {const captured = currentScope.current; await assertCurrent(captured); const result = await readProfileCampaigns(scope!, identity!, signal); await assertCurrent(captured); return result;}, signal, 25_000),
  });
  const rewardsQuery = useQuery({
    queryKey: [...key, "rewards"], enabled: Boolean(scope && rewardsRequested), staleTime: 30_000, refetchOnWindowFocus: false, retry: false,
    queryFn: ({signal}) => withProfileDeadline(async signal => {const captured = currentScope.current; await assertCurrent(captured); const result = await readProfileRewards(scope!, signal); await assertCurrent(captured); return result;}, signal),
  });
  const points = resource(pointsQuery, Boolean(scope));
  const campaignResource = resource(campaignsQuery, campaignsEnabled);
  const campaigns: ProfileResource<{participated: ProfileCampaignRow[];created: ProfileCampaignRow[]}> = {...campaignResource, data: campaignResource.data ? {participated: campaignResource.data.participated, created: campaignResource.data.created} : null};
  const activities = {...campaignResource, data: campaignResource.data?.activities ?? null};
  const rewards = resource(rewardsQuery, Boolean(scope && rewardsRequested));
  async function onSaveName(name: string): Promise<void> {
    if (nameInFlight.current.has(operationKey)) throw new Error("A profile update is already in progress.");
    const trimmed = name.trim(); if (!trimmed || trimmed.length > 80) throw new Error("Enter a display name of 1–80 characters.");
    const captured = currentScope.current;
    const pending = pendingNames.current.get(operationKey);
    if (pending && pending.name !== trimmed) throw new Error("A name transaction is still awaiting confirmation. Check it before sending another name.");
    nameInFlight.current.add(operationKey);
    try {
      await assertCurrent(captured);
      setNameOperation({scopeKey: operationKey, phase: "signing"});
      // Preserve the existing update_verification_data recipe and proxy policy.
      // The guard checks this account again at the wallet send and client broadcast.
      let txHash = pending?.txHash;
      if (!txHash) {
        const {UserService} = await import("@/lib/services/user-service");
        await assertCurrent(captured);
        const service = new UserService(createContributorSigner(captured.signer!, () => assertCurrent(captured), () => {}),
          ccc.hexFrom(captured.scope!.protocol.protocol_config.script_code_hashes.ckb_boost_user_type_code_hash), captured.scope!.protocolHash, true);
        txHash = await service.updateProfileDisplayName(trimmed);
        pendingNames.current.set(operationKey, {name: trimmed, txHash});
      }
      await assertCurrent(captured);
      setNameOperation({scopeKey: operationKey, phase: "confirming", txHash});
      const committed = await captured.signer!.client.waitTransaction(txHash, confirmationTarget, 300_000, 2_000);
      if (!committed) throw new Error("The name transaction is not confirmed yet. Check the transaction before resubmitting.");
      await assertCurrent(captured);
      // Return only after a fresh indexed user cell shows the committed name.
      const updated = await withProfileDeadline(signal => readProfileIdentity(captured.scope!, signal));
      if (updated.displayName !== trimmed) throw new Error("The transaction committed, but the updated name is not indexed yet. Refresh before resubmitting.");
      await assertCurrent(captured);
      queryClient.setQueryData([...key, "identity"], updated);
      void queryClient.invalidateQueries({queryKey: [...key, "campaigns"]});
      pendingNames.current.delete(operationKey);
      setNameOperation({scopeKey: operationKey, phase: "confirmed", txHash});
    } catch (error) {
      if (currentScope.current.scopeKey === scopeKey) setNameOperation(previous => ({scopeKey: operationKey, phase: "error", txHash: previous?.txHash, error: message(error)}));
      throw error;
    } finally {nameInFlight.current.delete(operationKey);}
  }
  const error = protocolError ?? configuration.error ?? (scopeQuery.error ? message(scopeQuery.error) : null) ?? (identityQuery.error ? message(identityQuery.error) : null);
  const status: ProfileStatus = !signer ? "disconnected" : error ? "error" : !scope || !identity ? "loading" : !identity.userCell ? "no-user" : "ready";
  return {status, error, identity, roleLabel: scope ? profileRoleLabel(scope, campaignResource.data?.reviewerAssigned) : null,
    points, campaigns, activities, rewards, approvedPoints: campaignResource.data?.approvedPoints ?? null,
    approvedPointsLabel: "Current approved quest Points, including unclaimed rewards; not spendable wallet balance.",
    rewardsLabel: "Positive Points changes within up to 20 matching wallet transactions; not complete earnings history.",
    nameOperation: nameOperation?.scopeKey === operationKey ? nameOperation : null,
    onConnect: open, onRetry: () => {setRevision(value => value + 1); void refreshProtocolData().catch(() => {});},
    onRetryPoints: () => {void pointsQuery.refetch();}, onRetryCampaigns: () => {void campaignsQuery.refetch();}, onRetryActivities: () => {void campaignsQuery.refetch();},
    onRetryRewards: () => {setRewardsRequested(true); void rewardsQuery.refetch();},
    onTabChange: (tab: "campaigns" | "activities" | "rewards") => {if (tab === "rewards") setRewardsRequested(true);}, onSaveName,
  };
}
