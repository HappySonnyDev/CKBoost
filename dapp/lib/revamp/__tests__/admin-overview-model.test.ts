import { ccc } from "@ckb-ccc/connector-react";
import { CampaignData, ConnectedTypeID, TippingData, UserData } from "ssri-ckboost/types";
import { adminNeedActions, adminRecordedActivity, isOverviewAdmin, readAdminCurrentSnapshot, readAdminFunding, readAdminOverviewMetrics, readAdminUserBirth, type AdminCurrentSnapshot } from "../admin-overview-model";
import type { ProfileReadScope } from "../profile-model";
jest.mock("@ckb-ccc/connector-react", () => ({ccc: jest.requireActual("@ckb-ccc/core")}));
jest.mock("@/lib/services/udt-registry", () => ({udtRegistry: {getTokenByScriptHash: () => undefined}}));
const h = (letter: string) => `0x${letter.repeat(64)}` as ccc.Hex;
const userData = {verification_data: {telegram_personal_chat_id: 0, identity_verification_data: []}, total_points_earned: 0, last_activity_timestamp: 0, submission_records: [], profile_data: [], last_bonus_streak_at: 0};
const DAY = 86400000, NOW = 1800000000000;
function fixture() {
  const lock = ccc.Script.from({codeHash: h("9"), hashType: "type", args: "0x01"});
  const client = {findCellsPaged: jest.fn().mockResolvedValue({cells: [], lastCursor: "done"}), findTransactionsPaged: jest.fn(), getTransaction: jest.fn(), getHeaderByNumber: jest.fn()} as unknown as ccc.Client;
  const protocolCell = ccc.Cell.from({outPoint: {txHash: h("3"), index: 0}, cellOutput: {capacity: 100000000000n, lock, type: {codeHash: h("4"), hashType: "type", args: h("f")}}, outputData: "0x"});
  const scope = {client, protocolCell, protocolHash: protocolCell.cellOutput.type!.hash(), walletLock: lock, lockHash: lock.hash(), address: "ckt-admin", network: "testnet", protocol: {
    protocol_config: {admin_lock_hash_vec: [lock.hash()], script_code_hashes: {ckb_boost_campaign_type_code_hash: h("7"), ckb_boost_tipping_type_code_hash: h("a"), ckb_boost_user_type_code_hash: h("6"), ckb_boost_funding_lock_code_hash: h("8"), ckb_boost_points_udt_type_code_hash: h("5"), accepted_udt_type_scripts: []}}, campaigns_approved: [], tippings_approved: [], endorsers_whitelist: [],
  }} as unknown as ProfileReadScope;
  const typedCell = (code: ccc.Hex, id: ccc.Hex, outputData: ccc.Hex, protocol = scope.protocolHash) => ccc.Cell.from({outPoint: {txHash: id, index: 0}, cellOutput: {capacity: 100000000000n, lock, type: {codeHash: code, hashType: "type", args: ccc.hexFrom(ConnectedTypeID.encode({type_id: id, connected_key: protocol}))}}, outputData});
  const campaign = (id = h("b"), at = NOW - DAY) => {
    const data = {endorser_lock_hash: h("e"), staff_lock_hash_vec: [], created_at: at, starting_time: at, ending_time: NOW + DAY, rules: [], status: 4, participants_count: 0, total_completions: 0,
      metadata: {title: "Real campaign", short_description: "", long_description: "nevent", image_url: "", total_rewards: {points_amount: 1, ckb_amount: 0, nft_assets: [], udt_assets: []}, verification_requirements: [], last_updated: at + 10, categories: [], difficulty: 1}, quests: []};
    const cell = typedCell(h("7"), id, ccc.hexFrom(CampaignData.encode(data)));
    return {id, cell, data: CampaignData.decode(cell.outputData)};
  };
  const tipping = (id = h("c"), status = "created", grantedAt = 0) => {
    const data = {target_lock_hash: h("1"), proposer_lock_hash: h("2"), supporter_lock_hashes: [], metadata: {contribution_title: "Real tip", contribution_type_tags: [], short_description: "", long_description: "nevent", creation_timestamp: NOW - 2 * DAY}, rewards: {points_amount: 0, ckb_amount: 0, nft_assets: [], udt_assets: []}, status, granted_at: grantedAt};
    const cell = typedCell(h("a"), id, ccc.hexFrom(TippingData.encode(data)));
    return {id, cell, data: TippingData.decode(cell.outputData)};
  };
  const snapshot = {protocolTypeHash: scope.protocolHash, campaigns: [campaign()], tippings: [tipping()]} satisfies AdminCurrentSnapshot;
  return {scope, client, lock, typedCell, campaign, tipping, snapshot};
}
function birthFixture() {
  const f = fixture();
  const parent = ccc.Transaction.from({inputs: [{previousOutput: {txHash: h("1"), index: 0}}], outputs: [{capacity: 100000000000n, lock: f.lock}], outputsData: ["0x"]});
  const input = ccc.CellInput.from({previousOutput: {txHash: parent.hash(), index: 0}}), id = ccc.hashTypeId(input, 0);
  const type = ccc.Script.from({codeHash: h("6"), hashType: "type", args: ccc.hexFrom(ConnectedTypeID.encode({type_id: id, connected_key: f.scope.protocolHash}))});
  const creation = ccc.Transaction.from({inputs: [input], outputs: [{capacity: 100000000000n, lock: f.lock, type}], outputsData: [ccc.hexFrom(UserData.encode(userData))]});
  const userCell = ccc.Cell.from({outPoint: {txHash: creation.hash(), index: 0}, cellOutput: creation.outputs[0], outputData: creation.outputsData[0]});
  jest.mocked(f.client.findTransactionsPaged).mockResolvedValue({transactions: [{txHash: creation.hash(), blockNumber: 10n, txIndex: 0n, cells: [{isInput: false, cellIndex: 0n}]}], lastCursor: "done"});
  jest.mocked(f.client.getTransaction).mockImplementation(async txHash => ({transaction: txHash === creation.hash() ? creation : parent, status: "committed", blockNumber: txHash === creation.hash() ? 10n : 9n}) as Awaited<ReturnType<ccc.Client["getTransaction"]>>);
  jest.mocked(f.client.getHeaderByNumber).mockResolvedValue({number: 10n, timestamp: BigInt(NOW - DAY)} as Awaited<ReturnType<ccc.Client["getHeaderByNumber"]>>);
  return {...f, parent, creation, userCell};
}

