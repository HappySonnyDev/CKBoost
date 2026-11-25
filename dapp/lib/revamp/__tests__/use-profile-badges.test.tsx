import { act, renderHook, waitFor } from "@testing-library/react";
import { ccc } from "@ckb-ccc/connector-react";
import { readProfileBadges, type ProfileBadgeResult } from "../profile-badges";
import { useProfileBadges, type ProfileBadgesOptions } from "../use-profile-badges";

jest.mock("@ckb-ccc/connector-react", () => ({ ccc: { useSigner: jest.fn(), useCcc: jest.fn() } }));
jest.mock("../profile-badges", () => ({
  profileBadgeScope: (cell: { outputData: string }) => ({ key: cell.outputData }),
  readProfileBadges: jest.fn(),
}));
const lockA = `0x${"11".repeat(32)}`, lockB = `0x${"22".repeat(32)}`;
function signer(hash = lockA) { return { getRecommendedAddressObj: jest.fn(async () => ({ script: { hash: () => hash } })) } as unknown as ccc.Signer; }
function scope(protocol = "p1", lockHash = lockA): ProfileBadgesOptions { return { protocolCell: { outputData: protocol } as unknown as ccc.Cell, identity: { address: `ckt1${lockHash.slice(-8)}`, lockHash } }; }
function response(title = "Actual badge"): ProfileBadgeResult { return { badges: [{ id: title, title, claimed: true, claimedAt: 1_795_162_000_000, claimable: false, description: null, image: { kind: "none" }, classification: "other", metadataNeventId: "" }], eligibilityUnavailableReason: null }; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const rpc = {} as ccc.Client;
function connected(wallet: ccc.Signer | undefined, client = rpc) {
  jest.mocked(ccc.useSigner).mockReturnValue(wallet as ReturnType<typeof ccc.useSigner>);
  jest.mocked(ccc.useCcc).mockReturnValue({ client } as ReturnType<typeof ccc.useCcc>);
}
beforeEach(() => { jest.clearAllMocks(); jest.mocked(readProfileBadges).mockResolvedValue(response()); });

it("loads independently without a legacy provider and makes no read while disconnected", async () => {
  connected(undefined);
  const { result, rerender } = renderHook(useProfileBadges, { initialProps: scope() });
  expect(result.current.badges).toEqual([]); expect(result.current.isLoading).toBe(false); expect(readProfileBadges).not.toHaveBeenCalled();
  connected(signer()); rerender(scope());
  await waitFor(() => expect(result.current.badges[0]?.title).toBe("Actual badge"));
});

it("clears old-wallet results immediately and ignores a late previous wallet result", async () => {
  const old = deferred<ProfileBadgeResult>();
  jest.mocked(readProfileBadges).mockImplementationOnce(() => old.promise).mockResolvedValue(response("Wallet B badge"));
  connected(signer());
  const { result, rerender } = renderHook(useProfileBadges, { initialProps: scope() });
  await waitFor(() => expect(readProfileBadges).toHaveBeenCalledTimes(1));
  connected(signer(lockB)); rerender(scope("p1", lockB));
  expect(result.current.badges).toEqual([]);
  await waitFor(() => expect(result.current.badges[0]?.title).toBe("Wallet B badge"));
  await act(async () => old.resolve(response("Wallet A private badge")));
  expect(result.current.badges[0]?.title).toBe("Wallet B badge");
  connected(undefined); rerender(scope("p1", lockB));
  expect(result.current.badges).toEqual([]); expect(result.current.isLoading).toBe(false);
});

it("rejects an account changed in the same signer object while the read was pending", async () => {
  const pending = deferred<ProfileBadgeResult>(), wallet = signer();
  connected(wallet); jest.mocked(readProfileBadges).mockReturnValue(pending.promise);
  const { result } = renderHook(useProfileBadges, { initialProps: scope() });
  await waitFor(() => expect(readProfileBadges).toHaveBeenCalledTimes(1));
  jest.mocked(wallet.getRecommendedAddressObj).mockResolvedValue({ script: { hash: () => lockB } } as unknown as ccc.Address);
  await act(async () => pending.resolve(response("Stale badge")));
  await waitFor(() => expect(result.current.error).toContain("wallet account changed"));
  expect(result.current.badges).toEqual([]);
});

it("never displays a preceding protocol or RPC client's result in the new scope", async () => {
  const wallet = signer(); connected(wallet);
  const { result, rerender } = renderHook(useProfileBadges, { initialProps: scope() });
  await waitFor(() => expect(result.current.badges).toHaveLength(1));
  const pending = deferred<ProfileBadgeResult>(); jest.mocked(readProfileBadges).mockReturnValue(pending.promise);
  rerender(scope("p2")); expect(result.current.badges).toEqual([]);
  await waitFor(() => expect(readProfileBadges).toHaveBeenCalledTimes(2));
  connected(wallet, {} as ccc.Client); rerender(scope("p2")); expect(result.current.badges).toEqual([]);
  await act(async () => pending.resolve(response("New scope")));
  await waitFor(() => expect(result.current.badges[0]?.title).toBe("New scope"));
});

it("reports an RPC failure without claimed/claimable fabrication and supports a deliberate retry", async () => {
  connected(signer()); jest.mocked(readProfileBadges).mockRejectedValueOnce(new Error("RPC unavailable"));
  const { result } = renderHook(useProfileBadges, { initialProps: scope() });
  await waitFor(() => expect(result.current.error).toBe("RPC unavailable"));
  expect(result.current.badges).toEqual([]);
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.badges).toHaveLength(1));
  expect(result.current.error).toBeNull();
});
