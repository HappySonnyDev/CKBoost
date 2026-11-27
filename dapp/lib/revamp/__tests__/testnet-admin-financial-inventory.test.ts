import {ccc} from "@ckb-ccc/connector-react";
import {CampaignData, ConnectedTypeID, ProtocolData} from "ssri-ckboost/types";
import operator from "../../../config/qa/admin-registry-upgrade-plan.json";
import {readFinancialNamespaceInventory} from "../testnet-admin-financial-inventory";

jest.mock("@ckb-ccc/connector-react", () => ({ccc: jest.requireActual("@ckb-ccc/core")}));
const hash = (byte: string) => `0x${byte.repeat(64)}` as ccc.Hex;
function fixture() {
  const p = operator.protocol, data = ProtocolData.decode(p.outputData), codes = data.protocol_config.script_code_hashes;
  const protocol = ccc.Cell.from({outPoint: p.outPoint, cellOutput: {capacity: p.capacityShannons,
    type: p.typeScript as ccc.ScriptLike, lock: p.lockScript as ccc.ScriptLike}, outputData: p.outputData});
  const protocolHash = protocol.cellOutput.type!.hash();
  const parents = new Map<string, ccc.Transaction>([[protocol.outPoint.txHash, ccc.Transaction.fromBytes(p.transactionHex)]]);
  const live = new Map<string, ccc.Cell>();
  const point = (p: ccc.OutPointLike) => {const out = ccc.OutPoint.from(p); return `${out.txHash}:${out.index}`;};
  live.set(point(protocol.outPoint), protocol);
  const connection = (id: ccc.Hex, key = protocolHash) => ccc.hexFrom(ConnectedTypeID.encode({type_id: id, connected_key: key}));
  const addCampaign = (id: ccc.Hex, key = protocolHash) => {
    const type = ccc.Script.from({codeHash: ccc.hexFrom(codes.ckb_boost_campaign_type_code_hash), hashType: "type", args: connection(id, key)});
    const lock = ccc.Script.from({codeHash: ccc.hexFrom(codes.ckb_boost_protocol_lock_code_hash), hashType: "type", args: connection(hash("a"), key)});
    const campaign = {endorser_lock_hash: hash("a"), staff_lock_hash_vec: [], created_at: 1700000000,
      starting_time: 1700000000, ending_time: 1800000000, rules: [], status: 0, participants_count: 0, total_completions: 0,
      metadata: {title: "Offline campaign", short_description: "", long_description: "", image_url: "",
        total_rewards: {ckb_amount: 0, points_amount: 0, udt_assets: [], nft_assets: []}, verification_requirements: [], last_updated: 1700000000, categories: [], difficulty: 1}, quests: []};
    const parent = ccc.Transaction.from({inputs: [{previousOutput: {txHash: id, index: 0}}],
      outputs: [{capacity: 1000000000000n, type, lock}], outputsData: [ccc.hexFrom(CampaignData.encode(campaign))]});
    const cell = ccc.Cell.from({outPoint: {txHash: parent.hash(), index: 0}, cellOutput: parent.outputs[0], outputData: parent.outputsData[0]});
    parents.set(parent.hash(), parent); live.set(point(cell.outPoint), cell); return cell;
  };
  const addTip = (id: ccc.Hex, key = protocolHash) => ccc.Cell.from({outPoint: {txHash: id, index: 0},
    cellOutput: {capacity: 100000000000n, lock: protocol.cellOutput.lock,
      type: {codeHash: ccc.hexFrom(codes.ckb_boost_tipping_type_code_hash), hashType: "type", args: connection(id, key)}}, outputData: "0x"});
  const campaigns = [addCampaign(hash("b")), addCampaign(hash("c")), addCampaign(hash("d"), hash("e"))];
  const tips = [addTip(hash("f"), hash("e"))];
  const funded = new Set<string>();
  let concurrent = 0, maximum = 0;
  const bounded = <T,>(operation: () => T | Promise<T>) => async () => {
    concurrent++; maximum = Math.max(maximum, concurrent);
    try {await Promise.resolve(); return await operation();} finally {concurrent--;}
  };
  const request = jest.fn(async (method: string) => bounded(() => {
    if (method !== "get_indexer_tip") throw Error("Unexpected RPC method");
    return {block_number: "0x64", block_hash: hash("1")};
  })());
  const getTransaction = jest.fn(async (id: ccc.HexLike) => bounded(() => {
    const transaction = parents.get(ccc.hexFrom(id));
    return transaction ? {transaction, status: "committed", blockNumber: 90n} : undefined;
  })());
  const getCellLive = jest.fn(async (p: ccc.OutPointLike) => bounded(() => live.get(point(p)))());
  const findCellsPagedNoCache = jest.fn(async (key: ccc.ClientIndexerSearchKeyLike, _order?: "asc" | "desc", _limit?: ccc.NumLike, _cursor?: string) => bounded(() => {
    const script = ccc.Script.from(key.script);
    if (key.scriptType === "lock") {
      return {cells: funded.has(script.args) ? [ccc.Cell.from({outPoint: {txHash: hash("8"), index: 0},
        cellOutput: {capacity: 100000000000n, lock: script}, outputData: "0x"})] : [], lastCursor: "done"};
    }
    return {cells: script.codeHash === ccc.hexFrom(codes.ckb_boost_tipping_type_code_hash) ? tips : campaigns, lastCursor: "done"};
  })());
  const client = {addressPrefix: "ckt", requestor: {request}, getTransaction, getCellLive, findCellsPagedNoCache} as unknown as ccc.Client;
  return {protocol, protocolHash, data, codes, client, parents, live, campaigns, tips, funded, addTip, point,
    getTransaction, getCellLive, request, findCellsPagedNoCache, maximum: () => maximum};
}

