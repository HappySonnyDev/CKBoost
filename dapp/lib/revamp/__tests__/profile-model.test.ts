import { ccc } from "@ckb-ccc/connector-react";
import { CampaignData, ConnectedTypeID, UserData } from "ssri-ckboost/types";
import { buildProfileCampaignData, profilePointsType, profileRoleLabel, profileTimestamp, readProfileCampaigns, readProfileIdentity, readProfilePages, readProfilePoints, readProfileRewards, withProfileDeadline, type ProfileIdentity, type ProfileReadScope } from "../profile-model";

jest.mock("@ckb-ccc/connector-react", () => ({ccc: jest.requireActual("@ckb-ccc/core")}));
const h = (value: string) => `0x${value.repeat(64)}` as ccc.Hex;
function fixture() {
  const lock = ccc.Script.from({codeHash: h("9"), hashType: "type", args: `0x${"11".repeat(22)}`});
  const client = {findCellsPaged: jest.fn().mockResolvedValue({cells: [], lastCursor: "done"}), getTransaction: jest.fn(), getHeaderByNumber: jest.fn()} as unknown as ccc.Client;
  const protocolCell = ccc.Cell.from({outPoint: {txHash: h("3"), index: 0}, cellOutput: {capacity: 100000000000n, lock, type: {codeHash: h("4"), hashType: "type", args: h("f")}}, outputData: "0x"});
  const scope = {client, protocolCell, protocolHash: protocolCell.cellOutput.type!.hash(), walletLock: lock, lockHash: lock.hash(), address: "ckt-test-wallet", network: "testnet", protocol: {
    protocol_config: {admin_lock_hash_vec: [], script_code_hashes: {ckb_boost_user_type_code_hash: h("6"), ckb_boost_campaign_type_code_hash: h("7"), ckb_boost_protocol_lock_code_hash: h("8"), ckb_boost_points_udt_type_code_hash: h("5")}}, campaigns_approved: [], endorsers_whitelist: [],
  }} as unknown as ProfileReadScope;
  const userData = {verification_data: {telegram_personal_chat_id: 0, identity_verification_data: []}, total_points_earned: 999n, last_activity_timestamp: 1700000000000n, submission_records: [], profile_data: [], last_bonus_streak_at: 0};
  const cell = (code: ccc.Hex, id: ccc.Hex, data: ccc.Hex, wallet = lock, protocol = scope.protocolHash, txHash = id) => ccc.Cell.from({outPoint: {txHash, index: 0}, cellOutput: {capacity: 100000000000n, lock: wallet, type: {codeHash: code, hashType: "type", args: ccc.hexFrom(ConnectedTypeID.encode({type_id: id, connected_key: protocol}))}}, outputData: data});
  const userCell = (id = h("a"), value = userData, protocol = scope.protocolHash) => cell(h("6"), id, ccc.hexFrom(UserData.encode(value)), lock, protocol);
  const identity = {address: scope.address, lockHash: scope.lockHash, userTypeId: h("a"), displayName: null, lastActiveAt: null, verifiedTelegram: false, userCell: userCell(), user: UserData.decode(UserData.encode(userData))} satisfies ProfileIdentity;
  const campaign = (id = h("b"), accepted = [h("a")], owner = scope.lockHash) => {
    const campaignLock = ccc.Script.from({codeHash: h("8"), hashType: "type", args: ccc.hexFrom(ConnectedTypeID.encode({type_id: owner, connected_key: scope.protocolHash}))});
    const data = {endorser_lock_hash: h("e"), staff_lock_hash_vec: [], created_at: 100, starting_time: 100, ending_time: 200,
      rules: [], status: 4, participants_count: 0, total_completions: 0, metadata: {title: "Real campaign", short_description: "Summary", long_description: "nevent", image_url: "", total_rewards: {points_amount: 1, ckb_amount: 0, nft_assets: [], udt_assets: []}, verification_requirements: [], last_updated: 100, categories: [], difficulty: 1},
      quests: [{quest_id: 1, metadata: {title: "Real quest", short_description: "", long_description: "nevent", requirements: "", difficulty: 1, time_estimate: 1}, rewards_on_completion: [], accepted_submission_user_type_ids: accepted, completion_deadline: 0, status: 1, sub_tasks: [], points: 5, completion_count: accepted.length}]};
    return cell(h("7"), id, ccc.hexFrom(CampaignData.encode(data)), campaignLock);
  };
  return {scope, client, lock, cell, userData, userCell, identity, campaign};
}

