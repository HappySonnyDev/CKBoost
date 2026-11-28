import {ccc} from "@ckb-ccc/connector-react";
import {ProtocolData} from "ssri-ckboost/types";
import {getIsolatedRuntime} from "@/lib/ckb/isolated-runtime.mjs";
import {readDiscoveryProtocol} from "./discovery-cells";
import {readProfilePages, withProfileDeadline, type ProfileReadScope} from "./profile-model";
import {isOverviewAdmin} from "./admin-overview-model";
import {createContributorSigner} from "./contributor-transaction";
import {observeAdminTransactionAttempt} from "./admin-pending-transaction";
import {decodeAdminRegistry, encodeAdminRegistry, registryCanonical, registryHash, type AdminRegistryData, type AdminTipSettings} from "./admin-registry-model";
import type {AdminUsersRegistryAdapter, AdminUserVerificationPayload} from "./admin-users-model";
import type {AdminRewardPeriod} from "./admin-rewards-model";

const MISSING = "This protocol's Admin registry has not been deployed. Manual verification, reward periods and independent tip settings await the final reviewed QA upgrade batch.";
export interface AdminRegistryPin {
  schema: "ckboost-admin-registry-deployment/v1"; network: "testnet"; protocolTypeHash: ccc.Hex;
  typeScript: ccc.ScriptLike; codeTypeScript: ccc.ScriptLike; codeDataHash: ccc.Hex;
}
const point = (cell: ccc.Cell) => `${cell.outPoint.txHash}:${cell.outPoint.index}`;
function pinFor(scope: ProfileReadScope): AdminRegistryPin | null {
  const raw = process.env.NEXT_PUBLIC_CKBOOST_ADMIN_REGISTRY;
  if (!raw) return null;
  if (raw.length > 8192) throw new Error("Invalid Admin registry deployment manifest.");
  const runtime = getIsolatedRuntime();
  if (!runtime || scope.network !== "testnet" || runtime.protocol.typeHash !== scope.protocolHash) throw new Error("Admin registry operations are limited to the explicit isolated QA protocol.");
  const pin = JSON.parse(raw) as AdminRegistryPin;
  const script = ccc.Script.from(pin.typeScript), code = ccc.Script.from(pin.codeTypeScript), args = ccc.bytesFrom(script.args);
  if (pin.schema !== "ckboost-admin-registry-deployment/v1" || pin.network !== scope.network || registryHash(pin.protocolTypeHash) !== scope.protocolHash || script.hashType !== "type" || script.codeHash !== code.hash() || args.length !== 64 || ccc.hexFrom(args.slice(32)) !== scope.protocolHash || code.codeHash !== "0x00000000000000000000000000000000000000000000000000545950455f4944" || code.hashType !== "type" || ccc.bytesFrom(code.args).length !== 32) throw new Error("Admin registry identity does not match this QA protocol.");
  registryHash(pin.codeDataHash); return pin;
}
export interface AdminRegistrySnapshot {
  available: boolean; unavailableReason: string | null; cell: ccc.Cell | null; data: AdminRegistryData | null; transactionHash: ccc.Hex | null;
}
/** Search by the complete manifest-pinned type; bytecode/prefix matches never
 * select an attestation registry. Missing capability cannot become empty data. */
