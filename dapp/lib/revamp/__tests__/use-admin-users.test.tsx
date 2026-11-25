import React from "react";
import {act, renderHook, waitFor} from "@testing-library/react";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {ccc} from "@ckb-ccc/connector-react";
import {ProtocolData} from "ssri-ckboost/types";
import {useAdminUsers} from "../use-admin-users";
import {adminUserFromCell, readAdminUser, readAdminUserJoinDates, readAdminUsers, type AdminUserRecord, type AdminUsersRegistryAdapter} from "../admin-users-model";
import {readProfileCampaigns, readProfilePoints, readProfileRewards} from "../profile-model";
import {readProfileBadges} from "../profile-badges";
import {adminUsersFixture, userHash as h} from "./admin-users-fixtures";

let mockFixture: ReturnType<typeof adminUsersFixture>, mockSigner: ccc.Signer | undefined, mockSignerInfo: object | undefined, mockProtocolCell: ccc.Cell, mockLatestCell: ccc.Cell;
let mockRow: AdminUserRecord;
let mockQaRuntime: {network: string;protocol: {typeHash: string}} | null;
const mockRefresh = jest.fn().mockResolvedValue(undefined), mockOpen = jest.fn(), mockUpdate = jest.fn(), mockGetProtocolCell = jest.fn();
jest.mock("@ckb-ccc/connector-react", () => ({ccc: {...jest.requireActual("@ckb-ccc/core"), useSigner: () => mockSigner, useCcc: () => ({client: mockFixture.client, signerInfo: mockSignerInfo, open: mockOpen})}}));
jest.mock("@/lib/providers/protocol-provider", () => ({useProtocol: () => ({protocolCell: mockProtocolCell, isLoading: false, error: null, refreshProtocolData: mockRefresh})}));
jest.mock("@/lib/providers/pending-transaction-provider", () => ({usePendingTransactions: () => ({confirmationTarget: 0})}));
jest.mock("@/lib/ckb/current-deployment", () => ({currentDeployment: {getCurrentNetwork: () => "testnet"}}));
jest.mock("@/lib/ckb/isolated-runtime.mjs", () => ({getIsolatedRuntime: () => mockQaRuntime}));
jest.mock("../discovery-read-client", () => ({getDiscoveryReadClient: () => mockFixture.client}));
jest.mock("../discovery-cells", () => ({...jest.requireActual("../discovery-cells"), readDiscoveryProtocol: jest.fn(async () => mockLatestCell)}));
jest.mock("../admin-users-model", () => ({...jest.requireActual("../admin-users-model"), readAdminUsers: jest.fn(), readAdminUser: jest.fn(), readAdminUserJoinDates: jest.fn()}));
jest.mock("../profile-model", () => ({...jest.requireActual("../profile-model"), readProfileCampaigns: jest.fn(), readProfilePoints: jest.fn(), readProfileRewards: jest.fn()}));
jest.mock("../profile-badges", () => ({readProfileBadges: jest.fn()}));
jest.mock("@/lib/services/protocol-service", () => ({ProtocolService: jest.fn().mockImplementation((signer:ccc.Signer) => ({getProtocolCell: mockGetProtocolCell, updateProtocol: (data:unknown) => mockUpdate(data,signer)}))}));
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(yes => {resolve = yes;}); return {promise, resolve};}
function setup(options: Parameters<typeof useAdminUsers>[0] = {}) {const client = new QueryClient({defaultOptions: {queries: {retry: false, retryDelay: 0, gcTime: 0}}}); const wrapper = ({children}: {children: React.ReactNode}) => <QueryClientProvider client={client}>{children}</QueryClientProvider>; return renderHook(() => useAdminUsers(options), {wrapper});}
beforeEach(() => {
  jest.clearAllMocks(); mockFixture = adminUsersFixture(); mockProtocolCell = mockFixture.protocolCell; mockLatestCell = mockProtocolCell;
  mockSigner = {client: {...mockFixture.client, waitTransaction: jest.fn().mockResolvedValue({})}, getRecommendedAddressObj: jest.fn().mockResolvedValue(mockFixture.address)} as unknown as ccc.Signer; mockSignerInfo = {signer: mockSigner};
  mockRow = adminUserFromCell(mockFixture.scope, mockFixture.userCell());
  mockQaRuntime = {network: "testnet", protocol: {typeHash: mockFixture.scope.protocolHash}};
  jest.mocked(readAdminUsers).mockResolvedValue([mockRow]); jest.mocked(readAdminUser).mockResolvedValue(mockRow); jest.mocked(readAdminUserJoinDates).mockResolvedValue({[mockRow.id]: {at: null, error: "No verified birth"}});
  jest.mocked(readProfilePoints).mockResolvedValue(3n); jest.mocked(readProfileCampaigns).mockResolvedValue({participated: [], created: [], activities: [], reviewerAssigned: false, approvedPoints: 0n}); jest.mocked(readProfileRewards).mockResolvedValue([]); jest.mocked(readProfileBadges).mockResolvedValue({badges: [], eligibilityUnavailableReason: null});
  mockGetProtocolCell.mockImplementation(async () => mockLatestCell); mockUpdate.mockImplementation(async data => {mockLatestCell = ccc.Cell.from({...mockProtocolCell, outPoint: {txHash: h("d"), index: 0}, outputData: ccc.hexFrom(ProtocolData.encode(data))}); return h("d");});
});
describe("Admin Users access and query scope", () => {
  it("reads nothing while disconnected or when the actual wallet is not an Admin", async () => {
    mockSigner = undefined; mockSignerInfo = undefined; const first = setup(); expect(first.result.current.access).toBe("disconnected"); expect(readAdminUsers).not.toHaveBeenCalled(); first.unmount();
    mockSigner = {getRecommendedAddressObj: jest.fn().mockResolvedValue(ccc.Address.fromScript({...mockFixture.lock, args: "0x99"}, mockFixture.client))} as unknown as ccc.Signer; mockSignerInfo = {signer: mockSigner};
    const second = setup(); await waitFor(() => expect(second.result.current.access).toBe("denied")); expect(readAdminUsers).not.toHaveBeenCalled(); expect(readAdminUserJoinDates).not.toHaveBeenCalled();
  });
  it("does not load profile history for the directory and does not block rows on birth proofs", async () => {
    jest.mocked(readAdminUserJoinDates).mockReturnValue(deferred<Awaited<ReturnType<typeof readAdminUserJoinDates>>>().promise);
    const {result} = setup(); await waitFor(() => expect(result.current.visible).toHaveLength(1)); expect(result.current.joined.loading).toBe(true);
    expect(readProfileCampaigns).not.toHaveBeenCalled(); expect(readProfileRewards).not.toHaveBeenCalled(); expect(readProfilePoints).not.toHaveBeenCalled();
  });
  it("reads the exact target once and loads Rewards only on demand for that target", async () => {
    const {result} = setup({userId: mockRow.id}); await waitFor(() => expect(result.current.points.data).toBe(3n)); expect(readAdminUser).toHaveBeenCalledTimes(1); expect(readAdminUsers).not.toHaveBeenCalled(); expect(readProfileRewards).not.toHaveBeenCalled();
    expect(jest.mocked(readProfilePoints).mock.calls[0][0].lockHash).toBe(mockRow.lockHash);
    act(() => result.current.onTabChange("rewards")); await waitFor(() => expect(result.current.rewards.data).toEqual([])); expect(jest.mocked(readProfileRewards).mock.calls[0][0].address).toBe(mockRow.address);
  });
  it("clears old pending results when the same Signer changes its account", async () => {
    const old = deferred<AdminUserRecord[]>(); jest.mocked(readAdminUsers).mockReturnValue(old.promise); const {result} = setup(); await waitFor(() => expect(readAdminUsers).toHaveBeenCalledTimes(1));
    jest.mocked(mockSigner!.getRecommendedAddressObj).mockResolvedValue(ccc.Address.fromScript({...mockFixture.lock, args: "0x99"}, mockFixture.client));
    await act(async () => old.resolve([mockRow])); await waitFor(() => expect(result.current.access).toBe("denied")); expect(result.current.visible).toEqual([]); expect(result.current.users.data).toBeNull(); expect(readAdminUserJoinDates).not.toHaveBeenCalled();
  });
  it("keeps manual status unknown until a protocol-matching registry is available", async () => {
    const adapter: AdminUsersRegistryAdapter = {read: jest.fn().mockResolvedValue({protocolTypeHash: h("f"), available: true, unavailableReason: null, attestations: []}), save: jest.fn()};
    const {result} = setup({registry: adapter}); await waitFor(() => expect(result.current.users.error).toMatch(/another protocol/)); expect(result.current.users.data).toBeNull(); expect(adapter.save).not.toHaveBeenCalled();
  });
  it("blocks manual saves on an unavailable deployment and never calls legacy User mutation", async () => {
    const {result} = setup(); await waitFor(() => expect(result.current.visible).toHaveLength(1)); expect(result.current.visible[0].manual).toBeNull();
    await expect(result.current.verifyIdentity(mockRow)).rejects.toThrow(/not ready yet/); expect(mockUpdate).not.toHaveBeenCalled();
  });
});
describe("explicit confirmed access updates", () => {
  it("blocks role preview and writes outside the exact opt-in QA runtime", async () => {
    const {result} = setup(); await waitFor(() => expect(result.current.access).toBe("allowed"));
    mockQaRuntime = null; await expect(result.current.previewAccess(mockRow.address, "member")).rejects.toThrow(/isolated Testnet QA protocol/);
    mockQaRuntime = {network: "testnet", protocol: {typeHash: h("f")}}; await expect(result.current.previewAccess(mockRow.address, "member")).rejects.toThrow(/isolated Testnet QA protocol/); expect(mockUpdate).not.toHaveBeenCalled();
  });
  it("does not write during preview and resolves only after commitment and exact role readback", async () => {
    const confirmation = deferred<Awaited<ReturnType<ccc.Client["waitTransaction"]>>>(); jest.mocked(mockSigner!.client.waitTransaction).mockReturnValue(confirmation.promise);
    const {result} = setup(); await waitFor(() => expect(result.current.access).toBe("allowed")); const plan = await result.current.previewAccess(mockRow.address, "member"); expect(mockUpdate).not.toHaveBeenCalled(); expect(plan.changes).toEqual(["Revoke Platform admin access"]);
    let save!: Promise<void>; act(() => {save = result.current.changeAccess(plan);}); await waitFor(() => expect(result.current.operation?.phase).toBe("confirming")); expect(mockRefresh).not.toHaveBeenCalled();
    await act(async () => {confirmation.resolve({} as Awaited<ReturnType<ccc.Client["waitTransaction"]>>); await save;}); expect(mockUpdate).toHaveBeenCalledTimes(1); expect(mockRefresh).toHaveBeenCalledTimes(1); expect(result.current.operation?.phase).toBe("confirmed");
  });
  it("rejects an obsolete protocol preview before requesting a signature", async () => {
    const {result} = setup(); await waitFor(() => expect(result.current.access).toBe("allowed")); const plan = await result.current.previewAccess(mockRow.address, "member"); mockLatestCell = ccc.Cell.from({...mockProtocolCell, outPoint: {txHash: h("e"), index: 0}});
    await act(async () => {await expect(result.current.changeAccess(plan)).rejects.toThrow(/changed after preview/);}); expect(mockUpdate).not.toHaveBeenCalled();
  });
  it("retries confirmation of a pending transaction without sending another role update", async () => {
    jest.mocked(mockSigner!.client.waitTransaction).mockResolvedValueOnce(undefined).mockResolvedValueOnce({} as Awaited<ReturnType<ccc.Client["waitTransaction"]>>);
    const {result} = setup(); await waitFor(() => expect(result.current.access).toBe("allowed")); const plan = await result.current.previewAccess(mockRow.address, "member");
    await act(async () => {await expect(result.current.changeAccess(plan)).rejects.toThrow(/not confirmed/);});
    await act(async () => {await result.current.changeAccess(plan);}); expect(mockUpdate).toHaveBeenCalledTimes(1); expect(mockSigner!.client.waitTransaction).toHaveBeenCalledTimes(2);
  });
  it("keeps the exact access transaction attempt when the network loses its acknowledgement", async () => {
    const native=ccc.Cell.from({outPoint:{txHash:h("c"),index:0},cellOutput:{capacity:10000000000n,lock:mockFixture.lock},outputData:"0x"});let actual:ccc.Transaction|null=null;
    mockSigner!.client.getCell=jest.fn(async point=>ccc.OutPoint.from(point).eq(native.outPoint)?native:mockProtocolCell);
    mockSigner!.client.sendTransaction=jest.fn(async tx=>{actual=ccc.Transaction.from(tx);mockLatestCell=ccc.Cell.from({outPoint:{txHash:actual.hash(),index:0},cellOutput:actual.outputs[0],outputData:actual.outputsData[0]});throw Error("Acknowledgement lost");});
    mockSigner!.sendTransaction=jest.fn(async function(this:ccc.Signer,tx:ccc.TransactionLike){return this.client.sendTransaction(tx);});
    mockUpdate.mockImplementation(async(data,safe:ccc.Signer)=>safe.sendTransaction(ccc.Transaction.from({inputs:[{previousOutput:mockProtocolCell.outPoint},{previousOutput:native.outPoint}],outputs:[mockProtocolCell.cellOutput,{capacity:9900000000n,lock:mockFixture.lock}],outputsData:[ccc.hexFrom(ProtocolData.encode(data)),"0x"]})));
    const {result}=setup();await waitFor(()=>expect(result.current.access).toBe("allowed"));const plan=await result.current.previewAccess(mockRow.address,"member");
    await act(async()=>{await expect(result.current.changeAccess(plan)).rejects.toThrow(/Acknowledgement lost.*Pending transaction/);});expect(result.current.operation?.transactionHash).toBe(actual!.hash());
    await act(async()=>{await result.current.changeAccess(plan);});expect(mockUpdate).toHaveBeenCalledTimes(1);expect(mockSigner!.client.sendTransaction).toHaveBeenCalledTimes(1);
  });
});
