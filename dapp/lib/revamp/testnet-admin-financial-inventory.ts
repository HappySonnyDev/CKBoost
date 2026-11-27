import {ccc} from "@ckb-ccc/connector-react";
import {CampaignData, ConnectedTypeID, ProtocolData} from "ssri-ckboost/types";

const PROTOCOL = "0x4eacaf9b1a120d2bfd99f26fcedfdcfe6ef116484e9b478b0a104a872316e034";
const LIMIT = 100;
const MAX_PAGES = 20;
const DEADLINE_MS = 30_000;
const assert: (value: unknown, message: string) => asserts value = (value, message) => {
  if (!value) throw new Error(`Financial namespace inventory: ${message}`);
};
const point = (value: ccc.OutPointLike) => {
  const p = ccc.OutPoint.from(value);
  return `${p.txHash}:${p.index}`;
};
const sameCell = (a: ccc.Cell, b: ccc.Cell) => a.outPoint.eq(b.outPoint)
  && ccc.hexFrom(a.cellOutput.toBytes()) === ccc.hexFrom(b.cellOutput.toBytes()) && a.outputData === b.outputData;

export interface FinancialNamespaceInventory {
  complete: true;
  oldTips: number;
  protocolFunding: number;
  campaignFunding: number;
  campaignTypeHashes: string[];
}

/** A bounded public-read snapshot, not a migration or broadcast authorization.
 * All requests share four slots and one deadline. Any incomplete page, stale
 * cell, malformed matching namespace or changed caller scope fails closed.
 * The caller must repeat this immediately before its explicit write boundary.
 */
