import {ccc} from "@ckb-ccc/connector-react";
import {adminUsersRegistryAdapter, readAdminRegistry, readProtocolAdminRegistry, saveAdminTipSettings,saveAdminRewardPeriod} from "../admin-registry-service";
import {decodeAdminRegistry, encodeAdminRegistry, registryCanonical, type AdminRegistryData} from "../admin-registry-model";
import {adminUserFromCell, makeAdminVerificationPayload, readAdminUser} from "../admin-users-model";
import {adminUsersFixture, userHash as h} from "./admin-users-fixtures";
import {readDiscoveryProtocol} from "../discovery-cells";

let mockRuntime: {protocol: {typeHash: string}} | null, mockBeforeSend: (() => void) | null;
const mockSend = jest.fn(); let count = 0;
jest.mock("@ckb-ccc/connector-react", () => ({ccc: jest.requireActual("@ckb-ccc/core")}));
jest.mock("@/lib/ckb/isolated-runtime.mjs", () => ({getIsolatedRuntime: () => mockRuntime}));
jest.mock("../discovery-cells", () => ({...jest.requireActual("../discovery-cells"), readDiscoveryProtocol: jest.fn()}));
jest.mock("../admin-users-model", () => ({...jest.requireActual("../admin-users-model"), readAdminUser: jest.fn()}));
jest.mock("@/lib/ckb/transaction-wrapper", () => ({sendTransactionWithFeeRetry: (...args: unknown[]) => mockSend(...args)}));
function fixture() {
  const f = adminUsersFixture(), uuid = `0x${(++count).toString(16).padStart(64, "0")}` as ccc.Hex;
  const codeType = ccc.Script.from({codeHash: "0x00000000000000000000000000000000000000000000000000545950455f4944", hashType: "type", args: h("e")});
  const script = ccc.Script.from({codeHash: codeType.hash(), hashType: "type", args: ccc.hexFrom(ccc.bytesConcat(uuid, f.scope.protocolHash))});
  const data: AdminRegistryData = {schema: "ckboost-admin-registry/v1", protocolTypeHash: f.scope.protocolHash, revision: "0", tipping: {expirationSeconds: "86400", thresholdsShannons: ["100"], approverLockHashes: []}, attestations: [], periods: []};
  const code = ccc.Cell.from({outPoint: {txHash: h("e"), index: 0}, cellOutput: {capacity: 100000000000n, lock: f.lock, type: codeType}, outputData: "0x010203"});
  let current = ccc.Cell.from({outPoint: {txHash: h("d"), index: 0}, cellOutput: {capacity: 100000000000n, lock: script, type: script}, outputData: encodeAdminRegistry(data)});
  const initial = current, actorCapacity = ccc.Cell.from({outPoint: {txHash: uuid, index: 1}, cellOutput: {capacity: 10000000000n, lock: f.lock}, outputData: "0x"});
  let captured: ccc.Transaction | null = null;
  const row = adminUserFromCell(f.scope, f.userCell()), payload = makeAdminVerificationPayload(f.scope, row);
  process.env.NEXT_PUBLIC_CKBOOST_ADMIN_REGISTRY = JSON.stringify({schema: "ckboost-admin-registry-deployment/v1", network: "testnet", protocolTypeHash: f.scope.protocolHash, typeScript: script, codeTypeScript: codeType, codeDataHash: ccc.hashCkb(code.outputData)});
  mockRuntime = {protocol: {typeHash: f.scope.protocolHash}}; mockBeforeSend = null;
  f.client.findCellsPaged = jest.fn(async search => ({cells: ccc.Script.from(search.script).eq(script) ? [current] : ccc.Script.from(search.script).eq(codeType) ? [code] : [], lastCursor: "done"}));
  f.client.getCellLive = jest.fn(async outPoint => ccc.OutPoint.from(outPoint).eq(code.outPoint) ? code : current);
  f.client.getCell = jest.fn(async outPoint => ccc.OutPoint.from(outPoint).eq(actorCapacity.outPoint) ? actorCapacity : initial);
  f.client.sendTransaction = jest.fn(async tx => {captured = ccc.Transaction.from(tx); current = ccc.Cell.from({outPoint: {txHash: captured.hash(), index: 0}, cellOutput: captured.outputs[0], outputData: captured.outputsData[0]}); return captured.hash();});
  f.client.waitTransaction = jest.fn().mockResolvedValue({});
  f.client.getTransaction = jest.fn(async () => captured ? ({transaction: captured, status: "committed", blockNumber: 10n} as Awaited<ReturnType<ccc.Client["getTransaction"]>>) : undefined);
  const signer = {client: f.client, getRecommendedAddressObj: jest.fn().mockResolvedValue(f.address), sendTransaction: jest.fn(async function(this: ccc.Signer, tx: ccc.TransactionLike) {return this.client.sendTransaction(tx);})} as unknown as ccc.Signer;
  jest.mocked(readDiscoveryProtocol).mockResolvedValue(f.protocolCell); jest.mocked(readAdminUser).mockResolvedValue(row);
  mockSend.mockImplementation(async (guarded: ccc.Signer, tx: ccc.Transaction) => {tx.inputs.push(ccc.CellInput.from({previousOutput:actorCapacity.outPoint})); tx.outputs.push(ccc.CellOutput.from({capacity:9900000000n,lock:f.lock})); tx.outputsData.push("0x"); mockBeforeSend?.(); return guarded.sendTransaction(tx);});
  const receiptKey = `ckboost:admin-registry-pending:testnet:${f.scope.protocolHash}:${script.hash()}:${f.scope.lockHash}`;
  const seedReceipt = (tx: ccc.Transaction, txHash = tx.hash(), resultHash = ccc.hashCkb(tx.outputsData[0]), action: unknown = payload) => {localStorage.setItem(receiptKey, JSON.stringify({schema: "ckboost-admin-registry-pending/v1", transactionHash: txHash, resultHash, actionHash: ccc.hashCkb(ccc.bytesFrom(registryCanonical(action), "utf8"))})); f.client.getTransaction = jest.fn().mockResolvedValue({transaction: tx, status: "committed", blockNumber: 10n});};
  return {...f, signer, row, payload, script, code, codeType, data, receiptKey, seedReceipt, current: () => current, captured: () => captured, setCurrent: (cell: ccc.Cell) => {current = cell;}};
}
beforeEach(() => {jest.clearAllMocks(); localStorage.clear();});
afterEach(() => {jest.restoreAllMocks(); delete process.env.NEXT_PUBLIC_CKBOOST_ADMIN_REGISTRY;});
describe("Admin registry deployment and manual proof", () => {
  it("permits public exact policy proof without inventing Admin access or allowing its management wrapper",async()=>{
    const f=fixture(),wallet=ccc.Script.from({...f.lock,args:"0x99"}),scope={...f.scope,walletLock:wallet,lockHash:wallet.hash(),address:ccc.Address.fromScript(wallet,f.client).toString()};
    await expect(readProtocolAdminRegistry(scope)).resolves.toMatchObject({available:true,data:f.data});
    await expect(readAdminRegistry(scope)).rejects.toThrow(/Only current platform administrators/);
    expect(mockSend).not.toHaveBeenCalled();
  });
  it("does not trust a code-cell identity whose bytes no longer match the pinned Registry executable",async()=>{
    const f=fixture();f.client.findCellsPaged=jest.fn(async search=>({cells:ccc.Script.from(search.script).eq(f.script)?[f.current()]:[ccc.Cell.from({...f.code,outputData:"0xdeadbeef"})],lastCursor:"done"}));
    await expect(readProtocolAdminRegistry(f.scope)).rejects.toThrow(/registry executable does not match/);
  });
  it("rejects an indexed Registry state already spent instead of accepting its old Approver policy",async()=>{
    const f=fixture();f.client.getCellLive=jest.fn(async outPoint=>ccc.OutPoint.from(outPoint).eq(f.code.outPoint)?f.code:undefined);
    await expect(readProtocolAdminRegistry(f.scope)).rejects.toThrow(/no longer live/);
  });
  it("rejects a forged decoded protocol object that disagrees with the canonical cell",async()=>{
    const f=fixture(),scope={...f.scope,protocol:{...f.scope.protocol,last_updated:0n}};
    await expect(readProtocolAdminRegistry(scope)).rejects.toThrow(/canonical current cell/);
  });
  it("leaves an unconfigured deployment unavailable and rejects another protocol pin", async () => {
    const f = fixture(); delete process.env.NEXT_PUBLIC_CKBOOST_ADMIN_REGISTRY; await expect(readAdminRegistry(f.scope)).resolves.toMatchObject({available: false, data: null});
    process.env.NEXT_PUBLIC_CKBOOST_ADMIN_REGISTRY = JSON.stringify({schema: "ckboost-admin-registry-deployment/v1", network: "testnet", protocolTypeHash: h("f"), typeScript: f.script, codeTypeScript: f.script}); await expect(readAdminRegistry(f.scope)).rejects.toThrow(/does not match/);
  });
  it("normalizes decimal output indices, confirms the exact transaction and current action before success", async () => {
    const f = fixture(), check = jest.fn().mockResolvedValue(undefined); const result = await adminUsersRegistryAdapter.save(f.scope, f.signer, f.payload, check);
    expect(result.transactionHash).toBe(f.captured()!.hash()); expect(f.client.waitTransaction).toHaveBeenCalledWith(result.transactionHash, 6, 300000, 2000); expect(localStorage.getItem(f.receiptKey)).toBeNull();
    const entry = decodeAdminRegistry(f.current().outputData).attestations[0]; expect(entry.userOutPoint.index).toBe("0x0"); expect(entry.walletLockHash).toBe(f.row.lockHash); expect(entry.userTypeHash).toBe(f.row.typeHash); expect(jest.mocked(readAdminUser).mock.calls.length).toBeGreaterThanOrEqual(3); expect(check).toHaveBeenCalled();
    const state = await adminUsersRegistryAdapter.read(f.scope); expect(state.attestations[0].transactionHash).toBe(f.current().outPoint.txHash); expect(state.attestations[0]).toHaveProperty("userOutPoint", entry.userOutPoint);
  });
  it("rechecks a changed target at wallet send and does not broadcast stale verification", async () => {
    const f = fixture(); mockBeforeSend = () => jest.mocked(readAdminUser).mockResolvedValue({...f.row, cell: ccc.Cell.from({...f.row.cell, outPoint: {txHash: h("c"), index: 0}})});
    await expect(adminUsersRegistryAdapter.save(f.scope, f.signer, f.payload, async () => {})).rejects.toThrow(/target profile changed/); expect(f.client.sendTransaction).not.toHaveBeenCalled(); expect(localStorage.getItem(f.receiptKey)).toBeNull();
  });
  it("rejects Admin revocation between preview and send without broadcasting", async () => {
    const f = fixture(); mockBeforeSend = () => {const {ProtocolData} = jest.requireActual("ssri-ckboost/types"); const data = ProtocolData.decode(f.protocolCell.outputData); data.protocol_config.admin_lock_hash_vec = []; jest.mocked(readDiscoveryProtocol).mockResolvedValue(ccc.Cell.from({...f.protocolCell, outputData: ccc.hexFrom(ProtocolData.encode(data))}));};
    await expect(adminUsersRegistryAdapter.save(f.scope, f.signer, f.payload, async () => {})).rejects.toThrow(/no longer an administrator/); expect(f.client.sendTransaction).not.toHaveBeenCalled();
  });
  it("retains an actual pending receipt and retries confirmation without another broadcast", async () => {
    const f = fixture(); jest.mocked(f.client.waitTransaction).mockResolvedValueOnce(undefined).mockResolvedValueOnce({} as Awaited<ReturnType<ccc.Client["waitTransaction"]>>);
    await expect(adminUsersRegistryAdapter.save(f.scope, f.signer, f.payload, async () => {})).rejects.toThrow(/awaiting confirmation/); const pending = JSON.parse(localStorage.getItem(f.receiptKey)!); expect(pending.transactionHash).toBe(f.captured()!.hash());
    await expect(adminUsersRegistryAdapter.save(f.scope, f.signer, f.payload, async () => {})).resolves.toMatchObject({transactionHash: pending.transactionHash}); expect(mockSend).toHaveBeenCalledTimes(1);
  });
  it("keeps an in-memory receipt if browser storage fails after broadcast", async () => {
    const f = fixture(); const storage = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {throw new Error("Storage unavailable");});
    jest.mocked(f.client.waitTransaction).mockResolvedValueOnce(undefined).mockResolvedValueOnce({} as Awaited<ReturnType<ccc.Client["waitTransaction"]>>);
    await expect(adminUsersRegistryAdapter.save(f.scope, f.signer, f.payload, async () => {})).rejects.toThrow(/awaiting confirmation/); storage.mockRestore();
    await expect(adminUsersRegistryAdapter.save(f.scope, f.signer, f.payload, async () => {})).resolves.toMatchObject({transactionHash: f.captured()!.hash()}); expect(mockSend).toHaveBeenCalledTimes(1);
  });
  it("records the exact attempted body before a lost network acknowledgement and never rebroadcasts on confirmation retry", async () => {
    const f = fixture(), accepted = f.client.sendTransaction;
    f.client.sendTransaction = jest.fn(async (...args) => {await accepted(...args); throw new Error("Acknowledgement lost");});
    await expect(adminUsersRegistryAdapter.save(f.scope, f.signer, f.payload, async () => {})).rejects.toThrow(/Acknowledgement lost.*Pending transaction/);
    const pending = JSON.parse(localStorage.getItem(f.receiptKey)!); expect(pending.transactionHash).toBe(f.captured()!.hash());
    await expect(adminUsersRegistryAdapter.save(f.scope, f.signer, f.payload, async () => {})).resolves.toMatchObject({transactionHash: pending.transactionHash}); expect(mockSend).toHaveBeenCalledTimes(1);
  });
  it("rejects an imported pending receipt whose actual transaction body does not match its hash", async () => {
    const f = fixture(), tx = ccc.Transaction.from({outputs: [f.current().cellOutput], outputsData: [f.current().outputData]}); f.seedReceipt(tx, h("a"));
    await expect(adminUsersRegistryAdapter.save(f.scope, f.signer, f.payload, async () => {})).rejects.toThrow(/independently confirmed/); expect(mockSend).not.toHaveBeenCalled(); expect(localStorage.getItem(f.receiptKey)).not.toBeNull();
  });
  it("rejects a real old registry transaction falsely imported as the requested manual verification", async () => {
    const f = fixture(), tx = ccc.Transaction.from({outputs: [f.current().cellOutput], outputsData: [f.current().outputData]}); f.seedReceipt(tx);
    await expect(adminUsersRegistryAdapter.save(f.scope, f.signer, f.payload, async () => {})).rejects.toThrow(/does not contain the requested change/); expect(mockSend).not.toHaveBeenCalled();
  });
  it("applies the same exact action readback rule to tip settings", async () => {
    const f = fixture(), settings = {...f.data.tipping, expirationSeconds: "43200"};
    await expect(saveAdminTipSettings(f.scope, f.signer, settings, async () => {})).resolves.toMatchObject({transactionHash: expect.any(String)}); expect(decodeAdminRegistry(f.current().outputData).tipping).toEqual(settings);
  });
  const period=(asset:import("../admin-rewards-model").AdminRewardsAsset):import("../admin-rewards-model").AdminRewardPeriod=>({id:"actual-period",name:"Actual period",startAtMs:1700000000000,endAtMs:1700100000000,timeZone:"UTC",asset,totalAmount:"10000",tiers:[{fromRank:1,toRank:1,shareBps:2500},{fromRank:2,toRank:2,shareBps:2500},{fromRank:3,toRank:3,shareBps:2500},{fromRank:4,toRank:10,shareBps:2500}],eligibility:{minimumPoints:"0",minimumApprovedQuests:0,verification:"none"}});
  it("saves a current accepted asset period and independently confirms its exact registry action",async()=>{
    const f=fixture(),request=period({id:"ckb",kind:"ckb",symbol:"CKB",decimals:8});await expect(saveAdminRewardPeriod(f.scope,f.signer,request,async()=>{})).resolves.toMatchObject({transactionHash:expect.any(String)});expect(decodeAdminRegistry(f.current().outputData).periods).toEqual([request]);
  });
  it("rejects stale/forged Points and UDT full scripts after the fresh protocol read",async()=>{
    const f=fixture(),foreign={codeHash:h("6"),hashType:"type" as const,args:h("f")};
    for(const asset of [{id:ccc.Script.from(foreign).hash(),kind:"points" as const,symbol:"Points",decimals:0,typeScript:foreign},{id:ccc.Script.from(foreign).hash(),kind:"udt" as const,symbol:"Old token",decimals:8,typeScript:foreign}])await expect(saveAdminRewardPeriod(f.scope,f.signer,period(asset),async()=>{})).rejects.toThrow(/no longer accepted/);
    expect(mockSend).not.toHaveBeenCalled();expect(f.client.sendTransaction).not.toHaveBeenCalled();
  });
  it("revalidates the period asset again at the final actual client send boundary",async()=>{
    const f=fixture(),points={codeHash:h("6"),hashType:"type" as const,args:f.scope.protocolHash},request=period({id:ccc.Script.from(points).hash(),kind:"points",symbol:"Points",decimals:0,typeScript:points});
    mockBeforeSend=()=>{const {ProtocolData}=jest.requireActual("ssri-ckboost/types"),data=ProtocolData.decode(f.protocolCell.outputData);data.protocol_config.script_code_hashes.ckb_boost_points_udt_type_code_hash=h("7");jest.mocked(readDiscoveryProtocol).mockResolvedValue(ccc.Cell.from({...f.protocolCell,outputData:ccc.hexFrom(ProtocolData.encode(data))}));};
    await expect(saveAdminRewardPeriod(f.scope,f.signer,request,async()=>{})).rejects.toThrow(/permissions changed|no longer accepted/);expect(f.client.sendTransaction).not.toHaveBeenCalled();expect(localStorage.getItem(f.receiptKey)).toBeNull();
  });
});
