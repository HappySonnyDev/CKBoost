import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ccc } from "@ckb-ccc/connector-react";
import { ProtocolData } from "ssri-ckboost/types";
import { TippingProvider, useTippingContext, type TippingInfo } from "./tipping-provider";
import { Tippings } from "@/components/tippings";

let mockSigner: ccc.Signer | undefined, mockClient: ccc.Client, mockProtocolCell: ccc.Cell;
let mockWalletLock: ccc.Script;
const mockAll = jest.fn(), mockApproved = jest.fn(), mockFunding = jest.fn(), mockWrite = jest.fn();
const mockReplaced = jest.fn();
const mockUnsubscribe = jest.fn();
let mockPendingComment: (() => void) | undefined;
jest.mock("@ckb-ccc/connector-react", () => ({ ccc: { ...jest.requireActual("@ckb-ccc/core"),
  useSigner: () => mockSigner, useCcc: () => ({ client: mockClient }),
}, ssri: { ExecutorJsonRpc: jest.fn() } }));
jest.mock("../services/tipping-service", () => ({
  TippingService: jest.fn().mockImplementation(() => ({
    fetchTippingsForProtocol: (...args: unknown[]) => mockAll(...args),
    loadApprovedTippings: (...args: unknown[]) => mockApproved(...args),
    getFundingSummary: (...args: unknown[]) => mockFunding(...args),
    updateTipping: mockWrite, fundProtocolWithCKB: mockWrite, fundProtocolWithUDT: mockWrite,
  })), InsufficientTippingFundingError: class extends Error {},
}));
jest.mock("ssri-ckboost", () => ({ createScopedLogger: () => ({ info: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() }) }), { virtual: true });
jest.mock("ssri-ckboost/tipping", () => ({ Tipping: jest.fn() }), { virtual: true });
jest.mock("../ckb/deployment-manager", () => ({ deploymentManager: { getCurrentNetwork: () => "testnet" } }));
jest.mock("@/components/tipping-card", () => ({ TippingCard: ({ tipping, onComment }: { tipping: TippingInfo; onComment: (id: string, value: string) => void }) => {
  if (tipping.typeId === `0x${"62".repeat(32)}`) mockPendingComment = () => onComment(tipping.typeId!, "Local interaction");
  return <div data-tip-id={tipping.typeId} data-comment-count={tipping.comments.length}>{tipping.metadata.contribution_title}<button data-testid={`comment-${tipping.typeId}`} onClick={() => onComment(tipping.typeId!, "Local interaction")}>Comment</button></div>;
} }));
jest.mock("@/components/tipping-funding-panel", () => ({ TippingFundingPanel: () => null }));
jest.mock("@/hooks/use-social-interactions", () => ({ useSocialInteractions: () => ({ stats: {} }) }));
jest.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: jest.fn() }) }));
jest.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams({ tipping: `0x${"62".repeat(32)}` }) }));
const h = (byte: string) => `0x${byte.repeat(32)}` as ccc.Hex;
const adminLock = ccc.Script.from({ codeHash: h("11"), hashType: "type", args: h("12") });
const memberLock = ccc.Script.from({ codeHash: h("11"), hashType: "type", args: h("13") });
const approvedId = h("61"), pendingId = h("62");
const chainProtocol = { protocol_config: { admin_lock_hash_vec: [adminLock.hash()] }, tippings_approved: [approvedId], tipping_config: { approval_requirement_thresholds: [] } };
const memberProtocol = { ...chainProtocol, protocol_config: { admin_lock_hash_vec: [] } };
// The provider's editable role flags deliberately claim Admin even in member cases.
jest.mock("./protocol-provider", () => ({ useProtocol: () => ({
  protocolCell: mockProtocolCell, protocolData: chainProtocol, isAdmin: true, isEndorser: false,
  endorserResolver: { resolve: () => null },
}) }));
function protocol(data: ccc.Hex = "0x01", suffix = "22") {
  return ccc.Cell.from({ outPoint: { txHash: h("23"), index: 0 }, cellOutput: { capacity: ccc.fixedPointFrom(500), lock: adminLock, type: { codeHash: h("21"), hashType: "type", args: h(suffix) } }, outputData: data });
}
function tip(id: ccc.Hex, status: string): TippingInfo {
  return { typeId: id, data: { status, proposer_lock_hash: adminLock.hash(), target_lock_hash: memberLock.hash(), supporter_lock_hashes: [], metadata: { contribution_title: status, long_description: "" } }, metadata: { contribution_title: status }, comments: [], additionalTips: [] } as unknown as TippingInfo;
}
const approved = tip(approvedId, "approved"), pending = tip(pendingId, "created");
let context: ReturnType<typeof useTippingContext>;
function Probe() { context = useTippingContext(); return <output data-testid="tips">{context.tippings.map(t => t.typeId).join(",")}</output>; }
function mount(children: React.ReactNode = <Probe />) { return render(<TippingProvider>{children}</TippingProvider>); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  jest.clearAllMocks(); mockWalletLock = adminLock;
  mockClient = {} as ccc.Client; mockProtocolCell = protocol();
  mockSigner = { client: mockClient, getRecommendedAddressObj: jest.fn(async () => new ccc.Address(mockWalletLock, "ckt")), onReplaced: mockReplaced, signTransaction: mockWrite, sendTransaction: mockWrite } as unknown as ccc.Signer;
  mockReplaced.mockReturnValue(mockUnsubscribe);
  mockAll.mockResolvedValue([approved, pending]); mockApproved.mockResolvedValue([approved]); mockFunding.mockResolvedValue(null);
  mockPendingComment = undefined;
  jest.spyOn(ProtocolData, "decode").mockImplementation(data => (String(data) === "0x02" ? memberProtocol : chainProtocol) as unknown as ReturnType<typeof ProtocolData.decode>);
});