export async function readProtocolAdminRegistry(scope: ProfileReadScope, signal?: AbortSignal): Promise<AdminRegistrySnapshot> {
  if (scope.protocolCell.cellOutput.type?.hash() !== scope.protocolHash || ccc.hexFrom(ProtocolData.encode(scope.protocol)) !== scope.protocolCell.outputData) throw new Error("The protocol registry read scope does not match its canonical current cell.");
  const pin = pinFor(scope); if (!pin) return {available:false,unavailableReason:MISSING,cell:null,data:null,transactionHash:null};
  const script = ccc.Script.from(pin.typeScript), codeType = ccc.Script.from(pin.codeTypeScript);
  const codeCells = (await readProfilePages(scope,{script:codeType,scriptType:"type",scriptSearchMode:"exact",withData:true},`admin-registry-code:${codeType.hash()}`,signal)).filter(cell => cell.cellOutput.type?.eq(codeType));
  if (codeCells.length !== 1 || ccc.hashCkb(codeCells[0].outputData) !== pin.codeDataHash) throw new Error("The registry executable does not match its reviewed deployment manifest.");
  const cells = (await readProfilePages(scope,{script,scriptType:"type",scriptSearchMode:"exact",withData:true},`admin-registry:${scope.protocolHash}:${script.hash()}`,signal)).filter(cell => cell.cellOutput.type?.eq(script));
  if (cells.length !== 1) throw new Error(cells.length ? "The Admin registry is ambiguous." : "The pinned Admin registry is unavailable. No shared registry fallback is allowed.");
  const cell = cells[0];
  if (!cell.cellOutput.lock.eq(script)) throw new Error("The Admin registry has an unexpected authorization lock.");
  const matches = (actual:ccc.Cell|undefined,indexed:ccc.Cell) => Boolean(actual&&actual.outPoint.eq(indexed.outPoint)&&actual.cellOutput.capacity===indexed.cellOutput.capacity&&actual.cellOutput.lock.eq(indexed.cellOutput.lock)&&actual.cellOutput.type?.eq(indexed.cellOutput.type!)&&actual.outputData===indexed.outputData);
  const [live,liveCode] = await Promise.all([cell,codeCells[0]].map(indexed=>withProfileDeadline(()=>scope.client.getCellLive(indexed.outPoint,true),signal)));
  if (!matches(live,cell) || !matches(liveCode,codeCells[0])) throw new Error("The reviewed registry state or executable is no longer live. Reload current policy.");
  const data = decodeAdminRegistry(cell.outputData);
  if (data.protocolTypeHash !== scope.protocolHash) throw new Error("The Admin registry belongs to another protocol.");
  return {available:true,unavailableReason:null,cell,data,transactionHash:cell.outPoint.txHash};
}
/** Administrative consumers keep their role boundary. The public reader above
 * proves identities only; reading on-chain policy never grants an Admin role. */
