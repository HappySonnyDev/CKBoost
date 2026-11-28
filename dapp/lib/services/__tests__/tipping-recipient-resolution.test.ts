import {ccc} from "@ckb-ccc/connector-react";
import {TippingService,type AdminTippingExecutionPolicy} from "../tipping-service";
import {encodeAdminRegistry} from "../../revamp/admin-registry-model";

// Exercise the actual service, not the injected resolver implementation. No
// signer is constructed, so neither UDT initialisation nor wallet work runs.
jest.mock("@ckb-ccc/connector-react",()=>({ccc:jest.requireActual("@ckb-ccc/core")}));
jest.mock("ssri-ckboost",()=>({Tipping:jest.fn(),createScopedLogger:()=>({error:jest.fn(),warn:jest.fn(),info:jest.fn(),log:jest.fn()})}),{virtual:true});
jest.mock("../../ckb/deployment-manager",()=>({deploymentManager:{getCurrentNetwork:()=>"testnet",getContractCodeHash:()=>`0x${"33".repeat(32)}`}}));
jest.mock("../../ckb/tipping-cells",()=>({}));
jest.mock("../../ckb/transaction-wrapper",()=>({sendTransactionWithFeeRetry:jest.fn()}));
jest.mock("../udt-registry",()=>({udtRegistry:{getAllTokens:()=>[]}}));

const hash=(n:number):ccc.Hex=>`0x${n.toString(16).padStart(64,"0")}`;
const mockFetch=jest.fn();
const originalFetch=Object.getOwnPropertyDescriptor(globalThis,"fetch");
beforeAll(()=>Object.defineProperty(globalThis,"fetch",{configurable:true,writable:true,value:mockFetch}));
beforeEach(()=>mockFetch.mockReset());
afterAll(()=>{if(originalFetch)Object.defineProperty(globalThis,"fetch",originalFetch);else Reflect.deleteProperty(globalThis,"fetch");});
function fixture(){
 const owner=ccc.Script.from({codeHash:hash(1),hashType:"type",args:"0x1234"}),type=ccc.Script.from({codeHash:hash(2),hashType:"type",args:hash(3)});
 const protocol=ccc.Cell.from({outPoint:{txHash:hash(4),index:0},cellOutput:{capacity:ccc.fixedPointFrom(500),lock:owner,type},outputData:"0x"});
 const registryScript=ccc.Script.from({codeHash:hash(5),hashType:"type",args:ccc.hexFrom(ccc.bytesConcat(hash(6),type.hash()))});
 const registryData=encodeAdminRegistry({schema:"ckboost-admin-registry/v1",protocolTypeHash:type.hash(),revision:"2",tipping:{expirationSeconds:"2592000",thresholdsShannons:["100000000000"],approverLockHashes:[owner.hash()]},attestations:[],periods:[]});
 const registryCell=ccc.Cell.from({outPoint:{txHash:hash(7),index:0},cellOutput:ccc.CellOutput.from({lock:registryScript,type:registryScript},registryData),outputData:registryData});
 const policy:AdminTippingExecutionPolicy={protocolTypeHash:type.hash(),registryTypeHash:registryScript.hash(),registryCell,declaredAtMs:1795884000000n};
 const target=ccc.Script.from({codeHash:hash(8),hashType:"type",args:"0x0099"});
 return {protocol,policy,target};
}
type RecipientResolver=(lockHash:ccc.Hex)=>Promise<ccc.Script|null>;
function qaService(resolveRecipientLock?:RecipientResolver){const f=fixture();return {...f,service:new TippingService(undefined,null,f.protocol,f.policy,{allowFeeRetry:false,...(resolveRecipientLock?{resolveRecipientLock}:{})})};}
function resolve(service:TippingService,lockHash:ccc.Hex):Promise<ccc.Script>{return (service as unknown as {resolveLockScript:(hash:ccc.Hex)=>Promise<ccc.Script>}).resolveLockScript(lockHash);}
function legacyResponse(target:ccc.Script){return {ok:true,status:200,json:async()=>({code_hash:target.codeHash,hash_type:target.hashType,args:target.args})};}

