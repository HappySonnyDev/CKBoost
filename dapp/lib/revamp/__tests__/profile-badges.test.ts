import { ccc } from "@ckb-ccc/connector-react";
import { AchievementDataVec, ConnectedTypeID, ProtocolData } from "ssri-ckboost/types";
import { BADGE_ELIGIBILITY_UNAVAILABLE, readProfileBadges } from "../profile-badges";

jest.mock("@ckb-ccc/connector-react", () => ({ ccc: jest.requireActual("@ckb-ccc/core") }));
jest.mock("ssri-ckboost", () => ({ createScopedLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }), { virtual: true });
const mockAchievementCell = jest.fn();
const mockClaim = jest.fn();
jest.mock("@/lib/services/achievement-service", () => ({ AchievementService: jest.fn().mockImplementation(() => ({
  getAchievementCell: (...args: unknown[]) => mockAchievementCell(...args), claimAchievements: mockClaim, previewClaim: mockClaim,
})) }));

const hash = (byte: string) => `0x${byte.repeat(32)}` as ccc.Hex;
const lock = ccc.Script.from({ codeHash: hash("11"), hashType: "type", args: hash("12") });
const address = new ccc.Address(lock, "ckt").toString();
const protocolType = ccc.Script.from({ codeHash: hash("21"), hashType: "type", args: hash("22") });
const protocolHash = protocolType.hash(), userCode = hash("31"), achievementCode = hash("41");
const connected = (id: ccc.Hex, protocol = protocolHash) => ccc.hexFrom(ConnectedTypeID.encode({ type_id: id, connected_key: protocol }));
function cell(code: ccc.Hex, id: ccc.Hex, protocol = protocolHash, outputData: ccc.Hex = "0x", wallet = lock) {
  return ccc.Cell.from({ outPoint: { txHash: id, index: 0 }, cellOutput: { capacity: ccc.fixedPointFrom(600), lock: wallet, type: { codeHash: code, hashType: "type", args: connected(id, protocol) } }, outputData });
}
function fixture(options: { claimed?: boolean; grantedAt?: bigint; empty?: boolean; foreignRecord?: boolean } = {}) {
  const user = cell(userCode, hash("32"));
  const foreignUser = cell(userCode, hash("33"), hash("24"));
  const definitions = cell(achievementCode, hash("42"), protocolHash, ccc.hexFrom(AchievementDataVec.encode(options.empty ? [] : [{
    achievement_title: "First Submission", achievement_metadata: "nevent1actual-chain-reference",
    receiver_user_record_vec: options.claimed ? [{ receiver_user_type_hash: (options.foreignRecord ? foreignUser : user).cellOutput.type!.hash(), granted_at: options.grantedAt ?? 1_795_162_000_000n }] : [],
  }])));
  const protocolCell = ccc.Cell.from({ outPoint: { txHash: hash("23"), index: 0 }, cellOutput: { capacity: ccc.fixedPointFrom(1000), lock, type: protocolType }, outputData: "0x01" });
  const client = {
    addressPrefix: "ckt",
    findCellsPaged: jest.fn(async () => ({ cells: [foreignUser, user], lastCursor: "done" })),
    getTransaction: jest.fn(async () => ({ blockNumber: 1n })),
  } as unknown as ccc.Client;
  mockAchievementCell.mockResolvedValue(definitions);
  return { user, foreignUser, definitions, protocolCell, client, options: { client, protocolCell, identity: { address, lockHash: lock.hash() } } };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(ProtocolData, "decode").mockReturnValue({ protocol_config: { script_code_hashes: {
    ckb_boost_user_type_code_hash: userCode, ckb_boost_achievement_type_code_hash: achievementCode,
  } } } as unknown as ReturnType<typeof ProtocolData.decode>);
});

it("uses actual current-protocol receiver records and normalizes a real 13-digit timestamp", async () => {
  const { options, client } = fixture({ claimed: true });
  const result = await readProfileBadges(options);
  expect(result.badges).toEqual([expect.objectContaining({ title: "First Submission", claimed: true, claimedAt: 1_795_162_000_000, claimable: false, image: { kind: "none" }, description: null, classification: "first-submission" })]);
  expect(result.eligibilityUnavailableReason).toBeNull();
  expect(mockAchievementCell).toHaveBeenCalledWith(protocolHash);
  // The newer foreign protocol is excluded before a latest-user/history lookup.
  expect(client.getTransaction).not.toHaveBeenCalled();
  expect(client.findCellsPaged).toHaveBeenCalledWith(expect.objectContaining({ filter: { script: { codeHash: userCode, hashType: "type", args: "0x" } } }), "asc", 100, undefined);
  expect(mockClaim).not.toHaveBeenCalled();
});

