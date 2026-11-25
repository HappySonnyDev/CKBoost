import {ccc} from "@ckb-ccc/connector-react";
import {ProtocolData} from "ssri-ckboost/types";
import {adminUserFromCell, adminTargetProfile, applyAdminManualVerifications, filterAdminUsers, makeAdminAccessPlan, makeAdminVerificationPayload, readAdminUser, readAdminUserJoinDates, readAdminUsers, sortAdminUsers} from "../admin-users-model";
import {readAdminUserBirth} from "../admin-overview-model";
import {adminUsersFixture, userHash as h} from "./admin-users-fixtures";
jest.mock("@ckb-ccc/connector-react", () => ({ccc: jest.requireActual("@ckb-ccc/core")}));
jest.mock("../admin-overview-model", () => ({...jest.requireActual("../admin-overview-model"), readAdminUserBirth: jest.fn()}));
beforeEach(() => jest.clearAllMocks());
describe("Admin Users exact identities and facts", () => {
  it("queries only after current Admin authorization and rejects foreign protocol candidates", async () => {
    const f = adminUsersFixture(); const query = jest.fn().mockResolvedValue({cells: [f.userCell(), f.userCell(h("e"), f.targetLock, h("f"))], lastCursor: "done"}); f.client.findCellsPaged = query;
    expect((await readAdminUsers(f.scope)).map(row => row.id)).toEqual([h("b")]);
    expect(query.mock.calls[0][0]).toMatchObject({script: {codeHash: h("5"), hashType: "type"}, scriptType: "type", scriptSearchMode: "prefix"});
    f.scope.protocol.protocol_config.admin_lock_hash_vec = []; query.mockClear(); await expect(readAdminUsers(f.scope)).rejects.toThrow(/Only a current platform Admin/); expect(query).not.toHaveBeenCalled();
  });
  it("fails duplicated identities and uses a canonical exact User type in details", async () => {
    const f = adminUsersFixture(), cell = f.userCell(); const other = ccc.Cell.from({...cell, outPoint: {txHash: h("d"), index: 1}});
    f.client.findCellsPaged = jest.fn().mockResolvedValue({cells: [cell, other], lastCursor: "done"}); await expect(readAdminUsers(f.scope)).rejects.toThrow(/Multiple live/);
    f.client.findCellsPaged = jest.fn().mockResolvedValue({cells: [cell], lastCursor: "done"}); expect((await readAdminUser(f.scope, h("b")))?.typeHash).toBe(cell.cellOutput.type!.hash());
    expect(jest.mocked(f.client.findCellsPaged).mock.calls[0][0]).toMatchObject({script: cell.cellOutput.type, scriptSearchMode: "exact"});
    await expect(readAdminUser(f.scope, "0xb")).rejects.toThrow(/32-byte/);
  });
  it("preserves recorded earned Points, current submission counts and the target wallet scope separately", () => {
    const f = adminUsersFixture(), row = adminUserFromCell(f.scope, f.userCell());
    expect(row).toMatchObject({recordedPoints: 7n, campaignsParticipated: 1, questsSubmitted: 1, telegram: true, manual: null, role: "platform-admin", lastActiveAt: 1700000000000});
    const target = adminTargetProfile(f.scope, row); expect(target.scope.lockHash).toBe(f.targetLock.hash()); expect(target.scope.protocolHash).toBe(f.scope.protocolHash); expect(target.identity.userTypeId).toBe(h("b"));
    expect(() => adminTargetProfile(f.scope, {...row, typeHash: h("f")})).toThrow(/identity changed/);
  });
  it("sorts newest activity first, then Admin, Organizer, Member, with deterministic identity ties", () => {
    const f = adminUsersFixture(), row = adminUserFromCell(f.scope, f.userCell());
    const records = [{...row, id: h("1"), role: "member" as const}, {...row, id: h("2"), role: "organizer" as const}, {...row, id: h("3"), role: "platform-admin" as const}, {...row, id: h("4"), lastActiveAt: row.lastActiveAt! + 1, role: "member" as const}];
    expect(sortAdminUsers(records).map(value => value.id)).toEqual([h("4"), h("3"), h("2"), h("1")]);
  });
  it("supports name/wallet search and independent Telegram plus Manual filters, without treating unknown as unverified", () => {
    const f = adminUsersFixture(), row = {...adminUserFromCell(f.scope, f.userCell()), displayName: "Cell Explorer"};
    const registry = {protocolTypeHash: f.scope.protocolHash, available: true, unavailableReason: null, attestations: [{userTypeHash: row.typeHash, walletLockHash: row.lockHash, verified: true, verifiedAt: 1, verifiedByLockHash: f.scope.lockHash, transactionHash: h("e")}]};
    const verified = applyAdminManualVerifications(f.scope, [row], registry);
    expect(filterAdminUsers(verified, "explorer", "all", "manual")).toHaveLength(1); expect(filterAdminUsers(verified, row.address.slice(5, 23), "all", "telegram")).toHaveLength(1);
    expect(filterAdminUsers([{...row, telegram: false, manual: null}], "", "all", "unverified")).toEqual([]);
    expect(applyAdminManualVerifications(f.scope, [row], {...registry, attestations: [{...registry.attestations[0], walletLockHash: h("f")} ]})[0].manual).toBe(false);
    expect(() => applyAdminManualVerifications(f.scope, [row], {...registry, protocolTypeHash: h("f")})).toThrow(/another protocol/);
  });
  it("binds manual verification to the complete User script, owner, output and actual data hash", () => {
    const f = adminUsersFixture(), row = adminUserFromCell(f.scope, f.userCell()), payload = makeAdminVerificationPayload(f.scope, row);
    expect(payload).toMatchObject({protocolTypeHash: f.scope.protocolHash, userTypeId: row.id, userTypeHash: row.typeHash, walletLockHash: row.lockHash, expectedUserOutPoint: {txHash: row.cell.outPoint.txHash, index: "0"}, expectedUserDataHash: ccc.hashCkb(row.cell.outputData), verified: true});
    expect(() => makeAdminVerificationPayload(f.scope, {...row, lockHash: h("e")})).toThrow(/exact current User/);
  });
  it("proves visible-page join dates independently and leaves a failed proof unknown", async () => {
    const f = adminUsersFixture(), rows = [adminUserFromCell(f.scope, f.userCell()), adminUserFromCell(f.scope, f.userCell(h("d")))];
    jest.mocked(readAdminUserBirth).mockResolvedValueOnce(1700000000000).mockRejectedValueOnce(new Error("Creation header unavailable"));
    expect(await readAdminUserJoinDates(f.scope, rows)).toEqual({[h("b")]: {at: 1700000000000, error: null}, [h("d")]: {at: null, error: "Creation header unavailable"}});
    await expect(readAdminUserJoinDates(f.scope, Array(21).fill(rows[0]))).rejects.toThrow(/one visible page/);
  });
});
describe("explicit signed access update plans", () => {
  it("uses exclusive role semantics, lists all revoked permissions and preserves unrelated protocol fields", () => {
    const f = adminUsersFixture(); f.scope.protocol.endorsers_whitelist = [{endorser_lock_hash: f.targetLock.hash(), endorser_name: "Organizer", endorser_description: "", website: "", social_links: [], verified: 1}];
    const plan = makeAdminAccessPlan(f.scope, f.targetAddress, "member");
    expect(plan.changes).toEqual(["Revoke Platform admin access", "Revoke Organizer access"]); expect(plan.updated.protocol_config.admin_lock_hash_vec).toEqual([f.lock.hash()]); expect(plan.updated.endorsers_whitelist).toEqual([]);
    const before = ProtocolData.decode(ProtocolData.encode(f.scope.protocol)), after = ProtocolData.decode(ProtocolData.encode(plan.updated)); before.protocol_config.admin_lock_hash_vec = after.protocol_config.admin_lock_hash_vec; before.endorsers_whitelist = after.endorsers_whitelist;
    expect(ccc.hexFrom(ProtocolData.encode(after))).toBe(ccc.hexFrom(ProtocolData.encode(before)));
    const organizer = makeAdminAccessPlan(f.scope, f.targetAddress, "organizer"); expect(organizer.changes).toEqual(["Revoke Platform admin access"]); expect(organizer.updated.endorsers_whitelist[0]).toEqual(f.scope.protocol.endorsers_whitelist[0]);
  });
  it("adds Organizer or Admin explicitly, removes duplicate grants and never removes the last Admin", () => {
    const f = adminUsersFixture(); f.scope.protocol.protocol_config.admin_lock_hash_vec = [f.lock.hash()];
    expect(makeAdminAccessPlan(f.scope, f.targetAddress, "organizer").changes).toEqual(["Grant Organizer access"]);
    expect(makeAdminAccessPlan(f.scope, f.targetAddress, "platform-admin").changes).toEqual(["Grant Platform admin access"]);
    expect(() => makeAdminAccessPlan(f.scope, f.address, "member")).toThrow(/last platform Admin/);
    expect(() => makeAdminAccessPlan(f.scope, f.targetAddress, "member")).toThrow(/already has exactly/);
    expect(() => makeAdminAccessPlan(f.scope, f.targetAddress, "" as "member")).toThrow(/explicit/);
  });
});