describe("TippingService recipient lock resolution boundary",()=>{
 it("uses the QA callback with the exact requested hash and never calls the legacy endpoint",async()=>{
  const target=fixture().target,resolver=jest.fn(async()=>target),{service}=qaService(resolver);
  const result=await resolve(service,target.hash());expect(result.eq(target)).toBe(true);expect(result.hash()).toBe(target.hash());expect(resolver).toHaveBeenCalledTimes(1);expect(resolver).toHaveBeenCalledWith(target.hash());expect(mockFetch).not.toHaveBeenCalled();
 });
 it("fails closed when the QA callback is missing, without any legacy fallback",async()=>{
  const {service,target}=qaService();await expect(resolve(service,target.hash())).rejects.toThrow(/resolver|resolution|required/i);expect(mockFetch).not.toHaveBeenCalled();
 });
 it("rejects a valid but different full lock returned by the QA callback",async()=>{
  const target=fixture().target,other=ccc.Script.from({...target,args:"0x0098"}),resolver=jest.fn(async()=>other),{service}=qaService(resolver);
  await expect(resolve(service,target.hash())).rejects.toThrow(/hash|match|recipient/i);expect(resolver).toHaveBeenCalledWith(target.hash());expect(mockFetch).not.toHaveBeenCalled();
 });
 it("propagates a QA resolver failure instead of trying Explorer",async()=>{
  const failure=new Error("Read-only recipient evidence timed out"),resolver=jest.fn(async()=>{throw failure;}),{service,target}=qaService(resolver);
  await expect(resolve(service,target.hash())).rejects.toBe(failure);expect(resolver).toHaveBeenCalledTimes(1);expect(mockFetch).not.toHaveBeenCalled();
 });
 it("rejects malformed callback results rather than accepting a hash label or trying fallback",async()=>{
  const resolver=jest.fn(async()=>({codeHash:hash(8),hashType:"type",args:"invalid bytes"}) as unknown as ccc.Script),{service,target}=qaService(resolver);
  await expect(resolve(service,target.hash())).rejects.toThrow();expect(mockFetch).not.toHaveBeenCalled();
 });
 it("allows an explicit no-User result to use the existing address lookup and verifies the QA full-lock hash",async()=>{
  const resolver=jest.fn(async()=>null),{service,target}=qaService(resolver);mockFetch.mockResolvedValue(legacyResponse(target));
  const result=await resolve(service,target.hash());expect(result.eq(target)).toBe(true);expect(resolver).toHaveBeenCalledWith(target.hash());expect(mockFetch).toHaveBeenCalledTimes(1);
  const [url]=mockFetch.mock.calls[0],parsed=new URL(url);expect(parsed.origin).toBe(window.location.origin);expect(parsed.pathname).toBe("/api/resolve-lock-script");expect(parsed.searchParams.get("hash")).toBe(target.hash());
 });
 it("rejects a different full-lock hash from the QA no-User fallback",async()=>{
  const resolver=jest.fn(async()=>null),{service,target}=qaService(resolver),wrong=ccc.Script.from({...target,args:"0x0098"});mockFetch.mockResolvedValue(legacyResponse(wrong));
  await expect(resolve(service,target.hash())).rejects.toThrow(/hash|match|recipient/i);expect(resolver).toHaveBeenCalledWith(target.hash());expect(mockFetch).toHaveBeenCalledTimes(1);
 });
 it("does not treat undefined or malformed absence as an explicit no-User result",async()=>{
  const resolver=jest.fn(async()=>undefined as unknown as ccc.Script),{service,target}=qaService(resolver);
  await expect(resolve(service,target.hash())).rejects.toThrow();expect(mockFetch).not.toHaveBeenCalled();
 });
 it("retains the legacy same-origin endpoint when no Admin policy is installed",async()=>{
  const f=fixture(),unused=jest.fn(async()=>f.target),service=new TippingService(undefined,null,f.protocol,undefined,{resolveRecipientLock:unused});mockFetch.mockResolvedValue(legacyResponse(f.target));
  await expect(resolve(service,f.target.hash())).resolves.toEqual(f.target);expect(unused).not.toHaveBeenCalled();expect(mockFetch).toHaveBeenCalledTimes(1);
  const [url,options]=mockFetch.mock.calls[0],parsed=new URL(url);expect(parsed.origin).toBe(window.location.origin);expect(parsed.pathname).toBe("/api/resolve-lock-script");expect(parsed.searchParams.get("hash")).toBe(f.target.hash());expect(options).toEqual({headers:{accept:"application/json"}});
 });
 it("preserves legacy HTTP failure handling rather than treating an error as a resolved script",async()=>{
  const f=fixture(),service=new TippingService(undefined,null,f.protocol);mockFetch.mockResolvedValue({ok:false,status:503});await expect(resolve(service,f.target.hash())).rejects.toThrow(/503/);expect(mockFetch).toHaveBeenCalledTimes(1);
 });
});
