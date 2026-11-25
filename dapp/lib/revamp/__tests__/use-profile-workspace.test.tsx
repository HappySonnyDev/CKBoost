import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useProfileWorkspace } from "../use-profile-workspace";
import { makeProfileReadScope, readProfileCampaigns, readProfileIdentity, readProfilePoints, readProfileRewards, type ProfileIdentity, type ProfileReadScope } from "../profile-model";
import type { ccc } from "@ckb-ccc/connector-react";

let mockSigner: ccc.Signer | undefined;
let mockSignerInfo: object | undefined;
let mockWalletClient: object = {};
const mockReadClient = {};
const mockOpen = jest.fn();
const mockRefresh = jest.fn().mockResolvedValue(undefined);
let mockProtocolCell: unknown;
let mockProtocolLoading = false;
const mockUpdateName = jest.fn();
jest.mock("@ckb-ccc/connector-react", () => ({ccc: {...jest.requireActual("@ckb-ccc/core"), useSigner: () => mockSigner, useCcc: () => ({client: mockWalletClient, signerInfo: mockSignerInfo, open: mockOpen})}}));
jest.mock("@/lib/providers/protocol-provider", () => ({useProtocol: () => ({protocolCell: mockProtocolCell, isLoading: mockProtocolLoading, error: null, refreshProtocolData: mockRefresh})}));
jest.mock("@/lib/providers/pending-transaction-provider", () => ({usePendingTransactions: () => ({confirmationTarget: 0})}));
jest.mock("@/lib/ckb/current-deployment", () => ({currentDeployment: {getCurrentNetwork: () => "testnet"}}));
jest.mock("../discovery-read-client", () => ({getDiscoveryReadClient: () => mockReadClient}));
jest.mock("@/lib/services/user-service", () => ({UserService: jest.fn().mockImplementation(() => ({updateProfileDisplayName: mockUpdateName}))}));
jest.mock("../profile-model", () => ({...jest.requireActual("../profile-model"), makeProfileReadScope: jest.fn(), readProfileIdentity: jest.fn(), readProfilePoints: jest.fn(), readProfileCampaigns: jest.fn(), readProfileRewards: jest.fn()}));
const h = (value: string) => `0x${value.repeat(64)}` as ccc.Hex;
function deferred<T>() {let resolve!: (value: T) => void; let reject!: (reason?: unknown) => void; const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};}
function signer(letter: string) {
  const address = {script: {hash: () => h(letter)}, toString: () => `ckt-${letter}`};
  return {getRecommendedAddressObj: jest.fn().mockResolvedValue(address), client: {waitTransaction: jest.fn().mockResolvedValue({transaction: {}})}} as unknown as ccc.Signer;
}
function identity(scope: ProfileReadScope, name = "Old name"): ProfileIdentity {
  return {address: scope.address, lockHash: scope.lockHash, userTypeId: h("d"), displayName: name, lastActiveAt: 1700000000000, verifiedTelegram: false,
    userCell: {outPoint: {txHash: h("e"), index: 0}} as unknown as ccc.Cell, user: {submission_records: []} as unknown as ProfileIdentity["user"]};
}
function setup() {
  const client = new QueryClient({defaultOptions: {queries: {retry: false, retryDelay: 0, gcTime: 0}}});
  const wrapper = ({children}: {children: React.ReactNode}) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return {...renderHook(() => useProfileWorkspace(), {wrapper}), client};
}
beforeEach(() => {
  jest.clearAllMocks();
  mockSigner = signer("a"); mockSignerInfo = {signer: mockSigner}; mockWalletClient = {}; mockProtocolLoading = false;
  mockProtocolCell = {outPoint: {txHash: h("1"), index: 0}, cellOutput: {type: {hash: () => h("2")}}, outputData: "0x00"};
  jest.mocked(makeProfileReadScope).mockImplementation((_client, cell, address) => ({client: mockReadClient, protocolCell: cell, address: address.toString(), walletLock: address.script, lockHash: address.script.hash(), protocolHash: h("2"), network: "testnet",
    protocol: {protocol_config: {admin_lock_hash_vec: [], script_code_hashes: {ckb_boost_user_type_code_hash: h("6")}}, endorsers_whitelist: []}} as unknown as ProfileReadScope));
  jest.mocked(readProfileIdentity).mockImplementation(async scope => identity(scope));
  jest.mocked(readProfilePoints).mockResolvedValue(3n);
  jest.mocked(readProfileCampaigns).mockResolvedValue({created: [], participated: [], activities: [], reviewerAssigned: false, approvedPoints: 0n});
  jest.mocked(readProfileRewards).mockResolvedValue([]);
  mockUpdateName.mockResolvedValue(h("f"));
});
afterEach(() => {jest.restoreAllMocks();});

