import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {parseAdminArguments,selectConfirmedAdminProfile} from './qa-admin.mjs';
import {createAdminPublicRpc,confirmAdminUpgradeFromChain,writeAdminConfirmation,ADMIN_CONFIRM_ENDPOINT} from './qa-admin-confirm.mjs';
import {createQaLauncher,qaPaths} from './qa.mjs';
import * as runtime from '../lib/ckb/isolated-runtime.mjs';
const require=createRequire(import.meta.url),{loadPureTs,dapp}=require('./public-product-ts.cjs');
const {adminRuntimeFixture}=loadPureTs(path.join(dapp,'lib/revamp/__tests__/admin-runtime-fixtures.ts'));
const h=n=>`0x${n.repeat(64)}`;
async function directory(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'ckboost-admin-qa-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
function syntheticProfile(){const f=adminRuntimeFixture();return {base:f.base,config:runtime.makeAdminUpgradedIsolatedRuntimeConfig(f.base,f.bundle)};}

test('command parser accepts only explicit fixed actions and rejects endpoint/profile/path overrides',()=>{
 assert.deepEqual(parseAdminArguments(['confirm','--financial-tx',h('1'),'--protocol-tx',h('2')]),{action:'confirm',financialHash:h('1'),protocolHash:h('2')});
 assert.deepEqual(parseAdminArguments(['activate',h('3')]),{action:'activate',profileHash:h('3')});
 for(const args of [['confirm','--rpc','https://evil.invalid'],['activate','../../production'],['start','--profile','old.json'],['confirm','--financial-tx',h('1'),'--protocol-tx',h('2'),'--send']])assert.throws(()=>parseAdminArguments(args),/Usage/);
});
test('RPC has one fixed HTTPS endpoint, rejects signing/send/estimate, and globally bounds concurrency to four',async()=>{
 let active=0,peak=0;const urls=[],network=[];
 const rpc=createAdminPublicRpc({network,fetcher:async(url,init)=>{urls.push(url);const body=JSON.parse(init.body);active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,2));active--;return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result:{ok:true}}));}});
 for(const method of ['send_transaction','estimate_cycles','dry_run_transaction','sign'])await assert.rejects(rpc(method,[]),/forbidden/);
 await Promise.all(Array.from({length:12},()=>rpc('get_header',[h('1')])));assert.equal(peak,4);assert(urls.every(v=>v===ADMIN_CONFIRM_ENDPOINT));assert.equal(network.length,12);assert(network.every(v=>v.status==='read'));
});
test('mismatched RPC ids and an expired budget do not become confirmation evidence',async()=>{
 const rpc=createAdminPublicRpc({fetcher:async()=>new Response(JSON.stringify({jsonrpc:'2.0',id:999,result:{}}))});await assert.rejects(rpc('get_transaction',[h('1')]),/Mismatched/);
 const expired=createAdminPublicRpc({deadline:Date.now()-1,fetcher:()=>{throw Error('must not fetch');}});await assert.rejects(expired('get_cells',[]),/budget ended/);
});
test('pending/unrelated actual transactions cannot be promoted by a supplied confirmed label',async()=>{
 const pending=async()=>({tx_status:{status:'pending'},transaction:null,status:'confirmed'});
 await assert.rejects(confirmAdminUpgradeFromChain({financialHash:h('1'),protocolHash:h('2'),rpc:pending}),/not committed/);
 const {ccc,cccA}=require('./public-product-ts.cjs'),tx=ccc.Transaction.from({outputs:[{capacity:10000000000n,lock:{codeHash:h('3'),hashType:'type',args:'0x'}}],outputsData:['0x']});
 await assert.rejects(confirmAdminUpgradeFromChain({financialHash:h('1'),protocolHash:h('2'),rpc:async()=>({tx_status:{status:'committed',block_number:'0x1'},transaction:cccA.JsonRpcTransformers.transactionFrom(tx)})}),/raw transaction hash mismatch/);
});
test('a failed public round writes only an unverified audit; no bundle or v4 profile appears',async t=>{
 const root=await directory(t),fetcher=async(_url,init)=>{const body=JSON.parse(init.body);return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result:{tx_status:{status:'pending'},transaction:null}}));};
 const result=await writeAdminConfirmation({financialHash:h('1'),protocolHash:h('2'),dappDirectory:root,fetcher});assert.equal(result.status,'unverified');const audit=JSON.parse(await fs.readFile(result.auditFile,'utf8'));assert.equal(audit.didSign,false);assert.equal(audit.didBroadcast,false);assert.equal(audit.didActivate,false);await assert.rejects(fs.stat(path.join(root,'.qa-local/admin-upgrade/confirmed')),{code:'ENOENT'});
});
test('explicit local selection rechecks chain before writing and leaves the default profile untouched',async t=>{
 const root=await directory(t),{base,config}=syntheticProfile(),target=path.join(root,'.qa-local/admin-upgrade/confirmed',config.profileHash.slice(2));await fs.mkdir(target,{recursive:true});await fs.writeFile(path.join(target,'runtime-config.json'),JSON.stringify(config));await fs.mkdir(path.join(root,'config/qa'),{recursive:true});const defaultFile=path.join(root,'config/qa/ckboost-testnet.json');await fs.writeFile(defaultFile,JSON.stringify(base));
 let checks=0;const result=await selectConfirmedAdminProfile(config.profileHash,{dappDirectory:root,confirmFresh:async args=>{checks++;assert.equal(args.financialHash,config.sources.adminUpgradeBundle.financial.protocolLock.transactionHash);return {config};}});
 assert.equal(checks,1);assert.equal(result.processesStarted,false);assert.equal(result.defaultV3Unchanged,true);assert.deepEqual(JSON.parse(await fs.readFile(defaultFile,'utf8')),base);assert.deepEqual(JSON.parse(await fs.readFile(result.profileFile,'utf8')),config);
});
test('failed fresh proof and symlinked selection cannot activate a local profile',async t=>{
 const root=await directory(t),{config}=syntheticProfile(),dir=path.join(root,'.qa-local/admin-upgrade'),target=path.join(dir,'confirmed',config.profileHash.slice(2));await fs.mkdir(target,{recursive:true});await fs.writeFile(path.join(target,'runtime-config.json'),JSON.stringify(config));
 await assert.rejects(selectConfirmedAdminProfile(config.profileHash,{dappDirectory:root,confirmFresh:async()=>{throw Error('Code no longer live');}}),/no longer live/);await assert.rejects(fs.stat(path.join(dir,'active-runtime.json')),{code:'ENOENT'});
 const elsewhere=path.join(root,'untouched.json');await fs.writeFile(elsewhere,'untouched');await fs.symlink(elsewhere,path.join(dir,'active-runtime.json'));await assert.rejects(selectConfirmedAdminProfile(config.profileHash,{dappDirectory:root,confirmFresh:async()=>({config})}),/unexpected existing/);assert.equal(await fs.readFile(elsewhere,'utf8'),'untouched');
});
test('Admin launcher has no v3 fallback, creates separate paths and preserves identical build/start environment',async t=>{
 const root=await directory(t),{base,config}=syntheticProfile(),app=path.join(root,"another user's checkout",'dapp'),paths=qaPaths(app),deps=[paths.next,path.join(app,'../packages/ssri-ckboost/dist/index.js'),path.join(app,'../packages/ssri-ckboost/dist/generated/ckboost.js'),path.join(app,'../packages/ssri-ckboost/dist/logging/index.js'),path.join(app,'node_modules/ckb-claimable-pool-lock/dist/index.js'),path.join(app,'public/tinymce/tinymce.min.js')];
 await Promise.all(deps.map(async file=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'// dependency fixture');}));await fs.mkdir(paths.functions,{recursive:true});await fs.mkdir(path.dirname(paths.profile),{recursive:true});await fs.writeFile(paths.profile,JSON.stringify(base));
 const calls=[],launcher=createQaLauncher({dappDirectory:app,adminProfile:true,runtimeLoader:async()=>runtime,nodeVersion:'22.19.0',nodeExecutable:'/node',ssriReady:async()=>{},freePort:async()=>{},runner:async(command,args,cwd,env)=>{calls.push({command,args,cwd,env});if(args[1]==='build'){await fs.mkdir(launcher.paths.dist,{recursive:true});await fs.writeFile(path.join(launcher.paths.dist,'BUILD_ID'),'synthetic-build');}}});
 await assert.rejects(launcher.plan(),/No explicitly selected/);const selected=path.join(app,'.qa-local/admin-upgrade/active-runtime.json');await fs.mkdir(path.dirname(selected),{recursive:true});await fs.writeFile(selected,JSON.stringify(base));await assert.rejects(launcher.plan(),/confirmed Admin v4/);await fs.writeFile(selected,JSON.stringify(config));const plan=await launcher.plan();assert.equal(plan.config.profileHash,config.profileHash);assert.notEqual(plan.paths.local,paths.local);assert.match(plan.toml,/qa-admin\.mjs next/);assert.equal(calls.length,0);
 await launcher.build();await launcher.start();assert.equal(calls.length,2);assert.deepEqual(calls[0].env,calls[1].env);assert.equal(JSON.parse(calls[1].env.NEXT_PUBLIC_CKBOOST_ADMIN_TIPPING).registryTypeHash,'0x97e23b14d33e0445c1eac09f1948e2c3652547bfbb7fb7db56978f48baff9690');assert.deepEqual(JSON.parse(await fs.readFile(paths.profile,'utf8')),base);
});
