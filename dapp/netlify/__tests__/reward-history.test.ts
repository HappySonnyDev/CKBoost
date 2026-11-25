import { ccc } from "@ckb-ccc/core";
import { handler } from "../functions/reward-history";

const h = (byte: string) => `0x${byte.repeat(32)}` as ccc.Hex;
const mockCode = h("11");
const mockQaProtocol = { codeHash: h("22"), hashType: "type" as const, args: h("23") };
let mockIsolated: { protocol: { typeScript: typeof mockQaProtocol } } | null = null;
let mockInvalidQa = false;
type Match = { txHash: ccc.Hex; blockNumber: bigint; txIndex: bigint; cells: Array<{ isInput: boolean; cellIndex: bigint }> };
let mockMatches: Match[] = [];
const mockResponses = new Map<string, { transaction: { outputsData: ccc.Hex[]; inputs: Array<{ getCell: jest.Mock }> } }>();
const mockFind = jest.fn((_search: unknown, _order: unknown, _limit: unknown) => (async function* () { yield* mockMatches; })());
const mockGet = jest.fn(async (hash: string) => mockResponses.get(hash));
jest.mock("@ckb-ccc/shell", () => ({ ccc: { ...jest.requireActual("@ckb-ccc/core").ccc,
  ClientPublicTestnet: jest.fn(() => ({ addressPrefix: "ckt", findTransactions: mockFind, getTransaction: mockGet })),
} }));
jest.mock("@/lib/ckb/deployment-manager", () => ({ deploymentManager: { getCurrentNetwork: () => "testnet", getContractCodeHash: () => mockCode } }));
jest.mock("@/lib/ckb/isolated-runtime.mjs", () => ({ getIsolatedRuntime: () => {
  if (mockInvalidQa) throw new Error("Isolated QA configuration: invalid profile");
  return mockIsolated;
} }));
jest.mock("@/netlify/lib/streak-bonus", () => ({ readUdtAmount: (data: ccc.Hex) => {
  const core = jest.requireActual("@ckb-ccc/core").ccc;
  return core.numLeFromBytes(core.bytesFrom(data).subarray(0, 16));
} }));
jest.mock("@/netlify/lib/log", () => ({ createLogger: () => ({ warn: jest.fn(), error: jest.fn() }) }));
const envKeys = ["NEXT_PUBLIC_PROTOCOL_TYPE_CODE_HASH", "NEXT_PUBLIC_PROTOCOL_TYPE_HASH_TYPE", "NEXT_PUBLIC_PROTOCOL_TYPE_ARGS"] as const;
let prior: Record<string, string | undefined>;
const amount = (value: bigint) => ccc.hexFrom(ccc.numToBytes(value, 16));
const address = new ccc.Address(ccc.Script.from({ codeHash: h("31"), hashType: "type", args: "0x" }), "ckt").toString();
function addTransaction(byte = "40", input = 100n, output = 120n) {
  const txHash = h(byte), getCell = jest.fn().mockResolvedValue({ outputData: amount(input) });
  const response = { transaction: { outputsData: [amount(output)], inputs: [{ getCell }] } };
  const match: Match = { txHash, blockNumber: 1n, txIndex: 0n, cells: [{ isInput: true, cellIndex: 0n }, { isInput: false, cellIndex: 0n }] };
  mockMatches.push(match); mockResponses.set(txHash, response);
  return { getCell, response, match };
}
async function invoke() {
  const result = await handler({ httpMethod: "GET", queryStringParameters: { address, limit: "20" } } as unknown as Parameters<typeof handler>[0], {} as Parameters<typeof handler>[1], jest.fn());
  if (!result || typeof result.body !== "string") throw new Error("Expected JSON response");
  return { statusCode: result.statusCode, body: JSON.parse(result.body) };
}
beforeEach(() => {
  prior = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  process.env.NEXT_PUBLIC_PROTOCOL_TYPE_CODE_HASH = h("51");
  process.env.NEXT_PUBLIC_PROTOCOL_TYPE_HASH_TYPE = "data1";
  process.env.NEXT_PUBLIC_PROTOCOL_TYPE_ARGS = "0x1234";
  mockMatches = []; mockResponses.clear(); mockIsolated = null; mockInvalidQa = false; jest.clearAllMocks();
});
afterEach(() => { for (const key of envKeys) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; } });

it.each(["normal", "QA"])("preserves exact successful response and protocol scope in %s mode", async mode => {
  if (mode === "QA") mockIsolated = { protocol: { typeScript: mockQaProtocol } };
  addTransaction();
  const result = await invoke();
  const expectedProtocol = ccc.Script.from(mode === "QA" ? mockQaProtocol : { codeHash: h("51"), hashType: "data1", args: "0x1234" }).hash();
  expect(result).toMatchObject({ statusCode: 200, body: { address, protocolTypeHash: expectedProtocol, transactions: [{ netPoints: "20", inputs: [{ index: 0, amount: "100" }], outputs: [{ index: 0, amount: "120" }] }] } });
  expect(mockFind).toHaveBeenCalledWith(expect.objectContaining({ scriptSearchMode: "exact", script: expect.objectContaining({ codeHash: mockCode, args: expectedProtocol }) }), "desc", 20);
});

it("does not present a zero-net consolidation as received Points", async () => {
  addTransaction("41", 100n, 100n);
  expect(await invoke()).toMatchObject({ statusCode: 200, body: { transactions: [] } });
});

it("subtracts Uint128 inputs without Number precision loss", async () => {
  addTransaction("42", 2n ** 100n, 2n ** 100n + 37n);
  expect(await invoke()).toMatchObject({ statusCode: 200, body: { transactions: [{ netPoints: "37" }] } });
});

it.each(["rejected", "missing", "short-data", "invalid-hex"])("fails the complete request for %s predecessor data instead of inflating a zero-net change", async failure => {
  const { getCell } = addTransaction("43", 100n, 100n);
  if (failure === "rejected") getCell.mockRejectedValue(new Error("RPC timeout"));
  if (failure === "missing") getCell.mockResolvedValue(undefined);
  if (failure === "short-data") getCell.mockResolvedValue({ outputData: "0x01" });
  if (failure === "invalid-hex") getCell.mockResolvedValue({ outputData: "not-hex" });
  const result = await invoke();
  expect(result.statusCode).toBe(500); expect(result.body.error).toContain("fully resolved");
  expect(result.body).not.toHaveProperty("transactions");
});

it("rejects an unresolved matched input index and an unavailable matched transaction", async () => {
  const { match } = addTransaction(); match.cells[0].cellIndex = 2n;
  expect((await invoke()).statusCode).toBe(500);
  mockResponses.clear();
  expect((await invoke()).statusCode).toBe(500);
});

it("never returns earlier successful rows as a complete partial history after a later input fails", async () => {
  addTransaction("44"); const { getCell } = addTransaction("45"); getCell.mockRejectedValue(new Error("RPC unavailable"));
  expect(await invoke()).toEqual({ statusCode: 500, body: { error: expect.stringContaining("fully resolved") } });
});

it("fails closed for invalid QA instead of falling back to valid legacy identity", async () => {
  mockInvalidQa = true;
  await expect(invoke()).rejects.toThrow("Isolated QA");
  expect(mockFind).not.toHaveBeenCalled(); expect(mockGet).not.toHaveBeenCalled();
});