describe("scoped profile workspace queries", () => {
  it("does not query profile or history while disconnected", () => {
    mockSigner = undefined; mockSignerInfo = undefined;
    const {result} = setup();
    expect(result.current.status).toBe("disconnected");
    expect(result.current.identity).toBeNull();
    expect(readProfileIdentity).not.toHaveBeenCalled(); expect(readProfileRewards).not.toHaveBeenCalled();
  });
  it("renders spendable Points independently while identity loads and leaves Rewards lazy", async () => {
    const pending = deferred<ProfileIdentity>();
    jest.mocked(readProfileIdentity).mockReturnValue(pending.promise);
    const {result} = setup();
    await waitFor(() => expect(result.current.points.data).toBe(3n));
    expect(result.current.status).toBe("loading"); expect(result.current.identity).toBeNull();
    expect(readProfileRewards).not.toHaveBeenCalled();
    const scope = jest.mocked(makeProfileReadScope).mock.results[0].value as ProfileReadScope;
    await act(async () => pending.resolve(identity(scope)));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => result.current.onTabChange("rewards"));
    await waitFor(() => expect(result.current.rewards.data).toEqual([]));
    expect(readProfileRewards).toHaveBeenCalledTimes(1);
  });
  it("clears the old wallet immediately and ignores its delayed queries after account replacement", async () => {
    const old = deferred<ProfileIdentity>();
    jest.mocked(readProfileIdentity).mockImplementation(scope => scope.lockHash === h("a") ? old.promise : Promise.resolve(identity(scope, "Wallet B")));
    jest.mocked(readProfilePoints).mockImplementation(async scope => scope.lockHash === h("a") ? 1n : 2n);
    const {result, rerender} = setup();
    await waitFor(() => expect(result.current.points.data).toBe(1n));
    mockSigner = signer("b"); mockSignerInfo = {signer: mockSigner}; rerender();
    expect(result.current.identity).toBeNull(); expect(result.current.points.data).toBeNull();
    await waitFor(() => expect(result.current.identity?.displayName).toBe("Wallet B"));
    const scope = jest.mocked(makeProfileReadScope).mock.results[0].value as ProfileReadScope;
    await act(async () => old.resolve(identity(scope, "Wallet A stale")));
    expect(result.current.identity?.displayName).toBe("Wallet B"); expect(result.current.points.data).toBe(2n);
    mockSigner = undefined; mockSignerInfo = undefined; rerender();
    expect(result.current.status).toBe("disconnected"); expect(result.current.identity).toBeNull(); expect(result.current.points.data).toBeNull();
  });
  it("treats client/protocol changes as a new scope even for the same wallet", async () => {
    const {result, rerender} = setup();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    mockWalletClient = {};
    mockProtocolCell = {...(mockProtocolCell as object), outPoint: {txHash: h("3"), index: 0}};
    rerender();
    expect(result.current.identity).toBeNull(); expect(result.current.points.data).toBeNull();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(readProfileIdentity).toHaveBeenCalledTimes(2);
  });
  it("separates a real no-user empty state from an unavailable Points balance", async () => {
    jest.mocked(readProfileIdentity).mockImplementation(async scope => ({...identity(scope), userCell: null, userTypeId: null, user: null, displayName: null}));
    jest.mocked(readProfilePoints).mockRejectedValue(new Error("Points indexer unavailable"));
    const {result} = setup();
    await waitFor(() => expect(result.current.status).toBe("no-user"));
    await waitFor(() => expect(result.current.points.error).toContain("Points indexer unavailable"));
    expect(result.current.points.data).toBeNull();
    await waitFor(() => expect(result.current.campaigns.data).toEqual({created: [], participated: []}));
    expect(result.current.identity?.userTypeId).toBeNull();
  });
});

