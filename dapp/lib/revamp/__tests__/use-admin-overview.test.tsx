import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ccc } from "@ckb-ccc/connector-react";
import { useAdminOverview } from "../use-admin-overview";
import { makeProfileReadScope, type ProfileReadScope } from "../profile-model";
import { adminNeedActions, adminRecordedActivity, readAdminCurrentSnapshot, readAdminFunding, readAdminOverviewMetrics, type AdminCurrentSnapshot, type AdminOverviewMetrics } from "../admin-overview-model";

let mockSigner: ccc.Signer | undefined, mockSignerInfo: object | undefined;
let mockWalletClient: object = {}, mockProtocolCell: unknown;
const mockClient = {}, mockOpen = jest.fn(), mockRefresh = jest.fn().mockResolvedValue(undefined);
const h = (letter: string) => `0x${letter.repeat(64)}` as ccc.Hex;
jest.mock("@ckb-ccc/connector-react", () => ({ccc: {...jest.requireActual("@ckb-ccc/core"), useSigner: () => mockSigner, useCcc: () => ({client: mockWalletClient, signerInfo: mockSignerInfo, open: mockOpen})}}));
jest.mock("@/lib/providers/protocol-provider", () => ({useProtocol: () => ({protocolCell: mockProtocolCell, isLoading: false, error: null, isAdmin: true, refreshProtocolData: mockRefresh})}));
jest.mock("@/lib/ckb/current-deployment", () => ({currentDeployment: {getCurrentNetwork: () => "testnet"}}));
jest.mock("../discovery-read-client", () => ({getDiscoveryReadClient: () => mockClient}));
jest.mock("../profile-model", () => ({...jest.requireActual("../profile-model"), makeProfileReadScope: jest.fn()}));
jest.mock("../admin-overview-model", () => ({...jest.requireActual("../admin-overview-model"), readAdminCurrentSnapshot: jest.fn(), readAdminFunding: jest.fn(), readAdminOverviewMetrics: jest.fn(), adminNeedActions: jest.fn(), adminRecordedActivity: jest.fn()}));
const snapshot = {protocolTypeHash: h("2"), campaigns: [], tippings: []} satisfies AdminCurrentSnapshot;
const metrics = {newUsers: {value: null, deltaPercent: null}, campaignsCreated: {value: 0, deltaPercent: null}, questParticipants: {value: null, deltaPercent: null}, coverageNote: "Current records; not a complete historical ledger."} satisfies AdminOverviewMetrics;
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(yes => {resolve = yes;}); return {promise, resolve};}
function signer(letter: string) {return {getRecommendedAddressObj: jest.fn().mockResolvedValue({script: {hash: () => h(letter)}, toString: () => `ckt-${letter}`})} as unknown as ccc.Signer;}
function setup() {
  const client = new QueryClient({defaultOptions: {queries: {retry: false, retryDelay: 0, gcTime: 0}}});
  const wrapper = ({children}: {children: React.ReactNode}) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(() => useAdminOverview(), {wrapper});
}
beforeEach(() => {
  jest.clearAllMocks(); mockSigner = signer("a"); mockSignerInfo = {signer: mockSigner}; mockWalletClient = {};
  mockProtocolCell = {outPoint: {txHash: h("1"), index: 0}, cellOutput: {type: {hash: () => h("2")}}, outputData: "0x00"};
  jest.mocked(makeProfileReadScope).mockImplementation((_client, protocolCell, address) => ({client: mockClient, protocolCell, walletLock: address.script, lockHash: address.script.hash(), address: address.toString(), protocolHash: h("2"), network: "testnet", protocol: {protocol_config: {admin_lock_hash_vec: [h("a")]}}} as unknown as ProfileReadScope));
  jest.mocked(readAdminCurrentSnapshot).mockResolvedValue(snapshot);
  jest.mocked(adminNeedActions).mockReturnValue([{id: "actual-campaign", type: "campaign", title: "Needs review", description: "Not approved", at: 1700000000000, actionLabel: "Review", href: "/campaign-admin/actual"}]);
  jest.mocked(adminRecordedActivity).mockReturnValue([{id: "actual-record", kind: "campaign", title: "Actual update", description: "Recorded timestamp", at: 1700000000000}]);
  jest.mocked(readAdminFunding).mockResolvedValue({campaignCkbShannons: 0n, tippingCkbShannons: 0n, assets: [], campaignHistory: null, tippingHistory: null, historyUnavailableReason: "History unavailable"});
  jest.mocked(readAdminOverviewMetrics).mockResolvedValue(metrics);
});