it("loads all current-protocol proposals for a chain-verified Admin despite a nonempty approved vector", async () => {
  mount(); await waitFor(() => expect(context.isLoading).toBe(false));
  expect(context.tippings.map(t => t.typeId)).toEqual([approvedId, pendingId]);
  expect(mockAll).toHaveBeenCalledWith(mockClient); expect(mockApproved).not.toHaveBeenCalled(); expect(mockWrite).not.toHaveBeenCalled();
});

it("preserves approved-list reads for a member, ignoring editable provider role/data", async () => {
  mockProtocolCell = protocol("0x02"); mount();
  await waitFor(() => expect(context.isLoading).toBe(false));
  expect(context.tippings).toEqual([approved]); expect(mockAll).not.toHaveBeenCalled();
  expect(mockApproved).toHaveBeenCalledWith(memberProtocol, mockClient);
});

it("keeps the original approved-list policy for disconnected visitors", async () => {
  mockSigner = undefined; mount(); await waitFor(() => expect(context.isLoading).toBe(false));
  expect(context.tippings).toEqual([approved]); expect(mockAll).not.toHaveBeenCalled(); expect(mockFunding).not.toHaveBeenCalled();
});

it("discards an old Admin list when the same Signer changes account during a pending read", async () => {
  const old = deferred<TippingInfo[]>(); mockAll.mockReturnValue(old.promise);
  mount(); await waitFor(() => expect(mockAll).toHaveBeenCalledTimes(1));
  mockWalletLock = memberLock;
  await act(async () => old.resolve([approved, pending]));
  await waitFor(() => expect(context.isLoading).toBe(false));
  expect(context.tippings).toEqual([approved]); expect(mockApproved).toHaveBeenCalled();
});

it("clears the visible Admin list on account replacement before a slow member refresh settles", async () => {
  mount(); await waitFor(() => expect(context.tippings).toHaveLength(2));
  const next = deferred<TippingInfo[]>(); mockApproved.mockReturnValue(next.promise); mockWalletLock = memberLock;
  act(() => mockReplaced.mock.calls[0][0]());
  expect(context.tippings).toEqual([]); expect(context.fundingSummary).toBeNull();
  await act(async () => next.resolve([approved])); await waitFor(() => expect(context.tippings).toEqual([approved]));
});

it.each(["signer", "client", "protocol"])("hides preceding scope immediately and ignores its late list after %s replacement", async changed => {
  const old = deferred<TippingInfo[]>(); mockAll.mockReturnValueOnce(old.promise);
  const view = mount(); await waitFor(() => expect(mockAll).toHaveBeenCalledTimes(1));
  mockWalletLock = memberLock;
  if (changed === "signer") mockSigner = { ...mockSigner } as ccc.Signer;
  if (changed === "client") mockClient = {} as ccc.Client;
  if (changed === "protocol") mockProtocolCell = protocol("0x02", "24");
  view.rerender(<TippingProvider><Probe /></TippingProvider>);
  expect(context.tippings).toEqual([]);
  await waitFor(() => expect(context.tippings).toEqual([approved]));
  await act(async () => old.resolve([approved, pending])); expect(context.tippings).toEqual([approved]);
});