export async function readAdminRegistry(scope: ProfileReadScope, signal?: AbortSignal): Promise<AdminRegistrySnapshot> {
  if (!isOverviewAdmin(scope)) throw new Error("Only current platform administrators can read the Admin registry.");
  return readProtocolAdminRegistry(scope,signal);
}
async function freshAdmin(scope: ProfileReadScope, signer: ccc.Signer, check: () => Promise<void>) {
  await check();
  const signerClient = signer.client;
  const actual = await signer.getRecommendedAddressObj();
  if (actual.script.hash() !== scope.lockHash || signer.client.addressPrefix !== (scope.network === "testnet" ? "ckt" : "ckb")) throw new Error("The Admin wallet or network changed.");
  const cell = await withProfileDeadline(signal => readDiscoveryProtocol(scope.client,scope.protocolCell.cellOutput.type!,signal));
  const data = ProtocolData.decode(cell.outputData);
  if (cell.cellOutput.type?.hash() !== scope.protocolHash || ccc.hexFrom(ProtocolData.encode(data)) !== cell.outputData || !data.protocol_config.admin_lock_hash_vec.some(value => ccc.hexFrom(value) === scope.lockHash)) throw new Error("This wallet is no longer an administrator in the selected protocol.");
  await check();
  const latest = await signer.getRecommendedAddressObj();
  if (signer.client !== signerClient || latest.script.hash() !== scope.lockHash || signer.client.addressPrefix !== (scope.network === "testnet" ? "ckt" : "ckb")) throw new Error("The Admin wallet or network changed.");
  return {...scope,protocolCell:cell,protocol:data};
}
type PendingRegistryWrite = {schema:"ckboost-admin-registry-pending/v1";transactionHash:ccc.Hex;resultHash:ccc.Hex;actionHash:ccc.Hex};
const busy = new Set<string>();
const pendingInMemory = new Map<string,PendingRegistryWrite>();
function parsePending(raw: string): PendingRegistryWrite {
  if (raw.length > 2048) throw new Error("Invalid saved registry transaction. Inspect it before resubmitting.");
  const value = JSON.parse(raw) as PendingRegistryWrite;
  if (value.schema !== "ckboost-admin-registry-pending/v1") throw new Error("Unsupported saved registry transaction.");
  registryHash(value.transactionHash); registryHash(value.resultHash); registryHash(value.actionHash); return value;
}
const samePending = (a: PendingRegistryWrite, b: PendingRegistryWrite) => a.schema === b.schema && a.transactionHash === b.transactionHash && a.resultHash === b.resultHash && a.actionHash === b.actionHash;
function readPending(key: string): PendingRegistryWrite | null {
  const memory = pendingInMemory.get(key), raw = typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  const stored = raw ? parsePending(raw) : null;
  if (memory && stored && !samePending(memory,stored)) throw new Error("Conflicting registry receipts exist. Inspect them before signing or clearing either update.");
  const value = memory ?? stored;
  if (value) pendingInMemory.set(key,value);
  return value;
}
function clearPending(key: string, saved: PendingRegistryWrite) {
  const current = readPending(key);
  if (!current || !samePending(current,saved)) throw new Error("The registry receipt changed during confirmation. Nothing was cleared or submitted.");
  // No asynchronous boundary between the storage identity check and removal.
  // Keep the memory copy if removal fails or a conflicting receipt appears.
  if (typeof localStorage !== "undefined") {
    const raw = localStorage.getItem(key);
    if (raw && !samePending(parsePending(raw),saved)) throw new Error("The stored registry receipt changed. Nothing was cleared or submitted.");
    localStorage.removeItem(key);
    if (localStorage.getItem(key) !== null) throw new Error("The confirmed registry receipt could not be cleared. Nothing new was submitted.");
  }
  pendingInMemory.delete(key);
}
export class AdminRegistryPreviousUpdateConfirmedError extends Error {
  readonly newChangeNotSubmitted = true;
  constructor(readonly transactionHash: ccc.Hex) {
    super(`The previous registry update is confirmed: ${transactionHash}. This new change was not submitted. Review the current registry and reward periods, then explicitly submit again only if this is a distinct change.`);
    this.name = "AdminRegistryPreviousUpdateConfirmedError";
  }
}
async function confirmRegistryWrite(scope: ProfileReadScope, signer: ccc.Signer, saved: PendingRegistryWrite, script: ccc.Script, check: () => Promise<void>, verifiesAction?: (data: AdminRegistryData) => boolean, awaitConfirmation = false) {
  await freshAdmin(scope,signer,check);
  // A just-submitted transaction normally starts pending. Preserve the usual
  // six-confirmation wait before reading its final committed body. Resolving a
  // different old action is a quick read-only probe, never a new send or wait.
  if (awaitConfirmation) {
    const confirmed = await signer.client.waitTransaction(saved.transactionHash,6,300_000,2000);
    if (!confirmed) throw new Error(`Registry update awaiting confirmation: ${saved.transactionHash}. Retry confirmation before signing again.`);
    await check();
  }
  const response = await withProfileDeadline(() => scope.client.getTransaction(saved.transactionHash));
  const tx = response?.transaction ? ccc.Transaction.fromBytes(response.transaction.toBytes()) : null;
  const output = tx?.outputs[0], encoded = tx?.outputsData[0];
  if (!response || response.status !== "committed" || response.blockNumber == null || !tx || tx.hash() !== saved.transactionHash || !output?.type?.eq(script) || !output.lock.eq(script) || tx.outputs.filter(value => value.type?.eq(script)).length !== 1 || !encoded || ccc.hashCkb(encoded) !== saved.resultHash) throw new Error("The registry update is not yet independently confirmed and indexed. Retry confirmation before submitting a new change.");
  const committed = decodeAdminRegistry(encoded);
  if (committed.protocolTypeHash !== scope.protocolHash) throw new Error("The confirmed registry update belongs to another protocol.");
  const fresh = await freshAdmin(scope,signer,check), current = await withProfileDeadline(signal => readAdminRegistry(fresh,signal));
  if (!current.available || !current.cell?.cellOutput.type?.eq(script) || !current.cell.cellOutput.lock.eq(script) || !current.data || current.data.protocolTypeHash !== scope.protocolHash || BigInt(current.data.revision) < BigInt(committed.revision) || current.data.revision === committed.revision && (current.cell.outPoint.txHash !== saved.transactionHash || current.cell.outPoint.index !== 0n || ccc.hashCkb(current.cell.outputData) !== saved.resultHash)) throw new Error("The confirmed registry update has no verified current state or legitimate successor. Retry confirmation.");
  if (verifiesAction && (!verifiesAction(committed) || !verifiesAction(current.data))) throw new Error("The committed or current registry does not contain the requested change. Review current evidence before submitting again.");
  // A stable Signer object may have changed accounts during the transaction or
  // current-state reads. Such a read must never clear the previous Admin's key.
  await freshAdmin(scope,signer,check);
  await check();
}
/** Existing protocol/user/campaign cells are dependencies, never funding
 * inputs. Only this registry is replaced and ordinary signer capacity added. */