describe("current profile chain facts", () => {
  it("returns an unregistered empty identity without inventing a joined date or accrued Points", async () => {
    const {scope} = fixture();
    await expect(readProfileIdentity(scope)).resolves.toMatchObject({userCell: null, userTypeId: null, displayName: null, lastActiveAt: null});
    await expect(readProfilePoints(scope)).resolves.toBe(0n);
  });
  it("filters another protocol and wallet, and reads only the current canonical User identity", async () => {
    const f = fixture();
    const otherWallet = ccc.Script.from({codeHash: h("1"), hashType: "type", args: "0x"});
    jest.mocked(f.client.findCellsPaged).mockResolvedValue({cells: [f.userCell(h("c"), f.userData, h("e")), f.cell(h("6"), h("d"), ccc.hexFrom(UserData.encode(f.userData)), otherWallet), f.userCell()], lastCursor: "done"});
    const result = await readProfileIdentity(f.scope);
    expect(result.userTypeId).toBe(h("a"));
    expect(result.lastActiveAt).toBe(1700000000000);
    expect(result).not.toHaveProperty("joinedAt");
  });
  it("does not choose an arbitrary profile when two latest User cells have the same block", async () => {
    const f = fixture();
    jest.mocked(f.client.findCellsPaged).mockResolvedValue({cells: [f.userCell(h("a")), f.userCell(h("b"))], lastCursor: "done"});
    jest.mocked(f.client.getTransaction).mockResolvedValue({blockNumber: 5n} as Awaited<ReturnType<ccc.Client["getTransaction"]>>);
    await expect(readProfileIdentity(f.scope)).rejects.toThrow(/ambiguous/);
  });
  it("sums spendable full-type wallet balances, excluding foreign protocol assets", async () => {
    const f = fixture(), type = profilePointsType(f.scope);
    const points = (amount: number, script = type, id = h("c")) => ccc.Cell.from({outPoint: {txHash: id, index: 0}, cellOutput: {capacity: 14400000000n, lock: f.lock, type: script}, outputData: ccc.hexFrom(ccc.numToBytes(amount, 16))});
    jest.mocked(f.client.findCellsPaged).mockResolvedValue({cells: [points(3), points(99, ccc.Script.from({...type, args: h("e")}), h("d"))], lastCursor: "done"});
    await expect(readProfilePoints(f.scope)).resolves.toBe(3n);
    const broken = points(1); broken.outputData = "0x01";
    jest.mocked(f.client.findCellsPaged).mockResolvedValue({cells: [broken], lastCursor: "done"});
    await expect(readProfilePoints(f.scope)).rejects.toThrow(/invalid balance/);
    jest.mocked(f.client.findCellsPaged).mockRejectedValue(new Error("Indexer offline"));
    await expect(readProfilePoints(f.scope)).rejects.toThrow("Indexer offline");
  });
  it("rejects incomplete or repeated pagination rather than publishing a partial total", async () => {
    const f = fixture();
    const cells = Array.from({length: 100}, (_, index) => f.userCell(`0x${index.toString(16).padStart(64, "0")}`));
    jest.mocked(f.client.findCellsPaged).mockResolvedValue({cells, lastCursor: ""});
    await expect(readProfilePages(f.scope, {script: f.lock, scriptType: "lock", scriptSearchMode: "exact"}, "test")).rejects.toThrow(/did not finish/);
    jest.mocked(f.client.findCellsPaged).mockResolvedValue({cells: [cells[0], cells[0]], lastCursor: "done"});
    await expect(readProfilePages(f.scope, {script: f.lock, scriptType: "lock", scriptSearchMode: "exact"}, "test-repeat")).rejects.toThrow(/repeated/);
  });
  it("derives current approval from accepted IDs, keeps submitted dates and does not use User.total_points_earned as wallet balance", () => {
    const f = fixture();
    f.identity.user!.submission_records = [{campaign_type_id: h("b"), quest_id: 1, submission_timestamp: 1700000000n, submission_content: "nevent-real"}];
    const data = buildProfileCampaignData(f.scope, f.identity, [f.campaign()]);
    expect(data.participated).toEqual([{id: h("b"), title: "Real campaign", questsSubmitted: 1, pointsEarned: 5n}]);
    expect(data.created).toHaveLength(1); // actual owner lock, despite different endorsement metadata
    expect(data.activities).toEqual([{id: `${h("b")}:1`, campaignId: h("b"), campaignTitle: "Real campaign", questId: 1, questTitle: "Real quest", submittedAt: 1700000000000, status: "approved"}]);
    expect(data.approvedPoints).toBe(5n);
    expect(buildProfileCampaignData(f.scope, f.identity, [f.campaign(h("b"), [])]).activities[0].status).toBe("pending");
  });
  it("counts acceptance with pruned submissions but does not invent its submission timestamp", () => {
    const f = fixture(), data = buildProfileCampaignData(f.scope, f.identity, [f.campaign()]);
    expect(data.participated[0]).toMatchObject({questsSubmitted: 0, pointsEarned: 5n});
    expect(data.activities).toEqual([]);
    f.identity.user!.submission_records = [{campaign_type_id: h("b"), quest_id: 9, submission_timestamp: 1n, submission_content: "nevent"}];
    expect(() => buildProfileCampaignData(f.scope, f.identity, [f.campaign()])).toThrow(/approval.*cannot be determined/);
  });
  it("grants labels from current Admin/Organizer facts or a positive campaign assignment only", () => {
    const {scope} = fixture();
    expect(profileRoleLabel(scope)).toBe("Member");
    expect(profileRoleLabel(scope, true)).toBe("Reviewer");
    scope.protocol.endorsers_whitelist = [{endorser_lock_hash: scope.lockHash} as ProfileReadScope["protocol"]["endorsers_whitelist"][number]];
    expect(profileRoleLabel(scope, true)).toBe("Organizer");
    scope.protocol.protocol_config.admin_lock_hash_vec = [scope.lockHash];
    expect(profileRoleLabel(scope)).toBe("Admin");
  });
  it("uses bounded parallel campaign reads and rejects missing referenced campaigns", async () => {
    const f = fixture();
    f.scope.protocol.campaigns_approved = Array.from({length: 7}, (_, index) => `0x${(index + 10).toString(16).padStart(64, "0")}` as ccc.Hex);
    let active = 0, maximum = 0;
    jest.mocked(f.client.findCellsPaged).mockImplementation(async search => {
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--;
      if (search.scriptType === "type" && search.script.args !== "0x") {
        const id = ConnectedTypeID.decode(search.script.args!).type_id;
        return {cells: [f.campaign(ccc.hexFrom(id), [])], lastCursor: "done"};
      }
      return {cells: [], lastCursor: "done"};
    });
    await expect(readProfileCampaigns(f.scope, f.identity)).resolves.toHaveProperty("activities");
    expect(maximum).toBeLessThanOrEqual(4);
    jest.mocked(f.client.findCellsPaged).mockResolvedValue({cells: [], lastCursor: "done"});
    await expect(readProfileCampaigns(f.scope, f.identity)).rejects.toThrow(/totals are unavailable/);
  });
  it("binds lazy positive wallet history to returned wallet/protocol/type without guessing campaign or earned date", async () => {
    const f = fixture();
    const payload = {address: f.scope.address, protocolTypeHash: f.scope.protocolHash, pointsTypeScript: profilePointsType(f.scope), transactions: [{txHash: h("e"), netPoints: "1"}]};
    const fetcher = jest.fn().mockResolvedValue({ok: true, json: async () => payload}) as unknown as typeof fetch;
    const rows = await readProfileRewards(f.scope, undefined, fetcher);
    expect(rows[0]).toMatchObject({campaignId: null, campaignTitle: "Points received", amount: 1n, occurredAt: null});
    payload.protocolTypeHash = h("f");
    await expect(readProfileRewards(f.scope, undefined, fetcher)).rejects.toThrow(/does not match/);
    payload.protocolTypeHash = f.scope.protocolHash; payload.transactions[0].netPoints = "-1";
    await expect(readProfileRewards(f.scope, undefined, fetcher)).rejects.toThrow(/invalid Points/);
  });
  it("uses real header milliseconds once per block height and retains unknown dates on missing, wrong or failed headers", async () => {
    const f = fixture();
    const payload = {address: f.scope.address, protocolTypeHash: f.scope.protocolHash, pointsTypeScript: profilePointsType(f.scope), transactions: [
      {txHash: h("a"), netPoints: "1", blockNumber: "0xa"}, {txHash: h("b"), netPoints: "2", blockNumber: "10"},
      {txHash: h("c"), netPoints: "3", blockNumber: "11"}, {txHash: h("d"), netPoints: "4", blockNumber: "12"}, {txHash: h("e"), netPoints: "5", blockNumber: "13"},
    ]};
    jest.mocked(f.client.getHeaderByNumber).mockImplementation(async height => {
      if (height === 10n) return {number: 10n, timestamp: 1700000000123n} as Awaited<ReturnType<ccc.Client["getHeaderByNumber"]>>;
      if (height === 11n) return undefined;
      if (height === 12n) throw new Error("Header RPC offline");
      return {number: 99n, timestamp: 1700000000999n} as Awaited<ReturnType<ccc.Client["getHeaderByNumber"]>>;
    });
    const fetcher = jest.fn().mockResolvedValue({ok: true, json: async () => payload}) as unknown as typeof fetch;
    const rows = await readProfileRewards(f.scope, undefined, fetcher);
    expect(rows.map(row => row.occurredAt)).toEqual([1700000000123, 1700000000123, null, null, null]);
    expect(f.client.getHeaderByNumber).toHaveBeenCalledTimes(4);
    expect(rows.every(row => row.campaignId === null)).toBe(true);
  });
  it("coalesces concurrent Rewards readers by height and bounds header transport concurrency", async () => {
    const f = fixture();
    const payload = {address: f.scope.address, protocolTypeHash: f.scope.protocolHash, pointsTypeScript: profilePointsType(f.scope), transactions: Array.from({length: 8}, (_, index) => ({
      txHash: `0x${(index + 1).toString(16).padStart(64, "0")}`, netPoints: "1", blockNumber: String(index + 1),
    }))};
    let active = 0, maximum = 0;
    jest.mocked(f.client.getHeaderByNumber).mockImplementation(async height => {
      active++; maximum = Math.max(active, maximum);
      await new Promise(resolve => setTimeout(resolve, 2)); active--;
      return {number: ccc.numFrom(height), timestamp: 1700000000123n} as Awaited<ReturnType<ccc.Client["getHeaderByNumber"]>>;
    });
    const fetcher = jest.fn().mockResolvedValue({ok: true, json: async () => payload}) as unknown as typeof fetch;
    const rows = await Promise.all([readProfileRewards(f.scope, undefined, fetcher), readProfileRewards(f.scope, undefined, fetcher)]);
    expect(maximum).toBeLessThanOrEqual(4);
    expect(f.client.getHeaderByNumber).toHaveBeenCalledTimes(8);
    expect(rows[0].every(row => row.occurredAt === 1700000000123)).toBe(true);
  });
  it("normalizes actual seconds/milliseconds without guessing missing dates and enforces an overall timeout", async () => {
    expect(profileTimestamp(1700000000n)).toBe(1700000000000);
    expect(profileTimestamp(1700000000000n)).toBe(1700000000000);
    expect(profileTimestamp(0)).toBeNull(); expect(profileTimestamp("invalid")).toBeNull();
    await expect(withProfileDeadline(() => new Promise(() => {}), undefined, 5)).rejects.toThrow(/timed out/);
    const controller = new AbortController(); controller.abort();
    await expect(withProfileDeadline(async () => {throw new Error("late");}, controller.signal)).rejects.toHaveProperty("name", "AbortError");
  });
});
