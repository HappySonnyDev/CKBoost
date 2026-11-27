// Source-reviewed public releases. No file/environment reads, network requests
// or process changes occur when selecting this immutable descriptor.
export const QA_BASE_PROFILE_HASH='0x129cd99c43113ab92b4ec5331693c402dd1f40b9269fff6c223ad4d3c201b297';
export const QA_PROFILE_PROTOCOL_HASH='0x4eacaf9b1a120d2bfd99f26fcedfdcfe6ef116484e9b478b0a104a872316e034';
export const QA_PROFILE_FILES=Object.freeze({
  v3:'config/qa/ckboost-testnet.json',
  v4:'config/qa/ckboost-testnet-admin-v4.json',
});
const assert=(ok,message)=>{if(!ok)throw Error(`Published QA profile: ${message}`);};
export function validateQaProfileDescriptor(value){
  assert(value&&typeof value==='object'&&!Array.isArray(value),'a reviewed descriptor is required');
  const keys=['schema','file','runtimeSchema','profileHash','protocolTypeHash','parentProfileHash'];
  assert(Object.keys(value).every(key=>keys.includes(key))&&value.schema==='ckboost-qa-profile-descriptor/v1','unsupported descriptor fields/version');
  assert(value.protocolTypeHash===QA_PROFILE_PROTOCOL_HASH,'only the exact independent QA protocol is allowed');
  assert(typeof value.profileHash==='string'&&/^0x[0-9a-f]{64}$/.test(value.profileHash)&&!/^0x0{64}$/.test(value.profileHash),'a complete reviewed profile hash is required');
  const v3=value.runtimeSchema==='ckboost-isolated-testnet-runtime/v3';
  if(v3)assert(value.file===QA_PROFILE_FILES.v3&&value.profileHash===QA_BASE_PROFILE_HASH&&value.parentProfileHash===undefined,'the immutable v3 base descriptor changed');
  else assert(value.runtimeSchema==='ckboost-isolated-testnet-runtime/v4'&&value.file===QA_PROFILE_FILES.v4&&value.parentProfileHash===QA_BASE_PROFILE_HASH&&value.profileHash!==QA_BASE_PROFILE_HASH,'only the confirmed v4 file with the exact v3 parent may be published');
  return Object.freeze({schema:'ckboost-qa-profile-descriptor/v1',file:value.file,runtimeSchema:value.runtimeSchema,profileHash:value.profileHash,protocolTypeHash:QA_PROFILE_PROTOCOL_HASH,...(v3?{}:{parentProfileHash:QA_BASE_PROFILE_HASH})});
}
export const QA_BASE_PROFILE=validateQaProfileDescriptor({
  schema:'ckboost-qa-profile-descriptor/v1',file:QA_PROFILE_FILES.v3,
  runtimeSchema:'ckboost-isolated-testnet-runtime/v3',profileHash:QA_BASE_PROFILE_HASH,
  protocolTypeHash:QA_PROFILE_PROTOCOL_HASH,
});
// Published only after the canonical release transactions, live outputs and
// empty previous financial namespaces were independently confirmed.
export const QA_DEFAULT_PROFILE=validateQaProfileDescriptor({
  schema:'ckboost-qa-profile-descriptor/v1',file:QA_PROFILE_FILES.v4,
  runtimeSchema:'ckboost-isolated-testnet-runtime/v4',
  profileHash:'0x4faf44b759bbcd6218fdb86acb3a27b28c1d41a867c21a60d0b169745563ee06',
  protocolTypeHash:QA_PROFILE_PROTOCOL_HASH,parentProfileHash:QA_BASE_PROFILE_HASH,
});
/** Runtime provenance/pins are always reconstructed by the real validator.
 * Release confirmation is historical evidence. Mutable Registry/Protocol cells
 * need not remain at their creation outpoints for a normal offline startup;
 * the business readers independently prove current identities and authority.
 */
export function validateQaPublishedRuntime(descriptor,value,runtime){
  const selected=validateQaProfileDescriptor(descriptor);
  assert(runtime&&typeof runtime.validateIsolatedRuntimeConfig==='function','the strict runtime validator is required');
  const config=runtime.validateIsolatedRuntimeConfig(value);
  assert(config.schema===selected.runtimeSchema&&config.network==='testnet'&&config.profileHash===selected.profileHash&&config.protocol.typeHash===selected.protocolTypeHash,'runtime schema/hash/protocol differs from the reviewed descriptor; no fallback is allowed');
  if(selected.runtimeSchema==='ckboost-isolated-testnet-runtime/v4')assert(config.sources.adminParentProfileHash===QA_BASE_PROFILE_HASH&&config.adminRegistry?.protocolTypeHash===QA_PROFILE_PROTOCOL_HASH&&config.adminTipping?.protocolTypeHash===QA_PROFILE_PROTOCOL_HASH,'confirmed Admin provenance/capability scope is missing');
  return config;
}
