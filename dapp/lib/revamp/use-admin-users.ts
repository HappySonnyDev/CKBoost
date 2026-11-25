"use client";

import {useMemo, useRef, useState} from "react";
import {useQuery, useQueryClient} from "@tanstack/react-query";
import {ccc} from "@ckb-ccc/connector-react";
import {useProtocol} from "@/lib/providers/protocol-provider";
import {usePendingTransactions} from "@/lib/providers/pending-transaction-provider";
import {currentDeployment} from "@/lib/ckb/current-deployment";
import {getDiscoveryReadClient} from "./discovery-read-client";
import {readDiscoveryProtocol} from "./discovery-cells";
import {shouldRetryDiscovery} from "./discovery-loader";
import {isOverviewAdmin, type AdminResource} from "./admin-overview-model";
import {makeProfileReadScope, readProfileCampaigns, readProfilePoints, readProfileRewards, withProfileDeadline, type ProfileReadScope} from "./profile-model";
import {readProfileBadges} from "./profile-badges";
import {createContributorSigner} from "./contributor-transaction";
import {observeAdminTransactionAttempt} from "./admin-pending-transaction";
import {assertCreationEditDeployment} from "./creation-deployment";
import {ADMIN_USERS_PAGE_SIZE, adminTargetProfile, applyAdminManualVerifications, filterAdminUsers, makeAdminAccessPlan, makeAdminVerificationPayload, readAdminUser, readAdminUserJoinDates, readAdminUsers,
  type AdminAccessPlan, type AdminUserRecord, type AdminUserRole, type AdminUsersRegistryAdapter, type AdminUserVerification} from "./admin-users-model";