describe("Admin overview current records and funding", () => {
  it("rejects a non-Admin before starting a statistics query", async () => {
    const f = fixture(); f.scope.protocol.protocol_config.admin_lock_hash_vec = [];
    expect(isOverviewAdmin(f.scope)).toBe(false);
    await expect(readAdminCurrentSnapshot(f.scope)).rejects.toThrow(/Only a current platform Admin/);
    await expect(readAdminFunding(f.scope, f.snapshot)).rejects.toThrow(/Only a current platform Admin/);
    expect(f.client.findCellsPaged).not.toHaveBeenCalled();
  });
  it("filters canonical full protocol identities even when another protocol uses the same code", async () => {
    const f = fixture(), foreign = f.typedCell(h("7"), h("e"), f.snapshot.campaigns[0].cell.outputData, h("f"));
    jest.mocked(f.client.findCellsPaged).mockImplementation(async search => ({cells: search.script.codeHash === h("7") ? [foreign, f.snapshot.campaigns[0].cell] : [f.snapshot.tippings[0].cell], lastCursor: "done"}));
    const snapshot = await readAdminCurrentSnapshot(f.scope);
    expect(snapshot.campaigns.map(row => row.id)).toEqual([h("b")]);
    expect(snapshot.tippings.map(row => row.id)).toEqual([h("c")]);
    const duplicate = ccc.Cell.from({...f.snapshot.campaigns[0].cell, outPoint: {txHash: h("d"), index: 0}});
    jest.mocked(f.client.findCellsPaged).mockResolvedValue({cells: [f.snapshot.campaigns[0].cell, duplicate], lastCursor: "done"});
    await expect(readAdminCurrentSnapshot(f.scope)).rejects.toThrow(/Multiple current cells/);
  });
  it("derives Need Action from current approval lists and never fabricates an approval event timestamp", () => {
    const f = fixture();
    expect(adminNeedActions(f.scope, f.snapshot)).toHaveLength(2);
    expect(adminNeedActions(f.scope, f.snapshot).find(row => row.type === "campaign")?.href).toBe(`/revamp/admin/campaigns/${h("b")}`);
    expect(adminNeedActions(f.scope, f.snapshot).find(row => row.type === "tipping")?.href).toBe(`/revamp/admin/tipping/${h("c")}`);
    f.scope.protocol.campaigns_approved = [h("b")]; f.scope.protocol.tippings_approved = [h("c")];
    const approvedButNotGranted = adminNeedActions(f.scope, f.snapshot);
    expect(approvedButNotGranted).toHaveLength(1);
    expect(approvedButNotGranted[0]).toMatchObject({type: "tipping", actionLabel: "Review"});
    f.snapshot.tippings[0].data.supporter_lock_hashes = [f.scope.lockHash];
    expect(adminNeedActions(f.scope, f.snapshot)[0]).toMatchObject({actionLabel: "Review", description: expect.stringContaining("already supported")});
    expect(adminNeedActions(f.scope, {...f.snapshot, tippings: [f.tipping(h("c"), "granted", NOW)]})).toEqual([]);
    const activity = adminRecordedActivity(f.scope, {...f.snapshot, tippings: [f.tipping(h("d"), "granted", 0)]});
    expect(activity.find(row => row.kind === "tipping")).toMatchObject({at: null, description: "Tip record · recorded grant"});
    expect(activity.find(row => row.kind === "campaign")).toMatchObject({at: NOW - DAY + 10, description: "Campaign record · recorded last update"});
    expect(() => adminNeedActions(f.scope, {...f.snapshot, protocolTypeHash: h("f")})).toThrow(/another protocol/);
    const foreignCampaign = f.typedCell(h("7"), h("b"), f.snapshot.campaigns[0].cell.outputData, h("f"));
    expect(() => adminNeedActions(f.scope, {...f.snapshot, campaigns: [{...f.snapshot.campaigns[0], cell: foreignCampaign}]})).toThrow(/complete protocol identity/);
  });
  it("separates campaign full-type funding from the shared protocol tip pool and excludes typed-cell capacity", async () => {
    const f = fixture(), code = h("8"), campaignArgs = f.snapshot.campaigns[0].cell.cellOutput.type!.hash();
    const points = ccc.Script.from({codeHash: h("5"), hashType: "type", args: f.scope.protocolHash});
    const funded = (id: ccc.Hex, args: ccc.Hex, capacity: bigint, type?: ccc.Script) => ccc.Cell.from({outPoint: {txHash: id, index: 0}, cellOutput: {capacity, lock: {codeHash: code, hashType: "type", args}, type}, outputData: type ? ccc.hexFrom(ccc.numToBytes(7, 16)) : "0x"});
    jest.mocked(f.client.findCellsPaged).mockResolvedValue({cells: [funded(h("1"), campaignArgs, 10000000000n), funded(h("2"), f.scope.protocolHash, 20000000000n), funded(h("3"), campaignArgs, 99999900000000n, points), funded(h("4"), h("f"), 9999999900000000n)], lastCursor: "done"});
    const funding = await readAdminFunding(f.scope, f.snapshot);
    expect(funding).toMatchObject({campaignCkbShannons: 10000000000n, tippingCkbShannons: 20000000000n, campaignHistory: null, tippingHistory: null});
    expect(funding.assets).toEqual([{id: points.hash(), symbol: "Points", decimals: 0, campaignAmount: 7n, tippingAmount: 0n}]);
    expect(funding.historyUnavailableReason).toMatch(/typed-cell storage capacity/);
  });
  it("keeps unknown asset amounts unknown and propagates funding query failure rather than showing0", async () => {
    const f = fixture(), type = ccc.Script.from({codeHash: h("d"), hashType: "type", args: "0x"});
    const cell = ccc.Cell.from({outPoint: {txHash: h("1"), index: 0}, cellOutput: {capacity: 999n, lock: {codeHash: h("8"), hashType: "type", args: f.scope.protocolHash}, type}, outputData: "0x01"});
    jest.mocked(f.client.findCellsPaged).mockResolvedValue({cells: [cell], lastCursor: "done"});
    expect((await readAdminFunding(f.scope, f.snapshot)).assets[0]).toMatchObject({decimals: null, campaignAmount: null, tippingAmount: null});
    jest.mocked(f.client.findCellsPaged).mockRejectedValue(new Error("Indexer offline"));
    await expect(readAdminFunding(f.scope, f.snapshot)).rejects.toThrow("Indexer offline");
  });
});
describe("Admin overview selected period registration proofs", () => {
  it("uses the verified creation transaction and actual block timestamp, not the live User update block", async () => {
    const f = birthFixture();
    await expect(readAdminUserBirth(f.scope, f.userCell)).resolves.toBe(NOW - DAY);
    expect(f.client.findTransactionsPaged).toHaveBeenCalledWith(expect.objectContaining({script: f.userCell.cellOutput.type, scriptType: "type", scriptSearchMode: "exact", groupByTransaction: true}), "asc", 1);
  });
  it("rejects a transaction body/hash mismatch, unavailable parents and a wrong block header", async () => {
    const wrongBody = birthFixture(); jest.mocked(wrongBody.client.getTransaction).mockResolvedValue({transaction: wrongBody.parent, status: "committed", blockNumber: 10n} as Awaited<ReturnType<ccc.Client["getTransaction"]>>);
    await expect(readAdminUserBirth(wrongBody.scope, wrongBody.userCell)).rejects.toThrow(/canonical evidence/);
    const missingParent = birthFixture(); jest.mocked(missingParent.client.getTransaction).mockImplementation(async txHash => txHash === missingParent.creation.hash() ? ({transaction: missingParent.creation, status: "committed", blockNumber: 10n} as Awaited<ReturnType<ccc.Client["getTransaction"]>>) : undefined);
    await expect(readAdminUserBirth(missingParent.scope, missingParent.userCell)).rejects.toThrow(/input parent/);
    const header = birthFixture(); jest.mocked(header.client.getHeaderByNumber).mockResolvedValue({number: 11n, timestamp: BigInt(NOW)} as Awaited<ReturnType<ccc.Client["getHeaderByNumber"]>>);
    await expect(readAdminUserBirth(header.scope, header.userCell)).rejects.toThrow(/block time/);
    const reorg = birthFixture();
    jest.mocked(reorg.client.getTransaction).mockImplementation(async txHash => ({transaction: txHash === reorg.creation.hash() ? reorg.creation : reorg.parent, status: "committed", blockNumber: txHash === reorg.creation.hash() ? 10n : 9n, blockHash: h("1")}) as Awaited<ReturnType<ccc.Client["getTransaction"]>>);
    jest.mocked(reorg.client.getHeaderByNumber).mockResolvedValue({number: 10n, hash: h("2"), timestamp: BigInt(NOW)} as Awaited<ReturnType<ccc.Client["getHeaderByNumber"]>>);
    await expect(readAdminUserBirth(reorg.scope, reorg.userCell)).rejects.toThrow(/block time/);
  });
  it("rejects an update pretending to be the oldest creation via TypeID recomputation", async () => {
    const f = birthFixture();
    const update = ccc.Transaction.from({inputs: [{previousOutput: f.userCell.outPoint}], outputs: [f.userCell.cellOutput], outputsData: [f.userCell.outputData]});
    jest.mocked(f.client.findTransactionsPaged).mockResolvedValue({transactions: [{txHash: update.hash(), blockNumber: 11n, txIndex: 0n, cells: [{isInput: false, cellIndex: 0n}]}], lastCursor: "done"});
    jest.mocked(f.client.getTransaction).mockResolvedValue({transaction: update, status: "committed", blockNumber: 11n} as Awaited<ReturnType<ccc.Client["getTransaction"]>>);
    await expect(readAdminUserBirth(f.scope, f.userCell)).rejects.toThrow(/does not prove creation/);
  });
  it("counts recorded campaign windows versus the prior equal window, but leaves incomplete participants unknown", async () => {
    const f = birthFixture();
    jest.mocked(f.client.findCellsPaged).mockResolvedValue({cells: [f.userCell], lastCursor: "done"});
    const snapshot = {...f.snapshot, campaigns: [f.campaign(h("b"), NOW - DAY), f.campaign(h("d"), NOW - DAY * 2), f.campaign(h("e"), NOW - DAY * 9)]};
    const metrics = await readAdminOverviewMetrics(f.scope, snapshot, "weekly", undefined, NOW);
    expect(metrics.newUsers).toMatchObject({value: 1, deltaPercent: null});
    expect(metrics.campaignsCreated).toEqual({value: 2, deltaPercent: 100});
    expect(metrics.questParticipants.value).toBeNull(); expect(metrics.questParticipants.unavailableReason).toMatch(/edited or deleted/); expect(metrics.questParticipants.retryable).toBe(false);
    expect(metrics.coverageNote).toMatch(/Deleted profiles\/campaigns/);
  });
  it("marks the entire registration metric unknown on partial proof failure without losing current campaign counts", async () => {
    const f = birthFixture(); jest.mocked(f.client.findCellsPaged).mockResolvedValue({cells: [f.userCell], lastCursor: "done"});
    jest.mocked(f.client.findTransactionsPaged).mockRejectedValue(new Error("Birth history unavailable"));
    const metrics = await readAdminOverviewMetrics(f.scope, f.snapshot, "weekly", undefined, NOW);
    expect(metrics.newUsers).toEqual({value: null, deltaPercent: null, unavailableReason: "Birth history unavailable", retryable: true});
    expect(metrics.campaignsCreated.value).toBe(1);
  });
});