async function saveRegistry(scope: ProfileReadScope, signer: ccc.Signer, action: unknown, update: (data: AdminRegistryData, fresh: ProfileReadScope) => Promise<void> | void, isCurrent: () => Promise<void>, verifiesAction: (data: AdminRegistryData) => boolean, validateTarget?: (fresh: ProfileReadScope) => Promise<void>): Promise<{transactionHash:string}> {
  const pin = pinFor(scope); if (!pin) throw new Error(MISSING);
  const script = ccc.Script.from(pin.typeScript), key = `ckboost:admin-registry-pending:${scope.network}:${scope.protocolHash}:${script.hash()}:${scope.lockHash}`;
  const signerClient = signer.client, readClient = scope.client, protocolHash = scope.protocolHash, lockHash = scope.lockHash;
  const checkCurrent = async () => {
    await isCurrent();
    const currentPin = pinFor(scope);
    if (signer.client !== signerClient || scope.client !== readClient || scope.protocolHash !== protocolHash || scope.lockHash !== lockHash || !currentPin || !ccc.Script.from(currentPin.typeScript).eq(script) || !ccc.Script.from(currentPin.codeTypeScript).eq(pin.codeTypeScript) || currentPin.codeDataHash !== pin.codeDataHash) throw new Error("The wallet, protocol or registry scope changed. Nothing was cleared or submitted.");
  };
  if (busy.has(key)) throw new Error("An Admin registry update is already in progress."); busy.add(key);
  try {
    const actionHash = ccc.hashCkb(ccc.bytesFrom(registryCanonical(action),"utf8"));
    let saved = readPending(key);
    if (saved) {
      const sameAction = saved.actionHash === actionHash;
      await confirmRegistryWrite(scope,signer,saved,script,checkCurrent,sameAction ? verifiesAction : undefined,sameAction);
      clearPending(key,saved);
      if (sameAction) return {transactionHash:saved.transactionHash};
      // A refreshed period form may have a new random id/action hash for an
      // already published period. Resolving one receipt never authorizes a
      // second signature in this click, even when the next action is different.
      throw new AdminRegistryPreviousUpdateConfirmedError(saved.transactionHash);
    }
    if (!saved) {
      const fresh = await freshAdmin(scope,signer,checkCurrent), previous = await withProfileDeadline(signal => readAdminRegistry(fresh,signal));
      if (!previous.cell || !previous.data) throw new Error(MISSING);
      const next = decodeAdminRegistry(encodeAdminRegistry(previous.data)); await update(next,fresh); next.revision = (BigInt(next.revision)+1n).toString();
      const encoded = encodeAdminRegistry(next);
      const codeType = ccc.Script.from(pin.codeTypeScript);
      const codeCells = (await readProfilePages(fresh,{script:codeType,scriptType:"type",scriptSearchMode:"exact",withData:true},`admin-registry-code:${codeType.hash()}`)).filter(cell => cell.cellOutput.type?.eq(codeType));
      if (codeCells.length !== 1 || ccc.hashCkb(codeCells[0].outputData) !== pin.codeDataHash) throw new Error("The registry executable does not match its reviewed deployment manifest.");
      const output = ccc.CellOutput.from({lock:script,type:script},encoded); if (output.capacity < previous.cell.cellOutput.capacity) output.capacity = previous.cell.cellOutput.capacity;
      const tx = ccc.Transaction.from({inputs:[{previousOutput:previous.cell.outPoint}],outputs:[output],outputsData:[encoded],cellDeps:[{outPoint:codeCells[0].outPoint,depType:"code"},{outPoint:fresh.protocolCell.outPoint,depType:"code"}]});
      const initialPoint = point(previous.cell), initialData = ccc.hashCkb(previous.cell.outputData);
      const check = async () => {
        const current = await freshAdmin(scope,signer,checkCurrent);
        const live = await scope.client.getCellLive(previous.cell!.outPoint);
        if (!live || point(live) !== initialPoint || ccc.hashCkb(live.outputData) !== initialData || !live.cellOutput.type?.eq(script)) throw new Error("The registry changed during preview. Reload before signing.");
        if (point(current.protocolCell) !== point(fresh.protocolCell) || ccc.hashCkb(current.protocolCell.outputData) !== ccc.hashCkb(fresh.protocolCell.outputData)) throw new Error("Protocol permissions changed while preparing this update.");
        await validateTarget?.(current);
      };
      const {guardPrivilegedActorSigner,assertActorNetCapacitySpend} = await import("ssri-ckboost");
      const {sendTransactionWithFeeRetry} = await import("@/lib/ckb/transaction-wrapper");
      const expectedResultHash = ccc.hashCkb(encoded);
      const remember = (transactionHash:ccc.Hex):PendingRegistryWrite => {
        if (saved && saved.transactionHash !== transactionHash) throw new Error(`A registry transaction was already submitted or attempted: ${saved.transactionHash}. Confirm it before signing another body.`);
        saved = {schema:"ckboost-admin-registry-pending/v1",transactionHash,resultHash:expectedResultHash,actionHash};
        pendingInMemory.set(key,saved);
        // Browser storage can be unavailable; retain the active session's exact
        // attempt even then. A receipt alone never passes the checks below.
        try {if (typeof localStorage !== "undefined") localStorage.setItem(key,JSON.stringify(saved));} catch {/* In-memory receipt prevents another send in this session. */}
        return saved;
      };
      const observed = observeAdminTransactionAttempt(signer,async actual => {
        await check(); await assertActorNetCapacitySpend(signer,actual,scope.lockHash);
        if (!actual.outputs[0]?.type?.eq(script) || !actual.outputs[0].lock.eq(script) || ccc.hashCkb(actual.outputsData[0]) !== expectedResultHash) throw new Error("The registry transaction changed before submission. Rebuild it before signing.");
        remember(actual.hash());
      });
      await check();
      const transactionHash = await sendTransactionWithFeeRetry(guardPrivilegedActorSigner(createContributorSigner(observed,check,() => {}),scope.lockHash),tx,{preserveOutputCapacityIndices:new Set([0]),allowFeeRetry:false});
      saved = remember(transactionHash);
    }
    if (!saved) throw new Error("The registry transaction receipt is unavailable. Inspect the attempted update before signing again.");
    await confirmRegistryWrite(scope,signer,saved,script,checkCurrent,verifiesAction,true);
    clearPending(key,saved);
    return {transactionHash:saved.transactionHash};
  } catch (error) {
    const attempted = pendingInMemory.get(key);
    if (attempted) throw new Error(`${error instanceof Error ? error.message : "Registry update could not be verified."} Pending transaction: ${attempted.transactionHash}. Retry confirmation before signing again.`);
    throw error;
  } finally {busy.delete(key);}
}
export const adminUsersRegistryAdapter: AdminUsersRegistryAdapter = {
  async read(scope,signal) {
    const result = await readAdminRegistry(scope,signal);
    // This transaction contains the current attestation state. It is not proof
    // that every entry was originally created in this same transaction.
    return {protocolTypeHash:scope.protocolHash,available:result.available,unavailableReason:result.unavailableReason,attestations:result.data?.attestations.map(entry => ({...entry,transactionHash:result.transactionHash!})) ?? []};
  },
  async save(scope,signer,payload:AdminUserVerificationPayload,isCurrent) {
    if (payload.schema !== "ckboost-admin-user-verification/v1" || payload.protocolTypeHash !== scope.protocolHash || payload.verified !== true) throw new Error("Invalid manual verification request.");
    registryHash(payload.userTypeId); registryHash(payload.userTypeHash); registryHash(payload.walletLockHash); registryHash(payload.expectedUserDataHash); registryHash(payload.expectedUserOutPoint?.txHash);
    if (typeof payload.expectedUserOutPoint.index !== "string" || !/^(?:0|[1-9][0-9]*|0x(?:0|[1-9a-f][0-9a-f]*))$/.test(payload.expectedUserOutPoint.index) || BigInt(payload.expectedUserOutPoint.index) > 0xffffffffn) throw new Error("Invalid User output index.");
    const userOutPoint = {txHash:payload.expectedUserOutPoint.txHash,index:`0x${BigInt(payload.expectedUserOutPoint.index).toString(16)}`};
    const validateTarget = async (fresh:ProfileReadScope) => {
      const {readAdminUser} = await import("./admin-users-model"), target = await readAdminUser(fresh,payload.userTypeId);
      if (!target || target.typeHash !== payload.userTypeHash || target.lockHash !== payload.walletLockHash || point(target.cell) !== `${userOutPoint.txHash}:${BigInt(userOutPoint.index)}` || ccc.hashCkb(target.cell.outputData) !== payload.expectedUserDataHash) throw new Error("The target profile changed. Review it again before verification.");
    };
    return saveRegistry(scope,signer,payload,async (data,fresh) => {
      await validateTarget(fresh);
      if (data.attestations.some(entry => entry.userTypeHash === payload.userTypeHash && entry.walletLockHash === payload.walletLockHash)) throw new Error("This user is already manually verified.");
      data.attestations = data.attestations.filter(entry => entry.userTypeHash !== payload.userTypeHash);
      data.attestations.push({userTypeId:payload.userTypeId,userTypeHash:payload.userTypeHash,walletLockHash:payload.walletLockHash,verified:true,verifiedAt:Date.now(),verifiedByLockHash:fresh.lockHash,userOutPoint,userDataHash:payload.expectedUserDataHash});
    },isCurrent,data => data.attestations.some(entry => entry.userTypeId === payload.userTypeId && entry.userTypeHash === payload.userTypeHash && entry.walletLockHash === payload.walletLockHash && entry.verifiedByLockHash === scope.lockHash && entry.verified === true && entry.userDataHash === payload.expectedUserDataHash && entry.userOutPoint.txHash === userOutPoint.txHash && entry.userOutPoint.index === userOutPoint.index),validateTarget);
  },
};
export async function readAdminRewardPeriods(scope:ProfileReadScope,signal?:AbortSignal) {
  const result = await readAdminRegistry(scope,signal); return {available:result.available,unavailableReason:result.unavailableReason,periods:result.data?.periods ?? []};
}
export async function saveAdminRewardPeriod(scope:ProfileReadScope,signer:ccc.Signer,period:AdminRewardPeriod,isCurrent:()=>Promise<void>) {
  const validateAsset=async(fresh:ProfileReadScope)=>{
    // The form's asset catalogue is a preview, never authority for a later
    // signature. Rebuild from the actual freshly read protocol at preparation
    // and at the client broadcast boundary (including accepted full scripts).
    const {readAdminRewardsAssets}=await import("./admin-rewards-model");
    const assets=await readAdminRewardsAssets(fresh),actual=assets.find(asset=>asset.id===period.asset.id);
    const selected=period.asset;
    if(!actual||actual.kind!==selected.kind||actual.decimals!==selected.decimals||actual.symbol!==selected.symbol||
      (actual.typeScript?!selected.typeScript||!ccc.Script.from(actual.typeScript).eq(selected.typeScript):Boolean(selected.typeScript)))throw new Error("The selected reward asset is no longer accepted by the current protocol. Reload the asset list and review the period again.");
  };
  return saveRegistry(scope,signer,{kind:"reward-period",period},async(data,fresh) => {await validateAsset(fresh);if (data.periods.some(existing => existing.id === period.id)) throw new Error("This reward period already exists."); data.periods.push(period);},isCurrent,data => data.periods.some(existing => registryCanonical(existing) === registryCanonical(period)),validateAsset);
}
export async function saveAdminTipSettings(scope:ProfileReadScope,signer:ccc.Signer,settings:AdminTipSettings,isCurrent:()=>Promise<void>) {
  return saveRegistry(scope,signer,{kind:"tip-settings",settings},data => {data.tipping = settings;},isCurrent,data => registryCanonical(data.tipping) === registryCanonical(settings));
}