const objectIds = new WeakMap<object, number>(); let nextId = 0;
const id = (value: object | null | undefined) => {if (!value) return 0; const previous = objectIds.get(value); if (previous) return previous; const next = ++nextId; objectIds.set(value, next); return next;};
const message = (error: unknown) => error instanceof Error ? error.message : "The user request could not be completed.";
const pendingAccess = new Map<string, {plan: AdminAccessPlan; transactionHash: ccc.Hex}>();
const busyAccess = new Set<string>();
function resource<T>(query: {data: T | undefined;isPending: boolean;isFetching: boolean;error: Error | null}, enabled: boolean): AdminResource<T> {
  return {data: enabled && !query.error ? query.data ?? null : null, loading: enabled && (query.isPending || query.isFetching), error: enabled && query.error ? message(query.error) : null};
}
export type AdminUsersAccess = "disconnected" | "checking" | "allowed" | "denied" | "error";
export function useAdminUsers({userId, registry}: {userId?: string; registry?: AdminUsersRegistryAdapter} = {}) {
  const signer = ccc.useSigner(), {client: walletClient, signerInfo, open} = ccc.useCcc();
  const protocol = useProtocol(), {confirmationTarget} = usePendingTransactions(), queryClient = useQueryClient();
  const [revision, setRevision] = useState(0), [search, setSearch] = useState(""), [role, setRole] = useState<AdminUserRole | "all">("all"), [verification, setVerification] = useState<AdminUserVerification>("all"), [page, setPage] = useState(0), [rewardsRequested, setRewardsRequested] = useState<string | null>(null);
  const [operation, setOperation] = useState<{key: string; phase: "signing" | "confirming" | "confirmed" | "error"; transactionHash?: string; error?: string} | null>(null);
  const busy = useRef(busyAccess), pending = useRef(pendingAccess);
  const configuration = useMemo(() => {try {const network = currentDeployment.getCurrentNetwork(); return {network, client: getDiscoveryReadClient(network), error: null};} catch (error) {return {network: null, client: null, error: message(error)};}}, [walletClient]);
  const cell = protocol.protocolCell, protocolKey = cell ? `${cell.cellOutput.type?.hash()}:${cell.outPoint.txHash}:${cell.outPoint.index}:${ccc.hashCkb(cell.outputData)}` : "pending";
  const session = [id(signer), id(signerInfo), id(walletClient), id(configuration.client), configuration.network, protocolKey, userId, revision].join(":");
  const currentSession = useRef(session); currentSession.current = session;
  const rootKey = ["revamp-admin-users", session] as const;
  const scopeEnabled = Boolean(signer && cell && configuration.client && !protocol.isLoading && !protocol.error);
  const scopeQuery = useQuery<ProfileReadScope, Error>({queryKey: [...rootKey, "scope"], enabled: scopeEnabled, retry: false, staleTime: 30_000,
    queryFn: ({signal}) => withProfileDeadline(async () => {if (!signer || !cell || !configuration.client || !configuration.network) throw new Error("Connect an Admin wallet first."); const address = await signer.getRecommendedAddressObj(); if (currentSession.current !== session) throw new Error("The account changed."); return makeProfileReadScope(configuration.client, cell, address, configuration.network);}, signal, 12_000)});
  const scope = scopeEnabled ? scopeQuery.data ?? null : null, allowed = Boolean(scope && isOverviewAdmin(scope));
  const error = protocol.error ?? configuration.error ?? (scopeQuery.error ? message(scopeQuery.error) : null);
  const access: AdminUsersAccess = !signer ? "disconnected" : error ? "error" : !scope ? "checking" : allowed ? "allowed" : "denied";
  const key = [...rootKey, scope?.protocolHash, scope?.lockHash] as const;
  const current = useRef({session, signer, scope}); current.current = {session, signer, scope};
  async function guard(captured = current.current) {
    if (!captured.scope || !captured.signer || current.current.session !== captured.session || current.current.signer !== captured.signer || !isOverviewAdmin(captured.scope)) throw new Error("The Admin wallet or protocol changed.");
    const actual = (await captured.signer.getRecommendedAddressObj()).script.hash();
    if (current.current.session !== captured.session || actual !== captured.scope.lockHash) {if (current.current.session === captured.session) setRevision(value => value + 1); throw new Error("The wallet account changed. Reload Users.");}
  }
  async function guarded<T>(read: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, milliseconds = 20_000): Promise<T> {const captured = current.current; return withProfileDeadline(async active => {await guard(captured); const result = await read(active); await guard(captured); return result;}, signal, milliseconds);}
  const recordsQuery = useQuery({queryKey: [...key, "records"], enabled: allowed, staleTime: 30_000, retry: shouldRetryDiscovery, refetchOnWindowFocus: false,
    queryFn: ({signal}) => guarded(async active => {if (!userId) return readAdminUsers(scope!, active); const record = await readAdminUser(scope!, userId, active); return record ? [record] : [];}, signal)});
  const registryQuery = useQuery({queryKey: [...key, "manual", id(registry)], enabled: Boolean(allowed && registry), retry: false, staleTime: 30_000, refetchOnWindowFocus: false,
    queryFn: ({signal}) => guarded(active => registry!.read(scope!, active), signal)});
  let rows: AdminUserRecord[] | null = null, recordsError = recordsQuery.error ? message(recordsQuery.error) : null;
  try {if (allowed && scope && recordsQuery.data && !recordsError) rows = applyAdminManualVerifications(scope, recordsQuery.data, registryQuery.error ? null : registryQuery.data ?? null);} catch (error) {recordsError = message(error);}
  const filtered = rows ? filterAdminUsers(rows, search, role, verification) : null, actualPage = Math.min(page, Math.max(0, Math.ceil((filtered?.length ?? 0) / ADMIN_USERS_PAGE_SIZE) - 1));
  const visible = filtered?.slice(actualPage * ADMIN_USERS_PAGE_SIZE, (actualPage + 1) * ADMIN_USERS_PAGE_SIZE) ?? [], target = userId ? rows?.[0] ?? null : null;
  const datesKey = visible.map(record => `${record.id}:${record.cell.outPoint.txHash}:${record.cell.outPoint.index}`).join(",");
  const datesQuery = useQuery({queryKey: [...key, "births", datesKey], enabled: Boolean(allowed && visible.length), retry: false, staleTime: 120_000, refetchOnWindowFocus: false,
    queryFn: ({signal}) => guarded(active => readAdminUserJoinDates(scope!, visible, active), signal)});
  const targetKey = target ? `${target.typeHash}:${target.cell.outPoint.txHash}:${ccc.hashCkb(target.cell.outputData)}` : null;
  const rewardsKey = `${session}:${targetKey}`;
  const campaignsQuery = useQuery({queryKey: [...key, "campaigns", targetKey], enabled: Boolean(allowed && target), retry: shouldRetryDiscovery, staleTime: 30_000, refetchOnWindowFocus: false,
    queryFn: ({signal}) => guarded(active => {const subject = adminTargetProfile(scope!, target!); return readProfileCampaigns(subject.scope, subject.identity, active);}, signal)});
  const pointsQuery = useQuery({queryKey: [...key, "wallet-points", targetKey], enabled: Boolean(allowed && target), retry: shouldRetryDiscovery, staleTime: 30_000, refetchOnWindowFocus: false,
    queryFn: ({signal}) => guarded(active => readProfilePoints(adminTargetProfile(scope!, target!).scope, active), signal)});
  const badgesQuery = useQuery({queryKey: [...key, "badges", targetKey], enabled: Boolean(allowed && target), retry: false, staleTime: 30_000, refetchOnWindowFocus: false,
    queryFn: ({signal}) => guarded(() => readProfileBadges({client: scope!.client, protocolCell: scope!.protocolCell, identity: target!, isCurrent: () => current.current.session === session}), signal)});
  const rewardsQuery = useQuery({queryKey: [...key, "rewards", targetKey], enabled: Boolean(allowed && target && rewardsRequested === rewardsKey), retry: false, staleTime: 30_000, refetchOnWindowFocus: false,
    queryFn: ({signal}) => guarded(active => readProfileRewards(adminTargetProfile(scope!, target!).scope, active), signal)});
  async function freshScope(captured = current.current): Promise<ProfileReadScope> {await guard(captured); const latest = await withProfileDeadline(signal => readDiscoveryProtocol(captured.scope!.client, captured.scope!.protocolCell.cellOutput.type!, signal)); await guard(captured); const address = await captured.signer!.getRecommendedAddressObj(); const fresh = makeProfileReadScope(captured.scope!.client, latest, address, captured.scope!.network); if (!isOverviewAdmin(fresh) || fresh.protocolHash !== captured.scope!.protocolHash) throw new Error("Admin access is no longer granted in this protocol."); return fresh;}
  async function assertQaWrite(fresh: ProfileReadScope) {const {getIsolatedRuntime} = await import("@/lib/ckb/isolated-runtime.mjs"); const runtime = getIsolatedRuntime(); if (!runtime || fresh.network !== "testnet" || runtime.network !== "testnet" || runtime.protocol.typeHash !== fresh.protocolHash) throw new Error("Access changes are enabled only for the explicitly configured isolated Testnet QA protocol. Production access is unchanged.");}
  async function previewAccess(walletAddress: string, selectedRole: AdminUserRole): Promise<AdminAccessPlan> {
    const fresh = await freshScope(); await assertQaWrite(fresh); const wallet = await ccc.Address.fromString(walletAddress.trim(), fresh.client);
    if (selectedRole === "organizer") assertCreationEditDeployment(false, fresh.protocolCell.cellOutput.lock.codeHash);
    return makeAdminAccessPlan(fresh, wallet, selectedRole);
  }
  async function changeAccess(plan: AdminAccessPlan): Promise<void> {
    const captured = current.current; await guard(captured); await assertQaWrite(captured.scope!); const operationKey = `${captured.scope!.network}:${captured.scope!.protocolHash}:${captured.scope!.lockHash}:${plan.walletLockHash}`;
    if (busy.current.has(operationKey)) throw new Error("An access update for this wallet is already in progress."); busy.current.add(operationKey);
    try {
      const waiting = pending.current.get(operationKey); if (waiting && waiting.plan.role !== plan.role) throw new Error("A different access change is still awaiting confirmation. Confirm it before sending another.");
      let txHash = waiting?.transactionHash;
      if (!txHash) {
        const fresh = await freshScope(captured); await assertQaWrite(fresh); if (fresh.protocolHash !== plan.protocolTypeHash || `${fresh.protocolCell.outPoint.txHash}:${fresh.protocolCell.outPoint.index}` !== plan.protocolOutPoint || ccc.hashCkb(fresh.protocolCell.outputData) !== plan.protocolDataHash) throw new Error("Protocol permissions changed after preview. Review the new changes before signing.");
        const rebuilt = makeAdminAccessPlan(fresh, await ccc.Address.fromString(plan.walletAddress, fresh.client), plan.role);
        if (rebuilt.walletLockHash !== plan.walletLockHash || JSON.stringify(rebuilt.changes) !== JSON.stringify(plan.changes)) throw new Error("The access preview changed. Review it again.");
        if (plan.role === "organizer") assertCreationEditDeployment(false, fresh.protocolCell.cellOutput.lock.codeHash);
        const {ProtocolService} = await import("@/lib/services/protocol-service"); const {ProtocolData} = await import("ssri-ckboost/types"); await guard(captured);
        const observed = observeAdminTransactionAttempt(captured.signer!, async actual => {
          const latest = await freshScope(captured); await assertQaWrite(latest);
          if (`${latest.protocolCell.outPoint.txHash}:${latest.protocolCell.outPoint.index}` !== plan.protocolOutPoint || ccc.hashCkb(latest.protocolCell.outputData) !== plan.protocolDataHash) throw new Error("Protocol permissions changed before submission. Review them again.");
          const outputs = actual.outputs.flatMap((output,index) => output.type?.eq(latest.protocolCell.cellOutput.type!) ? [index] : []);
          if (!actual.inputs.some(input => input.previousOutput.eq(latest.protocolCell.outPoint)) || outputs.length !== 1 || actual.outputsData[outputs[0]] !== ccc.hexFrom(ProtocolData.encode(rebuilt.updated))) throw new Error("The access transaction changed before submission. Review it again.");
          const {assertActorNetCapacitySpend} = await import("ssri-ckboost"); await assertActorNetCapacitySpend(captured.signer!,actual,captured.scope!.lockHash);
          const prior = pending.current.get(operationKey); if (prior && prior.transactionHash !== actual.hash()) throw new Error(`An access transaction was already attempted: ${prior.transactionHash}. Confirm it before signing another body.`);
          pending.current.set(operationKey,{plan,transactionHash:actual.hash()}); setOperation({key:operationKey,phase:"confirming",transactionHash:actual.hash()});
        });
        const service = new ProtocolService(createContributorSigner(observed, () => guard(captured), () => {}),{allowFeeRetry:false});
        const serviceCell = await service.getProtocolCell();
        if (!serviceCell.cellOutput.type?.eq(fresh.protocolCell.cellOutput.type!) || `${serviceCell.outPoint.txHash}:${serviceCell.outPoint.index}` !== plan.protocolOutPoint || ccc.hashCkb(serviceCell.outputData) !== plan.protocolDataHash) throw new Error("The write service resolved a different protocol snapshot. Reload before signing.");
        setOperation({key: operationKey, phase: "signing"}); txHash = await service.updateProtocol(rebuilt.updated); const attempted = pending.current.get(operationKey); if (attempted && attempted.transactionHash !== txHash) throw new Error("The wallet returned a different access transaction ID. Inspect the recorded transaction before retrying."); pending.current.set(operationKey, {plan, transactionHash: txHash});
      }
      await guard(captured); setOperation({key: operationKey, phase: "confirming", transactionHash: txHash});
      const committed = await captured.signer!.client.waitTransaction(txHash, confirmationTarget, 300_000, 2_000); if (!committed) throw new Error("The access transaction is not confirmed. Retry confirmation before resubmitting.");
      await guard(captured); const latest = await withProfileDeadline(signal => readDiscoveryProtocol(captured.scope!.client, captured.scope!.protocolCell.cellOutput.type!, signal));
      const {ProtocolData} = await import("ssri-ckboost/types"); const data = ProtocolData.decode(latest.outputData);
      const admin = data.protocol_config.admin_lock_hash_vec.some(value => ccc.hexFrom(value) === plan.walletLockHash), organizer = data.endorsers_whitelist.some(value => ccc.hexFrom(value.endorser_lock_hash) === plan.walletLockHash);
      if (admin !== (plan.role === "platform-admin") || organizer !== (plan.role === "organizer")) throw new Error("The confirmed access change is not indexed yet. Retry confirmation before sending again.");
      pending.current.delete(operationKey); setOperation({key: operationKey, phase: "confirmed", transactionHash: txHash});
      await queryClient.invalidateQueries({queryKey: ["revamp-admin-users"]}); await protocol.refreshProtocolData();
    } catch (error) {const attempted = pending.current.get(operationKey); const detail = attempted ? `${message(error)} Pending transaction: ${attempted.transactionHash}. Retry confirmation before signing again.` : message(error); if (current.current.session === captured.session) setOperation(previous => ({key: operationKey, phase: "error", transactionHash: attempted?.transactionHash ?? previous?.transactionHash, error: detail})); throw new Error(detail);} finally {busy.current.delete(operationKey);}
  }
  async function verifyIdentity(record: AdminUserRecord): Promise<void> {
    const captured = current.current; if (!registry || !registryQuery.data?.available) throw new Error(registryQuery.data?.unavailableReason ?? "Manual verification requires the scoped Admin registry capability. This deployment is not ready yet.");
    const fresh = await freshScope(captured), actual = await withProfileDeadline(signal => readAdminUser(fresh, record.id, signal));
    if (!actual || actual.typeHash !== record.typeHash || actual.lockHash !== record.lockHash || actual.cell.outPoint.txHash !== record.cell.outPoint.txHash || actual.cell.outPoint.index !== record.cell.outPoint.index || ccc.hashCkb(actual.cell.outputData) !== ccc.hashCkb(record.cell.outputData)) throw new Error("The user changed after this verification preview. Reopen it before saving.");
    await registry.save(fresh, captured.signer!, makeAdminVerificationPayload(fresh, actual), () => guard(captured));
    await guard(captured); await registryQuery.refetch(); await recordsQuery.refetch();
  }
  return {access, error, viewerLockHash: scope?.lockHash ?? null, protocolTypeHash: scope?.protocolHash ?? null,
    users: {data: rows, loading: allowed && (recordsQuery.isPending || recordsQuery.isFetching), error: allowed ? recordsError : null} as AdminResource<AdminUserRecord[]>,
    visible, filteredCount: filtered?.length ?? null, page: actualPage, pageSize: ADMIN_USERS_PAGE_SIZE,
    search, role, verification, onSearch: (value: string) => {setSearch(value); setPage(0);}, onRole: (value: AdminUserRole | "all") => {setRole(value); setPage(0);}, onVerification: (value: AdminUserVerification) => {setVerification(value); setPage(0);}, onPage: setPage,
    joined: resource(datesQuery, Boolean(allowed && visible.length)), target,
    campaigns: resource(campaignsQuery, Boolean(allowed && target)), points: resource(pointsQuery, Boolean(allowed && target)), badges: resource(badgesQuery, Boolean(allowed && target)), rewards: resource(rewardsQuery, Boolean(allowed && target && rewardsRequested === rewardsKey)),
    manualAvailable: Boolean(allowed && registryQuery.data?.available), manualLoading: allowed && Boolean(registry) && (registryQuery.isPending || registryQuery.isFetching),
    manualUnavailableReason: registryQuery.error ? message(registryQuery.error) : registryQuery.data?.unavailableReason ?? "Manual verification requires the scoped Admin registry capability. It is not deployed for this protocol yet.",
    operation: operation?.key.startsWith(`${scope?.network}:${scope?.protocolHash}:${scope?.lockHash}:`) ? operation : null,
    previewAccess, changeAccess, verifyIdentity, onConnect: open,
    onRetry: () => {setRevision(value => value + 1); void protocol.refreshProtocolData().catch(() => {});},
    onRetryDates: () => {void datesQuery.refetch();}, onRetryCampaigns: () => {void campaignsQuery.refetch();}, onRetryPoints: () => {void pointsQuery.refetch();}, onRetryBadges: () => {void badgesQuery.refetch();}, onRetryRewards: () => {setRewardsRequested(rewardsKey); void rewardsQuery.refetch();},
    onTabChange: (tab: string) => {if (tab === "rewards") setRewardsRequested(rewardsKey);},
  };
}
