/** Reviewed byte identities for the isolated QA candidate release.
 * These are NOT deployment/confirmation claims. Runtime activation additionally
 * requires confirmed fresh code, pinned Registry state and protocol readback. */
export const ADMIN_TIPPING_RELEASE = Object.freeze({
  releaseId: "ckboost-admin-tipping-v1-registry-97e23b14",
  protocolTypeHash: "0x4eacaf9b1a120d2bfd99f26fcedfdcfe6ef116484e9b478b0a104a872316e034",
  registryTypeHash: "0x97e23b14d33e0445c1eac09f1948e2c3652547bfbb7fb7db56978f48baff9690",
  dataHashes: Object.freeze({
    tippingType: "0x82dfcecb9d7e2ed2c0407a92fbdb0fc793875b747b05510711a9f4d5ef4f7049",
    fundingLock: "0x62a328ce7a7d0ff273d7696c4bdc43254dd1cb611fdf94fbc2ec3c71f16cc389",
    protocolLock: "0xab9aef1ecc866c6d2cca7957b95930fdc4ec11212279796f49517d65db13b649",
  }),
  byteLengths: Object.freeze({tippingType: 162600, fundingLock: 107184, protocolLock: 214056}),
});
