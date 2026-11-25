import {ccc} from "@ckb-ccc/connector-react";
import {ConnectedTypeID, ProtocolData, UserData} from "ssri-ckboost/types";
import {makeProfileReadScope} from "../profile-model";
export const userHash = (letter: string) => `0x${letter.repeat(64)}` as ccc.Hex;
export function adminUsersFixture() {
  const h = userHash, client = {addressPrefix: "ckt"} as ccc.Client;
  const lock = ccc.Script.from({codeHash: h("9"), hashType: "type", args: `0x${"11".repeat(22)}`});
  const targetLock = ccc.Script.from({...lock, args: `0x${"22".repeat(22)}`}), address = ccc.Address.fromScript(lock, client), targetAddress = ccc.Address.fromScript(targetLock, client);
  const codes = {ckb_boost_protocol_type_code_hash: h("1"), ckb_boost_protocol_lock_code_hash: h("2"), ckb_boost_campaign_type_code_hash: h("3"), ckb_boost_funding_lock_code_hash: h("4"), ckb_boost_user_type_code_hash: h("5"), ckb_boost_points_udt_type_code_hash: h("6"), ckb_boost_tipping_type_code_hash: h("7"), ckb_boost_achievement_type_code_hash: h("8"), accepted_udt_type_scripts: [], accepted_dob_type_scripts: []};
  const protocol = {campaigns_approved: [], tippings_approved: [], tipping_config: {approval_requirement_thresholds: [2], expiration_duration: 86400}, endorsers_whitelist: [], last_updated: 1700000000,
    protocol_config: {admin_lock_hash_vec: [lock.hash(), targetLock.hash()], script_code_hashes: codes, streak_bonus_interval: 0, streak_bonus_amount: 0, achievement_type_hashes: []}};
  const protocolCell = ccc.Cell.from({outPoint: {txHash: h("a"), index: 0}, cellOutput: {capacity: 100000000000n, lock: {codeHash: h("2"), hashType: "type", args: h("f")}, type: {codeHash: h("1"), hashType: "type", args: h("f")}}, outputData: ccc.hexFrom(ProtocolData.encode(protocol))});
  const scope = makeProfileReadScope(client, protocolCell, address, "testnet");
  const data = {verification_data: {telegram_personal_chat_id: 123, identity_verification_data: []}, total_points_earned: 7, last_activity_timestamp: 1700000000, submission_records: [{campaign_type_id: h("c"), quest_id: 1, submission_timestamp: 1700000000, submission_content: "nevent-real-reference"}], profile_data: [], last_bonus_streak_at: 0};
  const userCell = (id = h("b"), wallet = targetLock, connected = scope.protocolHash) => ccc.Cell.from({outPoint: {txHash: id, index: 0}, cellOutput: {capacity: 100000000000n, lock: wallet, type: {codeHash: h("5"), hashType: "type", args: ccc.hexFrom(ConnectedTypeID.encode({type_id: id, connected_key: connected}))}}, outputData: ccc.hexFrom(UserData.encode(data))});
  return {client, lock, targetLock, address, targetAddress, protocol, protocolCell, scope, data, userCell};
}