export async function readFinancialNamespaceInventory(
  client: ccc.Client,
  protocolCell: ccc.Cell,
  guard: () => boolean = () => true,
  options: {historicalProtocol?: boolean} = {},
): Promise<FinancialNamespaceInventory> {
  const deadline = Date.now() + DEADLINE_MS;
  let expired = false, active = 0;
  const queue: Array<() => void> = [];
  const check = () => {
    assert(!expired && Date.now() < deadline, "the shared 30-second read deadline ended; nothing is complete.");
    assert(guard(), "the wallet, protocol or operation changed.");
  };
  const drain = () => {while (active < 4 && queue.length) queue.shift()!();};
  const read = <T,>(operation: () => Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    queue.push(() => {
      try {check();} catch (error) {reject(error); return;}
      active++;
      Promise.resolve().then(operation).then(value => {check(); resolve(value);}, reject)
        .catch(reject).finally(() => {active--; drain();});
    });
    drain();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {timer = setTimeout(() => {
    expired = true;
    drain();
    reject(new Error("Financial namespace inventory: the shared 30-second read deadline ended; nothing is complete."));
  }, DEADLINE_MS);});

  try {
    return await Promise.race([(async (): Promise<FinancialNamespaceInventory> => {
      check();
      assert(client.addressPrefix === "ckt" && protocolCell.cellOutput.type?.hash() === PROTOCOL,
        "only the exact dedicated Testnet protocol can be inventoried.");
      const protocol = ProtocolData.decode(protocolCell.outputData);
      assert(ccc.hexFrom(ProtocolData.encode(protocol)) === protocolCell.outputData, "noncanonical ProtocolData.");
      const codes = protocol.protocol_config.script_code_hashes;
      const lockCode = ccc.hexFrom(codes.ckb_boost_protocol_lock_code_hash);
      const tipCode = ccc.hexFrom(codes.ckb_boost_tipping_type_code_hash);
      const campaignCode = ccc.hexFrom(codes.ckb_boost_campaign_type_code_hash);
      const fundingCode = ccc.hexFrom(codes.ckb_boost_funding_lock_code_hash);
      const connection = (script: ccc.Script) => {
        const id = ConnectedTypeID.decode(script.args);
        assert(ccc.hexFrom(ConnectedTypeID.encode(id)) === script.args, "noncanonical ConnectedTypeID.");
        return id;
      };
      const protocolLock = protocolCell.cellOutput.lock;
      assert(protocolLock.hashType === "type" && protocolLock.codeHash === lockCode
        && ccc.hexFrom(connection(protocolLock).connected_key) === PROTOCOL, "the protocol owner lock is not canonically bound.");

      const requestor = (client as ccc.Client & {requestor?: {request?: (method: string, params: unknown[]) => Promise<unknown>}}).requestor;
      assert(typeof requestor?.request === "function", "this client cannot prove Indexer coverage.");
      const indexerTip = async () => {
        const result = await read(() => requestor.request!("get_indexer_tip", [])) as {block_number?: unknown; block_hash?: unknown} | null;
        assert(result && typeof result.block_number === "string" && /^0x[0-9a-f]+$/i.test(result.block_number)
          && typeof result.block_hash === "string" && /^0x[0-9a-f]{64}$/i.test(result.block_hash), "invalid Indexer coverage proof.");
        return BigInt(result.block_number);
      };
      const parents = new Map<string, Promise<{transaction: ccc.Transaction; blockNumber: bigint}>>();
      const parent = (hash: ccc.Hex) => {
        let known = parents.get(hash);
        if (!known) {
          known = (async () => {
            const response = await read(() => client.getTransaction(hash));
            assert(response?.status === "committed" && response.transaction, "a canonical input/output parent is not committed.");
            const transaction = ccc.Transaction.fromBytes(response.transaction.toBytes());
            assert(transaction.hash() === hash, "the parent transaction raw hash differs from its outpoint.");
            let blockNumber = response.blockNumber;
            if (blockNumber == null) {
              assert(response.blockHash, "the committed parent has no block evidence.");
              const header = await read(() => client.getHeaderByHash(response.blockHash!));
              assert(header && header.hash === response.blockHash, "the parent block header cannot be verified.");
              blockNumber = header.number;
            }
            assert(blockNumber >= 0n, "invalid committed block number.");
            return {transaction, blockNumber};
          })();
          parents.set(hash, known);
        }
        return known;
      };
      const prove = async (cell: ccc.Cell, requireLive = true) => {
        const [record, live] = await Promise.all([parent(cell.outPoint.txHash), requireLive ? read(() => client.getCellLive(cell.outPoint, true)) : Promise.resolve(null)]);
        const index = Number(cell.outPoint.index);
        assert(record.transaction.outputs[index] && record.transaction.outputsData[index] != null,
          "the indexed output is absent from its canonical parent.");
        const committed = ccc.Cell.from({outPoint: cell.outPoint, cellOutput: record.transaction.outputs[index], outputData: record.transaction.outputsData[index]});
        assert(sameCell(committed, cell) && (!requireLive || live && sameCell(live, cell)), "indexed/committed/live script, capacity or data disagree.");
        return record.blockNumber;
      };
      // Confirmation of a later config transaction must scan OLD namespaces
      // from its actual consumed before-state. This option proves that parent's
      // committed bytes, never current authorization; signing uses the default.
      const protocolBlock = await prove(protocolCell, !options.historicalProtocol);
      assert(await indexerTip() >= protocolBlock, "the Indexer has not reached the actual current protocol.");

      const pages = async (codeHash: ccc.Hex) => {
        const script = ccc.Script.from({codeHash, hashType: "type", args: "0x"});
        const cells: ccc.Cell[] = [], seen = new Set<string>();
        let cursor: string | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
          const result = await read(() => client.findCellsPagedNoCache({script, scriptType: "type", scriptSearchMode: "prefix", withData: true}, "desc", LIMIT, cursor));
          assert(Array.isArray(result.cells) && result.cells.length <= LIMIT, "invalid shared-code Indexer page.");
          for (const cell of result.cells) {
            assert(cell.cellOutput.type?.codeHash === codeHash && cell.cellOutput.type.hashType === "type", "unexpected shared-code result.");
            assert(!seen.has(point(cell.outPoint)), "duplicate shared-code result or repeated page.");
            seen.add(point(cell.outPoint)); cells.push(cell);
          }
          if (result.cells.length < LIMIT) return cells;
          assert(typeof result.lastCursor === "string" && result.lastCursor.length > 0 && result.lastCursor !== cursor,
            "shared-code pagination did not advance.");
          cursor = result.lastCursor;
        }
        throw new Error("Financial namespace inventory: shared-code pagination exceeded 20 pages; nothing is complete.");
      };
      const inProtocol = (cell: ccc.Cell) => ccc.hexFrom(connection(cell.cellOutput.type!).connected_key) === PROTOCOL;
      const funding = async (args: ccc.Hex): Promise<number> => {
        const lock = ccc.Script.from({codeHash: fundingCode, hashType: "type", args});
        const result = await read(() => client.findCellsPagedNoCache({script: lock, scriptType: "lock", scriptSearchMode: "exact", withData: true}, "desc", 1));
        assert(Array.isArray(result.cells) && result.cells.length <= 1 && result.cells.every(cell => cell.cellOutput.lock.eq(lock)),
          "unexpected exact Funding namespace result.");
        // A single match already prevents switching: this is a presence count,
        // deliberately not a claimed total capacity or complete nonempty list.
        return result.cells.length;
      };
      const [tipCells, campaignCells, protocolFunding] = await Promise.all([pages(tipCode), pages(campaignCode), funding(PROTOCOL)]);
      const oldTips = tipCells.filter(inProtocol).length;
      const campaigns = campaignCells.filter(inProtocol);
      const identities = new Set<string>();
      for (const cell of campaigns) {
        const type = cell.cellOutput.type!, owner = cell.cellOutput.lock;
        assert(!identities.has(type.hash()), "duplicate current QA Campaign identity.");
        identities.add(type.hash());
        assert(owner.hashType === "type" && owner.codeHash === lockCode
          && ccc.hexFrom(connection(owner).connected_key) === PROTOCOL, "a QA Campaign owner lock belongs to a different protocol.");
        const campaign = CampaignData.decode(cell.outputData);
        assert(ccc.hexFrom(CampaignData.encode(campaign)) === cell.outputData, "noncanonical current QA CampaignData.");
      }
      const campaignCounts = await Promise.all(campaigns.map(async cell => {await prove(cell); return funding(cell.cellOutput.type!.hash());}));
      // Never return a complete snapshot after its captured protocol was spent.
      const [current, coverage] = await Promise.all([options.historicalProtocol ? Promise.resolve(null) : read(() => client.getCellLive(protocolCell.outPoint, true)), indexerTip()]);
      assert((options.historicalProtocol || current && sameCell(current, protocolCell)) && coverage >= protocolBlock, "the protocol or Indexer coverage changed before completion.");
      check();
      return {complete: true, oldTips, protocolFunding,
        campaignFunding: campaignCounts.reduce((sum, count) => sum + count, 0), campaignTypeHashes: [...identities].sort()};
    })(), timeout]);
  } finally {expired = true; clearTimeout(timer); drain();}
}
