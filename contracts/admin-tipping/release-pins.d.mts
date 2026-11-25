/** Types only. Byte identities are defined solely by release-pins.mjs. */
export interface AdminTippingReleasePins {
  readonly releaseId: string;
  readonly protocolTypeHash: `0x${string}`;
  readonly registryTypeHash: `0x${string}`;
  readonly dataHashes: Readonly<{tippingType: `0x${string}`; fundingLock: `0x${string}`; protocolLock: `0x${string}`}>
  readonly byteLengths: Readonly<{tippingType: number; fundingLock: number; protocolLock: number}>;
}
export const ADMIN_TIPPING_RELEASE: AdminTippingReleasePins;