it("preserves legacy seconds, while an invalid date does not erase a proven receiver record", async () => {
  const valid = fixture({ claimed: true, grantedAt: 1_795_162_000n });
  expect((await readProfileBadges(valid.options)).badges[0].claimedAt).toBe(1_795_162_000_000);
  const invalid = fixture({ claimed: true, grantedAt: 2n ** 64n - 1n });
  expect((await readProfileBadges(invalid.options)).badges[0]).toMatchObject({ claimed: true, claimedAt: null, claimable: false });
});

it("does not convert a foreign protocol's receiver record into claimed or fabricate eligibility", async () => {
  const { options } = fixture({ claimed: true, foreignRecord: true });
  const result = await readProfileBadges(options);
  expect(result.badges[0]).toMatchObject({ claimed: false, claimedAt: null, claimable: null });
  expect(result.eligibilityUnavailableReason).toBe(BADGE_ELIGIBILITY_UNAVAILABLE);
  expect(mockClaim).not.toHaveBeenCalled();
});

it("keeps an actually empty definition vector empty without querying users or manufacturing badges", async () => {
  const { options, client } = fixture({ empty: true });
  expect(await readProfileBadges(options)).toEqual({ badges: [], eligibilityUnavailableReason: null });
  expect(client.findCellsPaged).not.toHaveBeenCalled();
});

it("rejects wrong-protocol, noncanonical or wrong-code definitions returned by an indexer", async () => {
  const { options, definitions } = fixture();
  const wrongProtocol = definitions.clone(); wrongProtocol.cellOutput.type!.args = connected(hash("42"), hash("ff"));
  const wrongCode = definitions.clone(); wrongCode.cellOutput.type!.codeHash = hash("ee");
  const wrongHashType = definitions.clone(); wrongHashType.cellOutput.type!.hashType = "data1";
  const malformed = definitions.clone(); malformed.cellOutput.type!.args = `${definitions.cellOutput.type!.args}00` as ccc.Hex;
  for (const result of [wrongProtocol, wrongCode, wrongHashType, malformed]) {
    mockAchievementCell.mockResolvedValueOnce(result);
    await expect(readProfileBadges(options)).rejects.toThrow("do not belong");
  }
});

it("excludes another wallet and a malformed matching user, even when the receiver references it", async () => {
  const { options, user, client } = fixture({ claimed: true });
  user.cellOutput.lock = ccc.Script.from({ codeHash: hash("71"), hashType: "type", args: "0x" });
  const badType = user.clone(); badType.outPoint.txHash = hash("35"); badType.cellOutput.lock = lock; badType.cellOutput.type!.hashType = "data1";
  jest.mocked(client.findCellsPaged).mockResolvedValue({ cells: [user, badType], lastCursor: "done" });
  expect((await readProfileBadges(options)).badges[0]).toMatchObject({ claimed: false, claimable: null });
});

it("fails as unknown rather than choosing an arbitrary receiver when duplicate current users cannot be ordered", async () => {
  const { options, user, client } = fixture({ claimed: true });
  const duplicate = cell(userCode, hash("34"));
  jest.mocked(client.findCellsPaged).mockResolvedValue({ cells: [user, duplicate], lastCursor: "done" });
  jest.mocked(client.getTransaction).mockRejectedValue(new Error("RPC offline"));
  await expect(readProfileBadges(options)).rejects.toThrow("RPC offline");
});

it("fails as ambiguous for two current User profiles in the latest block", async () => {
  const { options, user, client } = fixture({ claimed: true });
  jest.mocked(client.findCellsPaged).mockResolvedValue({ cells: [user, cell(userCode, hash("34"))], lastCursor: "done" });
  await expect(readProfileBadges(options)).rejects.toThrow("ambiguous");
});

it("does not publish receiver status after repeated or nonterminal pagination", async () => {
  const { options, user, client } = fixture({ claimed: true });
  jest.mocked(client.findCellsPaged).mockResolvedValue({ cells: [user, user], lastCursor: "done" });
  await expect(readProfileBadges(options)).rejects.toThrow("repeated a cell");
  const fullPage = Array.from({ length: 100 }, (_, index) => cell(userCode, `0x${index.toString(16).padStart(64, "0")}`));
  jest.mocked(client.findCellsPaged).mockResolvedValue({ cells: fullPage, lastCursor: "" });
  await expect(readProfileBadges(options)).rejects.toThrow("did not finish");
});

it("does not read definitions for a mismatched wallet identity and stops after scope changes", async () => {
  const { options } = fixture();
  await expect(readProfileBadges({ ...options, identity: { address, lockHash: hash("99") } })).rejects.toThrow("identity could not");
  expect(mockAchievementCell).not.toHaveBeenCalled();
  await expect(readProfileBadges({ ...options, isCurrent: () => false })).rejects.toThrow("changed");
  expect(mockAchievementCell).not.toHaveBeenCalled();
});
