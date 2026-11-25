import {ADMIN_TIPPING_RELEASE} from "../../../contracts/admin-tipping/release-pins.mjs";
/** Exact candidate byte identities. Availability still requires current live
 * code, the full Registry identity and the matching QA protocol configuration;
 * these source pins alone never assert a deployment or enable a write. */
export interface AdminTipReleasePin {
  releaseId:string;protocolTypeHash:string;registryTypeHash:string;
  dataHashes:{tippingType:string;fundingLock:string;protocolLock:string};
}
export const ADMIN_TIP_RELEASE_PINS:readonly AdminTipReleasePin[]=Object.freeze([ADMIN_TIPPING_RELEASE]);
