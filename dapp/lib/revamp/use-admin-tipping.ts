"use client";

import {useEffect,useMemo,useRef,useState} from "react";
import {useQuery,useQueryClient} from "@tanstack/react-query";
import {ccc,ssri} from "@ckb-ccc/connector-react";
import {ConnectedTypeID,TippingData} from "ssri-ckboost/types";
import {useProtocol} from "@/lib/providers/protocol-provider";
import {usePendingTransactions} from "@/lib/providers/pending-transaction-provider";
import {currentDeployment} from "@/lib/ckb/current-deployment";
import {deploymentManager} from "@/lib/ckb/deployment-manager";
import {getDiscoveryReadClient} from "./discovery-read-client";
import {readDiscoveryProtocol} from "./discovery-cells";
import {makeProfileReadScope,withProfileDeadline,type ProfileReadScope} from "./profile-model";
import {isOverviewAdmin} from "./admin-overview-model";
import {assertAdminQaScope} from "./admin-campaigns-approval";
import {createContributorSigner} from "./contributor-transaction";
import {observeAdminTransactionAttempt} from "./admin-pending-transaction";
import {readAdminRegistry,readProtocolAdminRegistry,saveAdminTipSettings,type AdminRegistrySnapshot} from "./admin-registry-service";
import {readAdminUsers} from "./admin-users-model";
import {readAdminTipCapability,makeAdminTipExecutionPolicy,type AdminTipCapability} from "./admin-tipping-capability";
import type {AdminTippingExecutionPolicy} from "@/lib/services/tipping-service";
import {resolveProtocolTipRecipient,TipRecipientUserNotFoundError} from "./admin-tip-recipient";
import {adminTipAssets,adminTipId,assertTippingAdmin,assertTippingProtocolScope,assertProtocolTipSupport,isProtocolTipApprover,buildProtocolTipRows,buildAdminTipRows,canonicalAdminTipAsset,readAdminTipDepositDelta,legacyTipSettings,makeAdminTipData,readAdminTipHistory,readAdminTipPool,readAdminTips,readProtocolTip,readProtocolTipPool,readProtocolTipHistory,tipShortfalls,validateTipSettingsDraft,type AdminTipDraft,type AdminTipRow,type AdminTipSettingsDraft} from "./admin-tipping-model";
import {parseRewardAmount,type AdminRewardsAsset} from "./admin-rewards-model";
import {confirmAdminTipReceipt,parseAdminTipReceipt,makeAdminTipReceipt,inspectInvalidAdminTipReceipt,type AdminTipPendingReceipt,type AdminTipInvalidCapacityProof} from "./admin-tipping-confirmation";

