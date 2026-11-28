jest.mock("@ckb-ccc/connector-react", () => ({
  KnownScript: { Secp256k1Blake160: "Secp256k1Blake160" },
  ccc: {
    stringify: JSON.stringify,
    hexFrom: (value: string) => value,
    CellOutput: { from: jest.fn() },
  },
}));

jest.mock(
  "../../../packages/ssri-ckboost/dist",
  () => ({
    createScopedLogger: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      log: jest.fn(),
    }),
  })
);

jest.mock("@/lib/pending-transactions", () => ({
  registerPendingTransaction: jest.fn(),
}));

import { sendTransactionWithFeeRetry } from "./transaction-wrapper";

it("blocks a preserved output whose final 76-byte lock needs more capacity before requesting a wallet signature",async()=>{
  const real=jest.requireActual("@ckb-ccc/core"),{ccc}=jest.requireMock("@ckb-ccc/connector-react");
  // Match connector CCC 1.12: an explicitly provided capacity is retained.
  ccc.CellOutput.from.mockImplementation((value:{capacity?:bigint;lock:unknown;type?:unknown},data:string)=>({...value,capacity:value.capacity??real.CellOutput.from(value,data).capacity}));
  const script={codeHash:`0x${"11".repeat(32)}`,hashType:"type",args:`0x${"00".repeat(76)}`};
  const tx={outputs:[{capacity:57600000000n,lock:script,type:script}],outputsData:[`0x${"00".repeat(404)}`],inputs:[],witnesses:[],addCellDepsOfKnownScripts:jest.fn().mockResolvedValue(undefined),completeInputsByCapacity:jest.fn().mockResolvedValue(undefined),completeFeeBy:jest.fn().mockResolvedValue(undefined),copy:jest.fn(),clone:jest.fn(),toBytes:jest.fn(()=>new Uint8Array(1000))};
  tx.clone.mockReturnValue(tx);
  const signer={client:{getFeeRate:jest.fn().mockResolvedValue(1000)},getRecommendedAddressObj:jest.fn().mockResolvedValue({script:{codeHash:"0x1",hashType:"type",args:"0x2"}}),prepareTransaction:jest.fn(async value=>value),sendTransaction:jest.fn()};
  await expect(sendTransactionWithFeeRetry(signer as never,tx as never,{allowFeeRetry:false,preserveOutputCapacityIndices:new Set([0])})).rejects.toThrow(/57600000000 shannons provided, 63000000000 required/);
  expect(signer.sendTransaction).not.toHaveBeenCalled();expect(tx.outputs[0].capacity).toBe(57600000000n);
  ccc.CellOutput.from.mockReset();
});

it("keeps reviewed Admin submissions to one wallet prompt even for a fee rejection",async()=>{
  const tx={outputs:[],outputsData:[],inputs:[],witnesses:[],addCellDepsOfKnownScripts:jest.fn().mockResolvedValue(undefined),completeInputsByCapacity:jest.fn().mockResolvedValue(undefined),completeFeeBy:jest.fn().mockResolvedValue(undefined),copy:jest.fn(),clone:jest.fn(),toBytes:jest.fn(()=>new Uint8Array(1000))};tx.clone.mockReturnValue(tx);
  const signer={client:{getFeeRate:jest.fn().mockResolvedValue(1000)},getRecommendedAddressObj:jest.fn().mockResolvedValue({script:{codeHash:"0x1",hashType:"type",args:"0x2"}}),prepareTransaction:jest.fn(async value=>value),sendTransaction:jest.fn().mockRejectedValue(new Error("PoolRejectedTransactionByMinFeeRate: requiring a transaction fee of at least 2715 shannons"))};
  await expect(sendTransactionWithFeeRetry(signer as never,tx as never,{allowFeeRetry:false})).rejects.toThrow(/after 1 attempts/);
  expect(signer.sendTransaction).toHaveBeenCalledTimes(1);expect(tx.completeFeeBy).toHaveBeenCalledTimes(1);
});