it("does not publish an Admin list if the account changes while funding is resolving", async () => {
  const funding = deferred<null>(); mockFunding.mockReturnValueOnce(funding.promise);
  mount(); await waitFor(() => expect(mockFunding).toHaveBeenCalledTimes(1));
  mockWalletLock = memberLock; await act(async () => funding.resolve(null));
  await waitFor(() => expect(context.isLoading).toBe(false)); expect(context.tippings).toEqual([approved]);
});

it("clears the list on a wallet/read failure instead of returning cached privileged proposals", async () => {
  mockAll.mockRejectedValue(new Error("Indexer offline")); mount();
  await waitFor(() => expect(context.error).toBe("Indexer offline")); expect(context.tippings).toEqual([]); expect(context.isLoading).toBe(false);
});

it("makes the actual /tipping query scroll to the full pending ID returned for Admin", async () => {
  const scroll = jest.fn(); const previous = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = scroll;
  try {
    mount(<Tippings />);
    await waitFor(() => expect(document.querySelector(`[data-tip-id='${pendingId}']`)).not.toBeNull());
    await waitFor(() => expect(scroll).toHaveBeenCalledWith({ behavior: "smooth", block: "center" }));
    expect((scroll.mock.contexts[0] as Element).querySelector(`[data-tip-id='${pendingId}']`)).not.toBeNull();
    expect(mockWrite).not.toHaveBeenCalled();
  } finally { Element.prototype.scrollIntoView = previous; }
});

it("never commits old Admin cards or funding during the member transition before effects synchronize", async () => {
  const commits: string[][] = [];
  function CommitProbe() {
    useTippingContext();
    React.useLayoutEffect(() => { commits.push(Array.from(document.querySelectorAll("[data-tip-id]")).map(node => node.getAttribute("data-tip-id")!)); });
    return null;
  }
  mount(<><Tippings /><CommitProbe /></>);
  await waitFor(() => expect(document.querySelector(`[data-tip-id='${pendingId}']`)).not.toBeNull());
  const next = deferred<TippingInfo[]>(); mockApproved.mockReturnValue(next.promise); mockWalletLock = memberLock;
  commits.length = 0;
  act(() => mockReplaced.mock.calls[0][0]());
  expect(commits.length).toBeGreaterThan(0);
  expect(commits.every(ids => !ids.includes(pendingId))).toBe(true);
  expect(document.querySelector(`[data-tip-id='${pendingId}']`)).toBeNull();
  expect(context.fundingSummary).toBeNull();
  await act(async () => next.resolve([approved]));
  await waitFor(() => expect(document.querySelector(`[data-tip-id='${approvedId}']`)).not.toBeNull());
});

it("does not merge local patches or a late old callback into a different protocol's same full ID", async () => {
  const view = mount(<Tippings />);
  await waitFor(() => expect(screen.queryByTestId(`comment-${pendingId}`)).not.toBeNull());
  const oldComment = mockPendingComment!;
  fireEvent.click(screen.getByTestId(`comment-${pendingId}`));
  expect(document.querySelector(`[data-tip-id='${pendingId}']`)).toHaveAttribute("data-comment-count", "1");
  const nextTip = { ...pending, metadata: { ...pending.metadata, contribution_title: "Different protocol same ID" }, data: { ...pending.data, metadata: { ...pending.data.metadata, contribution_title: "Different protocol same ID" } } };
  mockAll.mockResolvedValue([nextTip]); mockProtocolCell = protocol("0x01", "24");
  view.rerender(<TippingProvider><Tippings /></TippingProvider>);
  expect(document.querySelector(`[data-tip-id='${pendingId}']`)).toBeNull();
  await waitFor(() => expect(screen.queryByText("Different protocol same ID")).not.toBeNull());
  act(() => oldComment());
  expect(document.querySelector(`[data-tip-id='${pendingId}']`)).toHaveAttribute("data-comment-count", "0");
});

it("does not let a late refresh callback from an old scope invalidate the current member list", async () => {
  const view = mount(); await waitFor(() => expect(context.tippings).toHaveLength(2));
  const oldRefresh = context.refreshTippings;
  mockWalletLock = memberLock; mockSigner = { ...mockSigner } as ccc.Signer;
  view.rerender(<TippingProvider><Probe /></TippingProvider>);
  await waitFor(() => expect(context.isLoading).toBe(false)); expect(context.tippings).toEqual([approved]);
  await act(async () => oldRefresh());
  expect(context.isLoading).toBe(false); expect(context.tippings).toEqual([approved]);
});