const ids=new WeakMap<object,number>();let next=0;
function identity(value:object|null|undefined){if(!value)return 0;const old=ids.get(value);if(old)return old;const id=++next;ids.set(value,id);return id;}
const message=(error:unknown)=>error instanceof Error?error.message:"The tipping operation could not be completed.";
type Receipt=AdminTipPendingReceipt;
type SupportAuthorization={registry:AdminRegistrySnapshot;capability:AdminTipCapability};
const pendingInMemory=new Map<string,Receipt>();
const sameReceipt=(a:Receipt,b:Receipt)=>JSON.stringify(a)===JSON.stringify(b);
function readPendingTip(key:string):Receipt|null {
  const memory=pendingInMemory.get(key);let raw:string|null=null;
  try{raw=typeof localStorage!=="undefined"?localStorage.getItem(key):null;}catch(error){if(memory)return memory;throw error;}
  const saved=raw?parseAdminTipReceipt(raw):null;
  if(memory&&saved&&!sameReceipt(memory,saved))throw new Error("Conflicting tipping receipts exist. Inspect both before signing again.");
  return memory??saved;
}
function clearPendingTip(key:string,saved:Receipt){
  const latest=readPendingTip(key);if(!latest||!sameReceipt(latest,saved))throw new Error("The saved tipping receipt changed. Nothing was cleared.");
  if(typeof localStorage==="undefined")throw new Error("Receipt storage is unavailable. The pending receipt is retained.");
  const raw=localStorage.getItem(key);if(raw&&!sameReceipt(parseAdminTipReceipt(raw),saved))throw new Error("The stored tipping receipt changed. Nothing was cleared.");
  localStorage.removeItem(key);if(localStorage.getItem(key)!==null)throw new Error("The pending receipt could not be removed. Inspect the saved diagnostic before another action.");
  pendingInMemory.delete(key);
}
export function useAdminTipping({tipId,historyRequested=false}:{tipId?:string;historyRequested?:boolean}={}) {
  const signer=ccc.useSigner(),{client:walletClient,signerInfo,open}=ccc.useCcc(),protocol=useProtocol(),queryClient=useQueryClient(),{confirmationTarget,register,remove}=usePendingTransactions();
  const [revision,setRevision]=useState(0),[operation,setOperation]=useState<{key:string;phase:"signing"|"confirming"|"confirmed"|"invalid"|"error";transactionHash?:string;error?:string}|null>(null);
  const [pending,setPending]=useState<{key:string;receipt:Receipt|null;error:string|null}>({key:"",receipt:null,error:null});
  const [capacityArchive,setCapacityArchive]=useState<{key:string;proof:AdminTipInvalidCapacityProof}|null>(null);
  const busy=useRef(false);
  const configuration=useMemo(()=>{try{const network=currentDeployment.getCurrentNetwork();return {network,client:getDiscoveryReadClient(network),error:null};}catch(error){return {network:null,client:null,error:message(error)};}},[walletClient]);
  const protocolCell=protocol.protocolCell,protocolKey=protocolCell?`${protocolCell.cellOutput.type?.hash()}:${protocolCell.outPoint.txHash}:${protocolCell.outPoint.index}:${ccc.hashCkb(protocolCell.outputData)}`:"pending";
  const session=[identity(signer),identity(signerInfo),identity(walletClient),identity(configuration.client),configuration.network,protocolKey,tipId??"manage",revision].join(":"),currentSession=useRef(session);currentSession.current=session;
  const rootKey=["revamp-admin-tipping",session] as const,enabled=Boolean(signer&&protocolCell&&configuration.client&&configuration.network&&!protocol.isLoading&&!protocol.error);
  const scopeQuery=useQuery<ProfileReadScope,Error>({queryKey:[...rootKey,"scope"],enabled,retry:false,staleTime:30_000,queryFn:({signal})=>withProfileDeadline(async()=>{if(!signer||!protocolCell||!configuration.client||!configuration.network)throw new Error("Connect an Admin wallet.");const address=await signer.getRecommendedAddressObj();if(currentSession.current!==session)throw new Error("The wallet changed.");return makeProfileReadScope(configuration.client,protocolCell,address,configuration.network);},signal,12_000)});
  const scope=enabled?scopeQuery.data??null:null,isAdmin=Boolean(scope&&isOverviewAdmin(scope)),detailMode=Boolean(tipId),baseError=protocol.error??configuration.error??(scopeQuery.error?message(scopeQuery.error):null);
  const current=useRef({session,scope,signer});current.current={session,scope,signer};
  const receiptKey=scope?`ckboost:admin-tip-pending:${scope.network}:${scope.protocolHash}:${scope.lockHash}`:null;
  useEffect(()=>{if(!receiptKey)return;try{setPending({key:receiptKey,receipt:readPendingTip(receiptKey),error:null});}catch(error){setPending({key:receiptKey,receipt:null,error:message(error)});}},[receiptKey,session]);
  async function guard(captured=current.current,adminOnly=false){if(!captured.signer||!captured.scope||current.current.session!==captured.session||current.current.signer!==captured.signer)throw new Error("The wallet or protocol changed.");assertTippingProtocolScope(captured.scope);if(adminOnly)assertTippingAdmin(captured.scope);const address=await captured.signer.getRecommendedAddressObj();if(current.current.session!==captured.session||address.script.hash()!==captured.scope.lockHash){if(current.current.session===captured.session)setRevision(value=>value+1);throw new Error("The wallet account changed. Reload Tipping.");}}
  async function freshScope(captured=current.current){await guard(captured);const cell=await withProfileDeadline(signal=>readDiscoveryProtocol(captured.scope!.client,captured.scope!.protocolCell.cellOutput.type!,signal));await guard(captured);const fresh=makeProfileReadScope(captured.scope!.client,cell,await captured.signer!.getRecommendedAddressObj(),captured.scope!.network);if(fresh.protocolHash!==captured.scope!.protocolHash||fresh.lockHash!==captured.scope!.lockHash)throw new Error("The wallet or protocol changed.");return fresh;}
  async function guarded<T>(read:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal,milliseconds=20_000){const captured=current.current;return withProfileDeadline(async active=>{await guard(captured);const result=await read(active);await guard(captured);return result;},signal,milliseconds);}
  const key=[...rootKey,scope?.protocolHash,scope?.lockHash] as const;
  const mayReadPolicy=Boolean(scope&&(isAdmin||detailMode));
  const registryQuery=useQuery({queryKey:[...key,"settings"],enabled:mayReadPolicy,retry:false,staleTime:30_000,refetchOnWindowFocus:false,queryFn:({signal})=>guarded(active=>isAdmin?readAdminRegistry(scope!,active):readProtocolAdminRegistry(scope!,active),signal)});
  const capabilityQuery=useQuery({queryKey:[...key,"paired-capability",registryQuery.dataUpdatedAt],enabled:Boolean(mayReadPolicy&&registryQuery.isSuccess),retry:false,staleTime:30_000,refetchOnWindowFocus:false,queryFn:({signal})=>guarded(active=>readAdminTipCapability(scope!,registryQuery.data!,active),signal)});
  const tipCapability=mayReadPolicy?capabilityQuery.data??null:null;
  const isApprover=Boolean(detailMode&&scope&&registryQuery.data&&tipCapability&&isProtocolTipApprover(scope,registryQuery.data,tipCapability));
  const allowed=isAdmin||isApprover,canManage=isAdmin;
  const error=baseError??(!isAdmin&&detailMode?(registryQuery.error?message(registryQuery.error):capabilityQuery.error?message(capabilityQuery.error):null):null);
  const roleChecking=Boolean(detailMode&&!isAdmin&&scope&&(registryQuery.isPending||registryQuery.isSuccess&&capabilityQuery.isPending));
  const access=!signer?"disconnected":error?"error":!scope||roleChecking?"checking":allowed?"allowed":"denied";
  const recordsQuery=useQuery({queryKey:[...key,"records",tipId??"all"],enabled:allowed,retry:false,staleTime:30_000,refetchOnWindowFocus:false,queryFn:({signal})=>guarded(active=>isAdmin?readAdminTips(scope!,tipId,active):readProtocolTip(scope!,tipId!,active),signal)});
  const poolQuery=useQuery({queryKey:[...key,"pool"],enabled:allowed,retry:false,staleTime:30_000,refetchOnWindowFocus:false,queryFn:({signal})=>guarded(active=>isAdmin?readAdminTipPool(scope!,active):readProtocolTipPool(scope!,active),signal)});
  const peopleQuery=useQuery({queryKey:[...key,"people"],enabled:allowed&&isAdmin,retry:false,staleTime:60_000,refetchOnWindowFocus:false,queryFn:({signal})=>guarded(async active=>new Map((await readAdminUsers(scope!,active)).map(user=>[user.lockHash,{lockHash:user.lockHash,name:user.displayName,address:user.address}])),signal)});
  const settings=scope?(registryQuery.data?.available&&tipCapability?.available?registryQuery.data.data!.tipping:legacyTipSettings(scope)):null;
  let rows:AdminTipRow[]|null=null,recordsError=recordsQuery.error?message(recordsQuery.error):null;
  try{if(allowed&&scope&&recordsQuery.data&&!recordsError&&settings)rows=(isAdmin?buildAdminTipRows:buildProtocolTipRows)(scope,recordsQuery.data,settings,peopleQuery.data);}catch(error){recordsError=message(error);}
  const selected=tipId?rows?.find(row=>row.id===tipId.toLowerCase())??null:null;
  const historyQuery=useQuery({queryKey:[...key,"history",selected?.id,selected?.cell.outPoint.txHash],enabled:Boolean(allowed&&selected&&historyRequested),retry:false,staleTime:120_000,refetchOnWindowFocus:false,queryFn:({signal})=>guarded(active=>isAdmin?readAdminTipHistory(scope!,selected!,active):readProtocolTipHistory(scope!,selected!,active),signal,25_000)});
  async function supportAuthorization(fresh:ProfileReadScope):Promise<SupportAuthorization>{
    const registry=await withProfileDeadline(signal=>isOverviewAdmin(fresh)?readAdminRegistry(fresh,signal):readProtocolAdminRegistry(fresh,signal));
    const capability=await withProfileDeadline(signal=>readAdminTipCapability(fresh,registry,signal));
    if(!isOverviewAdmin(fresh)&&(!detailMode||!isProtocolTipApprover(fresh,registry,capability)))throw new Error("This wallet is not a current verified tip approver. Reload permissions before endorsing.");
    return {registry,capability};
  }
  async function write<T>(action:string,send:(fresh:ProfileReadScope,safe:ccc.Signer,authorization:SupportAuthorization|null)=>Promise<string>,verify:(fresh:ProfileReadScope,transaction:ccc.Transaction)=>Promise<T>,purpose:"manage"|"support"="manage"):Promise<T>{
    const captured=current.current;await guard(captured,purpose==="manage");assertAdminQaScope(captured.scope!);if(busy.current)throw new Error("A tipping transaction is already in progress.");busy.current=true;
    const receiptKey=`ckboost:admin-tip-pending:${captured.scope!.network}:${captured.scope!.protocolHash}:${captured.scope!.lockHash}`;
    try{
      let receipt:Receipt|null=readPendingTip(receiptKey);
      if(receipt&&receipt.action!==action)throw new Error(`Confirm the previous tipping transaction before another action: ${receipt.transactionHash}`);
      if(!receipt){const fresh=await freshScope(captured);assertAdminQaScope(fresh);if(purpose==="manage")assertTippingAdmin(fresh);const authorization=purpose==="support"?await supportAuthorization(fresh):null;await guard(captured);setOperation({key:captured.session,phase:"signing"});const {guardPrivilegedActorSigner,assertActorNetCapacitySpend}=await import("ssri-ckboost");
        const check=async()=>{const latest=await freshScope(captured);assertAdminQaScope(latest);if(purpose==="manage")assertTippingAdmin(latest);if(latest.protocolCell.outPoint.txHash!==fresh.protocolCell.outPoint.txHash||latest.protocolCell.outPoint.index!==fresh.protocolCell.outPoint.index||ccc.hashCkb(latest.protocolCell.outputData)!==ccc.hashCkb(fresh.protocolCell.outputData))throw new Error("The protocol changed during transaction preparation. Review again.");
          if(authorization){const current=await supportAuthorization(latest),before=authorization.registry.cell,after=current.registry.cell;if(Boolean(before)!==Boolean(after)||before&&after&&(!before.outPoint.eq(after.outPoint)||ccc.hashCkb(before.outputData)!==ccc.hashCkb(after.outputData)))throw new Error("The tip registry changed during transaction preparation. Review again.");}await guard(captured);
        };
        const remember=(actual:ccc.Transaction)=>{const next=makeAdminTipReceipt(action,actual),existing=readPendingTip(receiptKey);if(existing&&!sameReceipt(existing,next)||receipt&&!sameReceipt(receipt,next))throw new Error("Another tipping body or receipt is already saved. Confirm it before another submission.");const first=!receipt;receipt=next;pendingInMemory.set(receiptKey,next);if(current.current.session===captured.session){setPending({key:receiptKey,receipt:next,error:null});setOperation({key:captured.session,phase:"confirming",transactionHash:next.transactionHash});}if(typeof localStorage==="undefined")throw new Error("Public receipt storage is unavailable. Submission was blocked; the actual body remains in memory.");localStorage.setItem(receiptKey,JSON.stringify(next));const stored=localStorage.getItem(receiptKey);if(!stored||!sameReceipt(parseAdminTipReceipt(stored),next))throw new Error("The actual public receipt could not be durably verified. Submission was blocked; inspect the retained body.");if(first)register(next.transactionHash,{description:"Admin tipping update"});};
        const observed=observeAdminTransactionAttempt(captured.signer!,async actual=>{const exact=ccc.Transaction.fromBytes(actual.toBytes());await check();await assertActorNetCapacitySpend(captured.signer!,exact,fresh.lockHash);await guard(captured);remember(exact);exact.outputs.forEach((output,index)=>{const required=ccc.CellOutput.from({lock:output.lock,type:output.type},exact.outputsData[index]).capacity;if(output.capacity<required)throw new Error(`Actual signed output ${index} has ${output.capacity} shannons but requires ${required}. Submission stopped without changing the body; inspect and archive the saved diagnostic.`);});await guard(captured);});
        const safe=guardPrivilegedActorSigner(createContributorSigner(observed,check,()=>{}),fresh.lockHash);
        const transactionHash=await send(fresh,safe,authorization),recorded=readPendingTip(receiptKey);if(!/^0x[0-9a-f]{64}$/.test(transactionHash)||!recorded||recorded.schema!=="ckboost-admin-tip-pending/v2"||recorded.transactionHash!==transactionHash)throw new Error("The node acknowledgement has no matching durably captured public transaction. Inspect the existing receipt before another wallet action.");receipt=recorded;
      }
      if(!receipt)throw new Error("The tipping submission receipt is unavailable. Inspect it before signing again.");
      await guard(captured);setOperation({key:captured.session,phase:"confirming",transactionHash:receipt.transactionHash});
      const confirmation=await captured.signer!.client.waitTransaction(receipt.transactionHash,confirmationTarget,300_000,2000);if(!confirmation)throw new Error("The tipping transaction is awaiting confirmation. Retry confirmation before signing again.");
      await guard(captured);const response=await captured.scope!.client.getTransaction(receipt.transactionHash);if(!response||response.status!=="committed"||response.blockNumber==null||response.transaction.hash()!==receipt.transactionHash)throw new Error("The confirmed tipping transaction has not been independently verified yet.");
      const fresh=await freshScope(captured),result=await verify(fresh,response.transaction);await guard(captured);
      clearPendingTip(receiptKey,receipt);setPending({key:receiptKey,receipt:null,error:null});setOperation({key:captured.session,phase:"confirmed",transactionHash:receipt.transactionHash});
      await queryClient.invalidateQueries({queryKey:["revamp-admin-tipping"]});await queryClient.invalidateQueries({queryKey:["revamp-admin-overview"]});return result;
    }catch(error){const attempted=pendingInMemory.get(receiptKey);const detail=attempted?`${message(error)} Pending transaction: ${attempted.transactionHash}. Retry confirmation before signing again.`:message(error);if(current.current.session===captured.session)setOperation(previous=>({key:captured.session,phase:"error",transactionHash:attempted?.transactionHash??previous?.transactionHash,error:detail}));throw new Error(detail);}finally{busy.current=false;}
  }
  async function checkPendingConfirmation():Promise<string>{
    const captured=current.current;await guard(captured);if(busy.current)throw new Error("A tipping operation is already in progress.");busy.current=true;
    const key=`ckboost:admin-tip-pending:${captured.scope!.network}:${captured.scope!.protocolHash}:${captured.scope!.lockHash}`;let receipt:Receipt|null=null;
    try{
      receipt=readPendingTip(key);if(!receipt)throw new Error("No saved tipping transaction is awaiting confirmation.");
      setPending({key,receipt,error:null});setOperation({key:captured.session,phase:"confirming",transactionHash:receipt.transactionHash});
      const fresh=await freshScope(captured),saved=receipt;
      const confirmed=await withProfileDeadline(signal=>confirmAdminTipReceipt(fresh,saved,{confirmationTarget,signal,assertCurrent:()=>guard(captured)}),undefined,25_000);
      await guard(captured);clearPendingTip(key,saved);setPending({key,receipt:null,error:null});setOperation({key:captured.session,phase:"confirmed",transactionHash:saved.transactionHash});
      await queryClient.invalidateQueries({queryKey:["revamp-admin-tipping"]});await queryClient.invalidateQueries({queryKey:["revamp-admin-overview"]});return confirmed.result;
    }catch(error){if(current.current.session===captured.session)setOperation({key:captured.session,phase:"error",transactionHash:receipt?.transactionHash,error:message(error)});throw error;}finally{busy.current=false;}
  }
  async function archiveInvalidPending(publicTransactionText?:string):Promise<AdminTipInvalidCapacityProof>{
    const captured=current.current;await guard(captured);if(busy.current)throw new Error("A tipping operation is already in progress.");busy.current=true;
    const key=`ckboost:admin-tip-pending:${captured.scope!.network}:${captured.scope!.protocolHash}:${captured.scope!.lockHash}`;let saved:Receipt|null=null;
    try{
      saved=readPendingTip(key);if(!saved)throw new Error("No saved tipping transaction is available for inspection.");
      setOperation({key:captured.session,phase:"confirming",transactionHash:saved.transactionHash});
      const fresh=await freshScope(captured),proof=await withProfileDeadline(signal=>inspectInvalidAdminTipReceipt(fresh,saved!,publicTransactionText,{signal,assertCurrent:()=>guard(captured)}),undefined,25_000);
      await guard(captured);const latest=readPendingTip(key);if(!latest||!sameReceipt(latest,saved))throw new Error("The saved tipping receipt changed during inspection. Nothing was cleared.");
      if(proof.schema!=="ckboost-admin-tip-invalid-capacity/v1"||proof.network!==fresh.network||proof.protocolTypeHash!==fresh.protocolHash||proof.walletLockHash!==fresh.lockHash||proof.action!==saved.action||proof.transactionHash!==saved.transactionHash||proof.diagnosticReceipt.action!==saved.action||proof.diagnosticReceipt.transactionHash!==saved.transactionHash)throw new Error("The diagnostic belongs to another wallet, protocol or saved body. Nothing was cleared.");
      if(typeof localStorage==="undefined")throw new Error("Diagnostic storage is unavailable. The pending receipt is retained.");
      const archiveKey=`ckboost:admin-tip-invalid-capacity:${fresh.network}:${fresh.protocolHash}:${fresh.lockHash}:${saved.transactionHash}`,encoded=JSON.stringify(proof),old=localStorage.getItem(archiveKey);
      if(old!==null&&old!==encoded){const previous:unknown=JSON.parse(old);if(!previous||typeof previous!=="object"||Array.isArray(previous)||!["unknown","rejected"].includes((previous as {nodeStatus?:string}).nodeStatus??"")||!["unknown","rejected"].includes(proof.nodeStatus)||JSON.stringify({...previous,nodeStatus:proof.nodeStatus})!==encoded)throw new Error("A different diagnostic already exists for this hash. The pending receipt is retained.");}
      // A retry may observe unknown→rejected after the archive succeeded but
      // receipt removal failed. Preserve the first archive byte-for-byte;
      // every field except those two permitted node statuses must be identical.
      const durable=old??encoded;if(old===null)localStorage.setItem(archiveKey,encoded);if(localStorage.getItem(archiveKey)!==durable)throw new Error("The public diagnostic could not be durably verified. The pending receipt is retained.");
      await guard(captured);clearPendingTip(key,saved);setPending({key,receipt:null,error:null});setCapacityArchive({key,proof});setOperation({key:captured.session,phase:"invalid",transactionHash:saved.transactionHash});remove(saved.transactionHash);return proof;
    }catch(error){if(current.current.session===captured.session)setOperation({key:captured.session,phase:"error",transactionHash:saved?.transactionHash,error:message(error)});throw error;}finally{busy.current=false;}
  }
  async function service(fresh:ProfileReadScope,safe:ccc.Signer,row?:AdminTipRow,policy?:AdminTippingExecutionPolicy|null){
    const names=[ ["ckboostTippingType","ckb_boost_tipping_type_code_hash"], ["ckboostProtocolLock","ckb_boost_protocol_lock_code_hash"], ["ckboostFundingLock","ckb_boost_funding_lock_code_hash"] ] as const;
    for(const [name,field] of names){const deployed=deploymentManager.getContractCodeHash(fresh.network,name);if(deployed!==ccc.hexFrom(fresh.protocol.protocol_config.script_code_hashes[field]))throw new Error("The local write deployment differs from this protocol. Writes are blocked.");}
    const outPoint=deploymentManager.getContractOutPoint(fresh.network,"ckboostTippingType");if(!outPoint)throw new Error("Tipping executable is unavailable.");
    const {Tipping}=await import("ssri-ckboost"),{TippingService}=await import("@/lib/services/tipping-service");
    const script=row?.cell.cellOutput.type??ccc.Script.from({codeHash:ccc.hexFrom(fresh.protocol.protocol_config.script_code_hashes.ckb_boost_tipping_type_code_hash),hashType:"type",args:ccc.hexFrom(ConnectedTypeID.encode({type_id:`0x${"00".repeat(32)}`,connected_key:fresh.protocolHash}))});
    return new TippingService(safe,new Tipping(outPoint,script,fresh.protocolCell,{executor:new ssri.ExecutorJsonRpc(process.env.NEXT_PUBLIC_SSRI_EXECUTOR_URL||"http://127.0.0.1:9091/")}),fresh.protocolCell,policy??undefined,{allowFeeRetry:false,...(policy?{resolveRecipientLock:async(hash:ccc.Hex)=>{try{return await resolveProtocolTipRecipient(fresh,hash);}catch(error){if(error instanceof TipRecipientUserNotFoundError)return null;throw error;}}}:{})});
  }
  async function approve(row:AdminTipRow){if(!isAdmin&&(!detailMode||row.id!==tipId?.toLowerCase()))throw new Error("Tip approver access is limited to this exact proposal detail.");return write(`support:${row.id}:${row.cell.outPoint.txHash}:${row.cell.outPoint.index}`,async(fresh,safe,authorization)=>{
    if(!isOverviewAdmin(fresh)&&(!detailMode||row.id!==tipId?.toLowerCase()))throw new Error("Tip approver access is limited to this exact proposal detail.");
    const actual=(await (isOverviewAdmin(fresh)?readAdminTips(fresh,row.id):readProtocolTip(fresh,row.id)))[0];if(!actual||actual.cell.outPoint.txHash!==row.cell.outPoint.txHash||actual.cell.outPoint.index!==row.cell.outPoint.index||ccc.hashCkb(actual.cell.outputData)!==ccc.hashCkb(row.cell.outputData))throw new Error("The proposal changed after review. Reload it before approving.");
    const {registry,capability}=authorization!;assertProtocolTipSupport(fresh,actual,registry,capability);
    const policy=await makeAdminTipExecutionPolicy(fresh,registry);if(registry.available&&!policy)throw new Error("This registry requires its paired, verified tipping contract and SDK upgrade before approvals can resume.");
    const settings=policy?registry.data!.tipping:legacyTipSettings(fresh),latest=buildProtocolTipRows(fresh,[actual],settings)[0];
    if(latest.status==="granted"||latest.status==="expired"||latest.supporters.includes(fresh.lockHash))throw new Error("This proposal can no longer receive this wallet's approval.");
    if(!policy&&latest.rewards.some(reward=>reward.asset.kind==="udt"))throw new Error("UDT payouts require the reviewed tipping contract upgrade. Nothing was signed.");
    if(latest.supporters.length+1>=latest.requiredApprovals){const shortages=tipShortfalls(latest,await (isOverviewAdmin(fresh)?readAdminTipPool(fresh):readProtocolTipPool(fresh)));if(shortages.length)throw new Error(`Insufficient funding: ${shortages.map(value=>`${value.amount} base units ${value.asset.symbol}`).join(", ")}`);}
    const data=TippingData.decode(actual.cell.outputData);data.supporter_lock_hashes.push(fresh.lockHash);data.status=data.supporter_lock_hashes.length>=latest.requiredApprovals?"granted":"approved";if(data.status==="granted")data.granted_at=policy?.declaredAtMs??BigInt(Date.now());
    return (await service(fresh,safe,latest,policy)).updateTipping(data);
  },async(fresh,tx)=>{if(!tx.inputs.some(input=>input.previousOutput.eq(row.cell.outPoint)))throw new Error("The approval transaction did not consume the reviewed proposal.");const outputs=tx.outputs.flatMap((output,index)=>output.type?.eq(row.cell.cellOutput.type!)?[index]:[]);if(outputs.length!==1)throw new Error("The approval output is ambiguous.");const next=TippingData.decode(tx.outputsData[outputs[0]]),before=TippingData.decode(row.cell.outputData);if(next.supporter_lock_hashes.length!==before.supporter_lock_hashes.length+1||before.supporter_lock_hashes.some((value,index)=>ccc.hexFrom(value)!==ccc.hexFrom(next.supporter_lock_hashes[index]))||ccc.hexFrom(next.supporter_lock_hashes.at(-1)!)!==fresh.lockHash)throw new Error("The approval does not prove this wallet's single new endorsement.");const immutable={...next,supporter_lock_hashes:before.supporter_lock_hashes,status:before.status,granted_at:before.granted_at};if(ccc.hexFrom(TippingData.encode(immutable))!==row.cell.outputData)throw new Error("The approval changed unrelated proposal data.");const actual=(await (isOverviewAdmin(fresh)?readAdminTips(fresh,row.id):readProtocolTip(fresh,row.id)))[0];if(!actual||!actual.data.supporter_lock_hashes.some(value=>ccc.hexFrom(value)===fresh.lockHash))throw new Error("The approval is not yet confirmed and indexed. Retry confirmation.");return actual.id;},"support");}
  async function createProposal(draft:AdminTipDraft){const captured=current.current;await guard(captured,true);const data=await makeAdminTipData(captured.scope!,draft);await guard(captured,true);const fingerprint=ccc.hashCkb(TippingData.encode({...data,metadata:{...data.metadata,creation_timestamp:0n}}));
    return write(`create:${fingerprint}`,async(fresh,safe)=>{const actual=await makeAdminTipData(fresh,draft,Number(ccc.numFrom(data.metadata.creation_timestamp)));const registry=await readAdminRegistry(fresh),policy=await makeAdminTipExecutionPolicy(fresh,registry);if(actual.rewards.udt_assets.length&&!policy)throw new Error("UDT proposals require the reviewed tipping contract upgrade before publication.");return (await service(fresh,safe,undefined,policy)).updateTipping(actual);},async(fresh,tx)=>{
      const candidates=tx.outputs.map((output,index)=>ccc.Cell.from({outPoint:{txHash:tx.hash(),index},cellOutput:output,outputData:tx.outputsData[index]})).filter(cell=>adminTipId(fresh,cell));
      if(candidates.length!==1||ccc.hashCkb(TippingData.encode({...TippingData.decode(candidates[0].outputData),metadata:{...TippingData.decode(candidates[0].outputData).metadata,creation_timestamp:0n}}))!==fingerprint)throw new Error("The confirmed proposal does not match this creation preview.");const id=adminTipId(fresh,candidates[0])!;if(!tx.inputs[0]||ccc.hashTypeId(tx.inputs[0],candidates[0].outPoint.index)!==id)throw new Error("The confirmed transaction does not prove a fresh proposal TypeID.");const actual=(await readAdminTips(fresh,id))[0];if(!actual)throw new Error("The new proposal is not indexed yet. Retry confirmation.");return id;
    });}
  async function fund(inputAsset:AdminRewardsAsset,amount:string){const captured=current.current;await guard(captured,true);const asset=canonicalAdminTipAsset(captured.scope!,inputAsset),raw=parseRewardAmount(amount,asset.decimals);if(asset.kind==="points")throw new Error("Points are minted through approved rewards and cannot be deposited here.");return write(`fund:${asset.id}:${raw}`,async(fresh,safe)=>{const supported=canonicalAdminTipAsset(fresh,asset);const handler=await service(fresh,safe);return supported.kind==="ckb"?handler.fundProtocolWithCKB(raw):handler.fundProtocolWithUDT([{udt_script:supported.typeScript!,amount:raw}]);},async(fresh,tx)=>{
      const delta=await readAdminTipDepositDelta(fresh,tx,asset);if(delta<raw)throw new Error("The confirmed deposit does not prove the reviewed net increase of this asset in this protocol's pool.");await readAdminTipPool(fresh);return tx.hash();
    });}
  async function saveSettings(draft:AdminTipSettingsDraft){const captured=current.current;await guard(captured,true);const fresh=await freshScope(captured);assertTippingAdmin(fresh);assertAdminQaScope(fresh);const registry=await readAdminRegistry(fresh),capability=await readAdminTipCapability(fresh,registry);if(!capability.available)throw new Error(capability.unavailableReason!);if(!registry.available)throw new Error(registry.unavailableReason!);const settings=validateTipSettingsDraft(draft,registry.data!.tipping);await saveAdminTipSettings(fresh,captured.signer!,settings,()=>guard(captured,true));await registryQuery.refetch();}
  async function walletBalance(asset:AdminRewardsAsset){const captured=current.current;await guard(captured,true);if(!captured.scope)throw new Error("Connect your wallet.");asset=canonicalAdminTipAsset(captured.scope,asset);const fresh=captured.scope;
    const cells=(await readProfilePagesLocal(fresh,asset)).filter(cell=>cell.cellOutput.lock.eq(fresh.walletLock));await guard(captured);return cells.reduce((sum,cell)=>asset.kind==="ckb"?sum+(!cell.cellOutput.type&&cell.outputData==="0x"?cell.cellOutput.capacity:0n):sum+(cell.cellOutput.type?.eq(asset.typeScript!)&&ccc.bytesFrom(cell.outputData).length===16?ccc.numLeFromBytes(cell.outputData):0n),0n);}
  const supportUnavailableReason=selected&&!isAdmin&&!selected.supporters.length?"The first approval must be given by a current platform Admin.":!allowed?"This wallet is not a current platform Admin or verified tip approver.":null;
  const canApprove=Boolean(allowed&&selected&&!supportUnavailableReason&&selected.status!=="granted"&&selected.status!=="expired"&&!selected.supporters.includes(scope!.lockHash));
  return {access,error,isAdmin,canManage,canApprove,detailMode,supportUnavailableReason,pendingReceipt:pending.key===receiptKey?pending.receipt:null,pendingReceiptError:pending.key===receiptKey?pending.error:null,archivedCapacityDiagnostic:capacityArchive?.key===receiptKey?capacityArchive.proof:null,checkPendingConfirmation,archiveInvalidPending,rows:allowed?rows:null,recordsLoading:allowed&&(recordsQuery.isPending||recordsQuery.isFetching),recordsError:allowed?recordsError:null,selected,
    pool:allowed&&!poolQuery.error?poolQuery.data??null:null,poolLoading:allowed&&(poolQuery.isPending||poolQuery.isFetching),poolError:allowed&&poolQuery.error?message(poolQuery.error):null,
    assets:scope?adminTipAssets(scope):[],settings,settingsAvailable:Boolean(canManage&&registryQuery.data?.available&&tipCapability?.available),settingsUnavailableReason:registryQuery.error?message(registryQuery.error):capabilityQuery.error?message(capabilityQuery.error):tipCapability?.unavailableReason??registryQuery.data?.unavailableReason??"Loading settings…",
    history:historyRequested&&!historyQuery.error?historyQuery.data??null:null,historyLoading:historyRequested&&(historyQuery.isPending||historyQuery.isFetching),historyError:historyQuery.error?message(historyQuery.error):null,
    scopeKey:`${scope?.network??"pending"}:${scope?.protocolHash??"pending"}:${scope?.lockHash??"disconnected"}:${tipId??"manage"}`,viewerLockHash:scope?.lockHash??null,people:allowed&&isAdmin?peopleQuery.data??new Map():new Map(),operation:operation?.key===session?operation:null,
    approve,createProposal,fund,saveSettings,walletBalance,resolveApprover:async(method:"address"|"hash",value:string)=>{const captured=current.current;await guard(captured,true);if(method==="hash"){if(!/^0x[0-9a-f]{64}$/i.test(value.trim())||/^0x0{64}$/i.test(value.trim()))throw new Error("Enter a complete nonzero 32-byte lock hash.");return {lockHash:value.trim().toLowerCase(),address:null as string|null};}const address=await ccc.Address.fromString(value.trim(),captured.scope!.client);await guard(captured,true);return {lockHash:address.script.hash(),address:address.toString() as string|null};},onConnect:open,onRetry:()=>{setRevision(value=>value+1);void protocol.refreshProtocolData().catch(()=>{});},onRefresh:()=>{if(allowed){void recordsQuery.refetch();void poolQuery.refetch();}if(mayReadPolicy)void registryQuery.refetch();},onRefreshHistory:()=>{if(allowed&&selected)void historyQuery.refetch();}};
}
async function readProfilePagesLocal(scope:ProfileReadScope,asset:AdminRewardsAsset){const {readProfilePages}=await import("./profile-model");return readProfilePages(scope,{script:scope.walletLock,scriptType:"lock",scriptSearchMode:"exact",withData:true,...(asset.kind!=="ckb"?{filter:{script:asset.typeScript!}}:{})},`admin-tip-wallet:${scope.protocolHash}:${scope.lockHash}:${asset.id}`);}