describe("display name authorized transaction", () => {
  it("waits for committed confirmation and an indexed new name before reporting success", async () => {
    const confirmation = deferred<unknown>();
    jest.mocked(mockSigner!.client.waitTransaction).mockReturnValue(confirmation.promise as ReturnType<ccc.Client["waitTransaction"]>);
    const {result} = setup();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    let save!: Promise<void>;
    act(() => {save = result.current.onSaveName("New name");});
    await waitFor(() => expect(result.current.nameOperation?.phase).toBe("confirming"));
    expect(result.current.identity?.displayName).toBe("Old name");
    expect(mockUpdateName).toHaveBeenCalledWith("New name");
    jest.mocked(readProfileIdentity).mockImplementation(async scope => identity(scope, "New name"));
    await act(async () => {confirmation.resolve({transaction: {}}); await save;});
    await waitFor(() => expect(result.current.identity?.displayName).toBe("New name"));
    expect(result.current.nameOperation?.phase).toBe("confirmed");
  });
  it("preserves the old display name on proxy or wallet failure", async () => {
    mockUpdateName.mockRejectedValue(new Error("Proxy validation unavailable"));
    const {result} = setup();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => {await expect(result.current.onSaveName("New name")).rejects.toThrow("Proxy validation unavailable");});
    expect(result.current.nameOperation?.phase).toBe("error");
    expect(result.current.identity?.displayName).toBe("Old name");
    expect(mockSigner!.client.waitTransaction).not.toHaveBeenCalled();
  });
  it("rechecks the actual recommended lock before invoking any write service", async () => {
    const {result} = setup();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    jest.mocked(mockSigner!.getRecommendedAddressObj).mockResolvedValue({script: {hash: () => h("b")}, toString: () => "ckt-b"} as unknown as ccc.Address);
    await act(async () => {await expect(result.current.onSaveName("New name")).rejects.toThrow(/account changed/);});
    expect(mockUpdateName).not.toHaveBeenCalled();
  });
  it("suppresses stale confirmation success after switching to a different wallet", async () => {
    const confirmation = deferred<unknown>();
    jest.mocked(mockSigner!.client.waitTransaction).mockReturnValue(confirmation.promise as ReturnType<ccc.Client["waitTransaction"]>);
    const {result, rerender} = setup(); await waitFor(() => expect(result.current.status).toBe("ready"));
    let save!: Promise<void>;
    act(() => {save = result.current.onSaveName("Wallet A renamed");});
    const outcome = save.catch(error => error);
    await waitFor(() => expect(result.current.nameOperation?.phase).toBe("confirming"));
    mockSigner = signer("b"); mockSignerInfo = {signer: mockSigner}; rerender();
    await waitFor(() => expect(result.current.identity?.address).toBe("ckt-b"));
    await act(async () => {confirmation.resolve({transaction: {}}); expect(await outcome).toBeInstanceOf(Error);});
    expect(result.current.identity?.displayName).toBe("Old name");
    expect(result.current.nameOperation).toBeNull();
  });
  it("retries confirmation of the same pending name without broadcasting a second transaction", async () => {
    jest.mocked(mockSigner!.client.waitTransaction).mockRejectedValueOnce(new Error("Confirmation timed out"));
    const {result} = setup(); await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => {await expect(result.current.onSaveName("New name")).rejects.toThrow("Confirmation timed out");});
    jest.mocked(readProfileIdentity).mockImplementation(async scope => identity(scope, "New name"));
    await act(async () => {await result.current.onSaveName("New name");});
    expect(mockUpdateName).toHaveBeenCalledTimes(1);
    expect(mockSigner!.client.waitTransaction).toHaveBeenCalledTimes(2);
    expect(result.current.nameOperation?.phase).toBe("confirmed");
  });
  it("cannot bypass pending transaction protection by refreshing or replacing the protocol outpoint", async () => {
    jest.mocked(mockSigner!.client.waitTransaction).mockRejectedValueOnce(new Error("Confirmation timed out"));
    const {result, rerender} = setup(); await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => {await expect(result.current.onSaveName("New name")).rejects.toThrow("Confirmation timed out");});
    act(() => result.current.onRetry());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    mockProtocolCell = {...(mockProtocolCell as object), outPoint: {txHash: h("4"), index: 0}};
    rerender(); await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => {await expect(result.current.onSaveName("Different name")).rejects.toThrow(/still awaiting confirmation/);});
    jest.mocked(readProfileIdentity).mockImplementation(async scope => identity(scope, "New name"));
    await act(async () => {await result.current.onSaveName("New name");});
    expect(mockUpdateName).toHaveBeenCalledTimes(1);
  });
});