test("complete inventory filters foreign shared-code cells and queries each Campaign FULL type hash, never its UUID", async () => {
  const f = fixture(), result = await readFinancialNamespaceInventory(f.client, f.protocol);
  expect(result).toEqual({complete: true, oldTips: 0, protocolFunding: 0, campaignFunding: 0,
    campaignTypeHashes: f.campaigns.slice(0, 2).map(c => c.cellOutput.type!.hash()).sort()});
  const fundingArgs = f.findCellsPagedNoCache.mock.calls.filter(([key]) => key.scriptType === "lock").map(([key]) => ccc.Script.from(key.script).args);
  expect(fundingArgs.sort()).toEqual([f.protocolHash, ...result.campaignTypeHashes].sort());
  expect(f.getTransaction).toHaveBeenCalledTimes(3); // protocol + the two QA campaigns, never the foreign campaign.
  expect(f.maximum()).toBeLessThanOrEqual(4);
});

test("a single legacy Tip or Funding match is reported as a blocker rather than hidden or treated as a balance total", async () => {
  const f = fixture(); f.tips.push(f.addTip(hash("7"))); f.funded.add(f.protocolHash); f.funded.add(f.campaigns[0].cellOutput.type!.hash());
  await expect(readFinancialNamespaceInventory(f.client, f.protocol)).resolves.toMatchObject({complete: true, oldTips: 1, protocolFunding: 1, campaignFunding: 1});
});

test("canonical raw parent and fresh live body must both match each QA campaign", async () => {
  let f = fixture(); f.parents.set(f.campaigns[0].outPoint.txHash, f.parents.get(f.protocol.outPoint.txHash)!);
  await expect(readFinancialNamespaceInventory(f.client, f.protocol)).rejects.toThrow(/parent transaction raw hash/);
  f = fixture(); f.live.delete(f.point(f.campaigns[0].outPoint));
  await expect(readFinancialNamespaceInventory(f.client, f.protocol)).rejects.toThrow(/committed\/live/);
  f = fixture(); const old = f.campaigns[0]; f.live.set(f.point(old.outPoint), ccc.Cell.from({...old, cellOutput: {...old.cellOutput, capacity: old.cellOutput.capacity + 1n}}));
  await expect(readFinancialNamespaceInventory(f.client, f.protocol)).rejects.toThrow(/committed\/live/);
});

test("spent protocol is rejected by default; explicit historical read only scans the proven OLD namespaces", async () => {
  const f = fixture(); f.live.delete(f.point(f.protocol.outPoint));
  await expect(readFinancialNamespaceInventory(f.client, f.protocol)).rejects.toThrow(/committed\/live/);
  f.getCellLive.mockClear();
  await expect(readFinancialNamespaceInventory(f.client, f.protocol, () => true, {historicalProtocol: true})).resolves.toMatchObject({complete: true, oldTips: 0});
  expect(f.getCellLive.mock.calls.some(([p]) => f.point(p) === f.point(f.protocol.outPoint))).toBe(false);
  f.parents.delete(f.protocol.outPoint.txHash);
  await expect(readFinancialNamespaceInventory(f.client, f.protocol, () => true, {historicalProtocol: true})).rejects.toThrow(/not committed/);
});

test("unverified Indexer coverage, missing capability or a changed protocol never returns complete", async () => {
  let f = fixture(); f.request.mockResolvedValue({block_number: "0x1", block_hash: hash("1")});
  await expect(readFinancialNamespaceInventory(f.client, f.protocol)).rejects.toThrow(/Indexer has not reached/);
  f = fixture(); delete (f.client as unknown as {requestor?: unknown}).requestor;
  await expect(readFinancialNamespaceInventory(f.client, f.protocol)).rejects.toThrow(/cannot prove Indexer/);
  f = fixture(); let reads = 0; const original = f.getCellLive.getMockImplementation()!;
  f.getCellLive.mockImplementation(async p => f.point(p) === f.point(f.protocol.outPoint) && ++reads > 1 ? undefined : original(p));
  await expect(readFinancialNamespaceInventory(f.client, f.protocol)).rejects.toThrow(/protocol or Indexer coverage changed/);
});