describe("Admin overview authorization and independent data", () => {
  it("queries no overview records or historical metrics while disconnected", () => {
    mockSigner = undefined; mockSignerInfo = undefined;
    const {result} = setup(); expect(result.current.access).toBe("disconnected");
    expect(result.current.actions.data).toBeNull(); expect(readAdminCurrentSnapshot).not.toHaveBeenCalled(); expect(readAdminOverviewMetrics).not.toHaveBeenCalled();
  });
  it("ignores a provider role boolean and requires the actual current wallet in protocol Admin facts", async () => {
    mockSigner = signer("b"); mockSignerInfo = {signer: mockSigner};
    const {result} = setup(); await waitFor(() => expect(result.current.access).toBe("denied"));
    expect(readAdminCurrentSnapshot).not.toHaveBeenCalled(); expect(readAdminFunding).not.toHaveBeenCalled(); expect(readAdminOverviewMetrics).not.toHaveBeenCalled();
  });
  it("shows current records and funding before slow historical proof completes", async () => {
    const slow = deferred<AdminOverviewMetrics>(); jest.mocked(readAdminOverviewMetrics).mockReturnValue(slow.promise);
    const {result} = setup(); await waitFor(() => expect(result.current.funding.data?.campaignCkbShannons).toBe(0n));
    expect(result.current.access).toBe("allowed"); expect(result.current.actions.data).toHaveLength(1); expect(result.current.activity.data).toHaveLength(1);
    expect(result.current.metrics.loading).toBe(true); expect(result.current.metrics.data).toBeNull();
    await act(async () => slow.resolve(metrics)); await waitFor(() => expect(result.current.metrics.data).toEqual(metrics));
  });
  it("changing only period reloads metrics without reloading current funding or records", async () => {
    const {result} = setup(); await waitFor(() => expect(result.current.metrics.data).toEqual(metrics));
    act(() => result.current.onPeriodChange("quarterly"));
    await waitFor(() => expect(readAdminOverviewMetrics).toHaveBeenCalledTimes(2));
    expect(result.current.period).toBe("quarterly");
    expect(jest.mocked(readAdminOverviewMetrics).mock.calls[1][2]).toBe("quarterly");
    expect(readAdminCurrentSnapshot).toHaveBeenCalledTimes(1); expect(readAdminFunding).toHaveBeenCalledTimes(1);
  });
  it("clears Admin data on wallet replacement and discards the old wallet's late records", async () => {
    const old = deferred<AdminCurrentSnapshot>(); jest.mocked(readAdminCurrentSnapshot).mockReturnValue(old.promise);
    const {result, rerender} = setup(); await waitFor(() => expect(readAdminCurrentSnapshot).toHaveBeenCalledTimes(1));
    mockSigner = signer("b"); mockSignerInfo = {signer: mockSigner}; rerender();
    expect(result.current.actions.data).toBeNull(); expect(result.current.funding.data).toBeNull();
    await waitFor(() => expect(result.current.access).toBe("denied"));
    await act(async () => old.resolve(snapshot));
    expect(result.current.access).toBe("denied"); expect(result.current.actions.data).toBeNull(); expect(readAdminFunding).not.toHaveBeenCalled();
    mockSigner = undefined; mockSignerInfo = undefined; rerender(); expect(result.current.access).toBe("disconnected");
  });
  it("discards pending Admin records when the same Signer starts returning another account", async () => {
    const old = deferred<AdminCurrentSnapshot>(); jest.mocked(readAdminCurrentSnapshot).mockReturnValue(old.promise);
    const {result} = setup(); await waitFor(() => expect(readAdminCurrentSnapshot).toHaveBeenCalledTimes(1));
    jest.mocked(mockSigner!.getRecommendedAddressObj).mockResolvedValue({script: {hash: () => h("b")}, toString: () => "ckt-b"} as Awaited<ReturnType<ccc.Signer["getRecommendedAddressObj"]>>);
    await act(async () => old.resolve(snapshot));
    await waitFor(() => expect(result.current.access).toBe("denied"));
    expect(result.current.actions.data).toBeNull(); expect(result.current.funding.data).toBeNull(); expect(result.current.activity.data).toBeNull();
    expect(readAdminFunding).not.toHaveBeenCalled(); expect(readAdminOverviewMetrics).not.toHaveBeenCalled();
  });
  it("scopes cached data to the client and protocol snapshot, including Admin revocation", async () => {
    const {result, rerender} = setup(); await waitFor(() => expect(result.current.metrics.data).toEqual(metrics));
    jest.mocked(makeProfileReadScope).mockImplementation((_client, protocolCell, address) => ({client: mockClient, protocolCell, walletLock: address.script, lockHash: address.script.hash(), protocolHash: h("2"), protocol: {protocol_config: {admin_lock_hash_vec: []}}} as unknown as ProfileReadScope));
    mockWalletClient = {}; mockProtocolCell = {...(mockProtocolCell as object), outputData: "0x01"}; rerender();
    expect(result.current.actions.data).toBeNull(); expect(result.current.metrics.data).toBeNull();
    await waitFor(() => expect(result.current.access).toBe("denied"));
  });
  it("does not replace funding errors with zero or block the other current sections", async () => {
    jest.mocked(readAdminFunding).mockRejectedValue(new Error("Funding indexer unavailable"));
    const {result} = setup(); await waitFor(() => expect(result.current.funding.error).toBe("Funding indexer unavailable"));
    expect(result.current.funding.data).toBeNull(); expect(result.current.actions.data).toHaveLength(1); expect(result.current.metrics.data).toEqual(metrics);
  });
  it("propagates current record failures and never fabricates a zero-action or zero-funding snapshot", async () => {
    jest.mocked(readAdminCurrentSnapshot).mockRejectedValue(new Error("Campaign scope invalid"));
    const {result} = setup(); await waitFor(() => expect(result.current.actions.error).toBe("Campaign scope invalid"));
    expect(result.current.actions.data).toBeNull(); expect(result.current.funding.data).toBeNull(); expect(result.current.metrics.data).toBeNull();
    expect(readAdminFunding).not.toHaveBeenCalled(); expect(readAdminOverviewMetrics).not.toHaveBeenCalled();
  });
});