it("keeps an exact corrected fee rate across the 2 KB boundary", async () => {
  const tx = {
    outputs: [],
    outputsData: [],
    inputs: [],
    witnesses: [],
    addCellDepsOfKnownScripts: jest.fn().mockResolvedValue(undefined),
    completeInputsByCapacity: jest.fn().mockResolvedValue(undefined),
    completeFeeBy: jest.fn().mockResolvedValue(undefined),
    copy: jest.fn(),
    clone: jest.fn(),
    // This reproduces issue #63: rounding 2049 bytes up to 3 KW made the old
    // calculation return the unchanged 1000 shannons/KW rate.
    toBytes: jest.fn(() => new Uint8Array(2049)),
  };
  tx.clone.mockReturnValue(tx);

  const signer = {
    client: {
      getFeeRate: jest.fn().mockRejectedValue(new Error("null fee estimate")),
    },
    getRecommendedAddressObj: jest.fn().mockResolvedValue({
      script: { codeHash: "0x1", hashType: "type", args: "0x2" },
    }),
    prepareTransaction: jest.fn().mockImplementation(async (value) => value),
    sendTransaction: jest
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "PoolRejectedTransactionByMinFeeRate: requiring a transaction fee of at least 2715 shannons"
        )
      )
      .mockResolvedValueOnce("0xabc"),
  };

  await expect(
    sendTransactionWithFeeRetry(signer as never, tx as never)
  ).resolves.toBe("0xabc");

  expect(tx.completeFeeBy.mock.calls.map(([, feeRate]) => feeRate)).toEqual([
    1000,
    1456,
    1456,
  ]);
  expect(signer.sendTransaction).toHaveBeenCalledTimes(2);
});

it("reports the last required fee without rebuilding after the final attempt", async () => {
  const tx = {
    outputs: [],
    outputsData: [],
    inputs: [],
    witnesses: [],
    addCellDepsOfKnownScripts: jest.fn().mockResolvedValue(undefined),
    completeInputsByCapacity: jest.fn().mockResolvedValue(undefined),
    completeFeeBy: jest.fn().mockResolvedValue(undefined),
    copy: jest.fn(),
    clone: jest.fn(),
    toBytes: jest.fn(() => new Uint8Array(2049)),
  };
  tx.clone.mockReturnValue(tx);

  const signer = {
    client: {
      getFeeRate: jest.fn().mockResolvedValue(1000),
    },
    getRecommendedAddressObj: jest.fn().mockResolvedValue({
      script: { codeHash: "0x1", hashType: "type", args: "0x2" },
    }),
    prepareTransaction: jest.fn().mockImplementation(async (value) => value),
    sendTransaction: jest.fn().mockRejectedValue(
      new Error(
        "PoolRejectedTransactionByMinFeeRate: requiring a transaction fee of at least 2715 shannons"
      )
    ),
  };

  await expect(
    sendTransactionWithFeeRetry(signer as never, tx as never)
  ).rejects.toThrow(
    "Transaction fee adjustment failed after 3 attempts. The node required a fee of at least 2715 shannons."
  );

  expect(signer.sendTransaction).toHaveBeenCalledTimes(3);
  expect(tx.completeFeeBy).toHaveBeenCalledTimes(5);
});

it("copies wallet preparation into the transaction before the initial fee is completed", async () => {
  let walletPreparationApplied = false;
  const preparedTx = { walletPrepared: true };
  const tx = {
    outputs: [],
    outputsData: [],
    inputs: [],
    witnesses: [],
    addCellDepsOfKnownScripts: jest.fn().mockResolvedValue(undefined),
    completeInputsByCapacity: jest.fn().mockResolvedValue(undefined),
    completeFeeBy: jest.fn().mockImplementation(async () => {
      expect(walletPreparationApplied).toBe(true);
    }),
    copy: jest.fn().mockImplementation((value) => {
      expect(value).toBe(preparedTx);
      walletPreparationApplied = true;
    }),
    clone: jest.fn(),
    toBytes: jest.fn(() => new Uint8Array(1000)),
  };
  tx.clone.mockReturnValue(tx);

  const signer = {
    client: {
      getFeeRate: jest.fn().mockResolvedValue(1000),
    },
    getRecommendedAddressObj: jest.fn().mockResolvedValue({
      script: { codeHash: "0x1", hashType: "type", args: "0x2" },
    }),
    prepareTransaction: jest.fn().mockResolvedValue(preparedTx),
    sendTransaction: jest.fn().mockResolvedValue("0xprepared"),
  };

  await expect(
    sendTransactionWithFeeRetry(signer as never, tx as never)
  ).resolves.toBe("0xprepared");

  expect(signer.prepareTransaction).toHaveBeenCalledWith(tx);
  expect(tx.copy).toHaveBeenCalledWith(preparedTx);
  expect(signer.sendTransaction).toHaveBeenCalledTimes(1);
});