test("malformed shared-code args, wrong owner namespace and duplicate Campaign identities fail closed", async () => {
  let f = fixture(); f.tips.push(ccc.Cell.from({...f.addTip(hash("7")), cellOutput: {...f.tips[0].cellOutput,
    type: {...f.tips[0].cellOutput.type!, args: "0x01"}}}));
  await expect(readFinancialNamespaceInventory(f.client, f.protocol)).rejects.toThrow();
  f = fixture(); const wrong = f.campaigns[0]; f.campaigns[0] = ccc.Cell.from({...wrong, cellOutput: {...wrong.cellOutput,
    lock: {...wrong.cellOutput.lock, args: ccc.hexFrom(ConnectedTypeID.encode({type_id: hash("a"), connected_key: hash("e")}))}}});
  await expect(readFinancialNamespaceInventory(f.client, f.protocol)).rejects.toThrow(/owner lock/);
  f = fixture(); f.campaigns.push(ccc.Cell.from({...f.campaigns[0], outPoint: {txHash: hash("6"), index: 0}}));
  await expect(readFinancialNamespaceInventory(f.client, f.protocol)).rejects.toThrow(/duplicate current QA Campaign/);
});

test("terminal pagination is required and repeated pages/cursors are not empty success", async () => {
  const f = fixture(), original = f.findCellsPagedNoCache.getMockImplementation()!;
  const foreign = f.tips[0], full = Array.from({length: 100}, (_, index) => ccc.Cell.from({...foreign, outPoint: {txHash: foreign.outPoint.txHash, index}}));
  f.findCellsPagedNoCache.mockImplementation(async (key, order, limit, cursor) => key.scriptType === "type" && ccc.Script.from(key.script).codeHash === ccc.hexFrom(f.codes.ckb_boost_tipping_type_code_hash)
    ? {cells: full, lastCursor: "repeated"} : original(key, order, limit, cursor));
  await expect(readFinancialNamespaceInventory(f.client, f.protocol)).rejects.toThrow(/duplicate|pagination/);
});

test("a complete 20 full pages without a terminal page exhausts the explicit scan budget", async () => {
  const f = fixture(), original = f.findCellsPagedNoCache.getMockImplementation()!;
  let page = 0;
  f.findCellsPagedNoCache.mockImplementation(async (key, order, limit, cursor) => {
    if (key.scriptType !== "type" || ccc.Script.from(key.script).codeHash !== ccc.hexFrom(f.codes.ckb_boost_tipping_type_code_hash)) return original(key, order, limit, cursor);
    const current = page++;
    return {cells: Array.from({length: 100}, (_, i) => ccc.Cell.from({...f.tips[0], outPoint: {txHash: hash("f"), index: current * 100 + i}})), lastCursor: `page-${page}`};
  });
  await expect(readFinancialNamespaceInventory(f.client, f.protocol)).rejects.toThrow(/exceeded 20 pages/);
  expect(page).toBe(20);
});

test("guard changes during an in-flight read discard the result and stop later queries", async () => {
  const f = fixture(); let current = true;
  const original = f.getTransaction.getMockImplementation()!;
  f.getTransaction.mockImplementation(async id => {const result = await original(id); current = false; return result;});
  await expect(readFinancialNamespaceInventory(f.client, f.protocol, () => current)).rejects.toThrow(/operation changed/);
  expect(f.findCellsPagedNoCache).not.toHaveBeenCalled();
});

test("mainnet, foreign full protocol and malformed protocol data reject before any public request", async () => {
  const f = fixture(); (f.client as unknown as {addressPrefix: string}).addressPrefix = "ckb";
  await expect(readFinancialNamespaceInventory(f.client, f.protocol)).rejects.toThrow(/exact dedicated Testnet/);
  (f.client as unknown as {addressPrefix: string}).addressPrefix = "ckt";
  await expect(readFinancialNamespaceInventory(f.client, ccc.Cell.from({...f.protocol, cellOutput: {...f.protocol.cellOutput,
    type: {...f.protocol.cellOutput.type!, args: hash("7")}}}))).rejects.toThrow(/exact dedicated Testnet/);
  await expect(readFinancialNamespaceInventory(f.client, ccc.Cell.from({...f.protocol, outputData: "0x01"}))).rejects.toThrow();
  expect(f.getTransaction).not.toHaveBeenCalled(); expect(f.findCellsPagedNoCache).not.toHaveBeenCalled();
});

test("one stalled request cannot outlive the shared deadline or launch queued work afterwards", async () => {
  jest.useFakeTimers();
  try {
    const f = fixture(); f.getTransaction.mockImplementation(() => new Promise(() => {}));
    const result = readFinancialNamespaceInventory(f.client, f.protocol);
    const assertion = expect(result).rejects.toThrow(/30-second/);
    await jest.advanceTimersByTimeAsync(30_000); await assertion;
    expect(f.findCellsPagedNoCache).not.toHaveBeenCalled();
    expect(f.maximum()).toBeLessThanOrEqual(4);
  } finally {jest.useRealTimers();}
});
