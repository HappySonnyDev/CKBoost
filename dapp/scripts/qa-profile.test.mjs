import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import * as runtime from '../lib/ckb/isolated-runtime.mjs';
import {QA_BASE_PROFILE,QA_DEFAULT_PROFILE,QA_BASE_PROFILE_HASH,QA_PROFILE_PROTOCOL_HASH,QA_PROFILE_FILES,validateQaProfileDescriptor,validateQaPublishedRuntime} from './qa-profile.mjs';
const require=createRequire(import.meta.url),{loadPureTs,dapp}=require('./public-product-ts.cjs');
const baseFile=new URL('../config/qa/ckboost-testnet.json',import.meta.url);
const baseText=await fs.readFile(baseFile,'utf8'),base=JSON.parse(baseText);
// Negative cases below use explicitly synthetic inclusion/live metadata.
// These tests never create or replace a public release artifact.
const {adminRuntimeFixture}=loadPureTs(path.join(dapp,'lib/revamp/__tests__/admin-runtime-fixtures.ts'));
function future(){const f=adminRuntimeFixture(),config=runtime.makeAdminUpgradedIsolatedRuntimeConfig(f.base,f.bundle);return {config,descriptor:{schema:'ckboost-qa-profile-descriptor/v1',file:QA_PROFILE_FILES.v4,runtimeSchema:'ckboost-isolated-testnet-runtime/v4',profileHash:config.profileHash,protocolTypeHash:QA_PROFILE_PROTOCOL_HASH,parentProfileHash:QA_BASE_PROFILE_HASH}};}
test('published real v4 reconstructs offline and preserves the immutable v3 base',async()=>{
 assert.equal(QA_BASE_PROFILE.file,'config/qa/ckboost-testnet.json');assert.equal(validateQaPublishedRuntime(QA_BASE_PROFILE,base,runtime).profileHash,QA_BASE_PROFILE_HASH);assert(Object.isFrozen(QA_BASE_PROFILE));assert.equal(await fs.readFile(baseFile,'utf8'),baseText);
 const publishedText=await fs.readFile(new URL(`../${QA_DEFAULT_PROFILE.file}`,import.meta.url),'utf8'),published=JSON.parse(publishedText);
 const oldFetch=globalThis.fetch;globalThis.fetch=()=>{throw Error('Publication validation must be offline.');};
 try{const config=validateQaPublishedRuntime(QA_DEFAULT_PROFILE,published,runtime);assert.equal(config.profileHash,'0x4faf44b759bbcd6218fdb86acb3a27b28c1d41a867c21a60d0b169745563ee06');assert.equal(config.sources.adminUpgradeBundle.protocolUpdate.transactionHash,'0xbdf4775f72c4238db2d7d300abd92aef8ac7b5147caaed2fa51367fb769a8454');assert.equal(config.sources.adminParentProfileHash,QA_BASE_PROFILE_HASH);assert.deepEqual(published,config);assert.deepEqual(config.sources.protocolManifest,base.sources.protocolManifest);}finally{globalThis.fetch=oldFetch;}
 assert(!/\/(?:Users|home|private|tmp)\//.test(publishedText));assert(!/"(?:privateKey|mnemonic|password|secret|apiKey)"\s*:/i.test(publishedText));assert.equal(await fs.readFile(baseFile,'utf8'),baseText);
});
test('strict descriptor validates synthetic v4 provenance entirely offline',()=>{
 const f=future(),oldFetch=globalThis.fetch;globalThis.fetch=()=>{throw Error('Offline profile validation must never contact the chain.');};
 try{const selected=validateQaProfileDescriptor(f.descriptor),config=validateQaPublishedRuntime(selected,f.config,runtime);assert.equal(config.sources.adminParentProfileHash,QA_BASE_PROFILE_HASH);assert.equal(config.protocol.typeHash,QA_PROFILE_PROTOCOL_HASH);assert.equal(config.adminRegistry.typeScript.codeHash,'0x12a5aa7950a17c8b11d28fdffad7c7cdf699811291437ad87826b422392e39d5');assert(Object.isFrozen(selected));}finally{globalThis.fetch=oldFetch;}
});
test('arbitrary paths, schema, scope, ancestor and descriptor overrides are rejected',()=>{
 const f=future();for(const changes of [{file:'../production.json'},{file:'/tmp/profile.json'},{file:'config/qa/ckboost-testnet.json'},{runtimeSchema:'ckboost-isolated-testnet-runtime/v3'},{protocolTypeHash:`0x${'11'.repeat(32)}`},{parentProfileHash:`0x${'22'.repeat(32)}`},{profileHash:'0x00'},{rpcUrl:'https://elsewhere.invalid/'},{file:'config\\qa\\ckboost-testnet-admin-v4.json'}])assert.throws(()=>validateQaProfileDescriptor({...f.descriptor,...changes}),/Published QA profile/);
});
test('wrong or missing v4 runtime cannot fall back to a valid ancestral v3',()=>{
 const f=future();assert.throws(()=>validateQaPublishedRuntime(f.descriptor,base,runtime),/no fallback/);assert.throws(()=>validateQaPublishedRuntime(f.descriptor,null,runtime));assert.throws(()=>validateQaPublishedRuntime({...f.descriptor,profileHash:`0x${'33'.repeat(32)}`},f.config,runtime),/no fallback/);
 const tampered=JSON.parse(JSON.stringify(f.config));tampered.current.testnet.ckboostUserType.typeHash=`0x${'44'.repeat(32)}`;assert.throws(()=>validateQaPublishedRuntime(f.descriptor,tampered,runtime),/changed/);
});
test('startup validation does not repeat initial Registry liveness while immutable creation evidence remains intact',()=>{
 const f=future(),before=JSON.stringify(f.config.sources.protocolManifest),env=runtime.isolatedRuntimeEnvironment(validateQaPublishedRuntime(f.descriptor,f.config,runtime));
 // No network hook or creation-outpoint resolver is part of normal startup.
 assert.equal(JSON.parse(env.NEXT_PUBLIC_CKBOOST_ADMIN_REGISTRY).stateCreation.transactionHash,'0xc8113a4525db462182e5260387bb8b392b0c084a8bb2e3eef30f7a48be83ea39');assert.deepEqual(runtime.getIsolatedRuntime(env),f.config);assert.equal(JSON.stringify(f.config.sources.protocolManifest),before);
});
