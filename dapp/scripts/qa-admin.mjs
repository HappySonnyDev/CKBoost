#!/usr/bin/env node
// Optional release confirmation/local selection, separate from the published
// `qa` default. No wallet/provider/sign/send/estimate operation.
import {promises as fs,constants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const APP=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const assert=(ok,message)=>{if(!ok)throw Error(message);};
const json=value=>`${JSON.stringify(value,null,2)}\n`;
const usage='Usage:\n  node scripts/qa-admin.mjs confirm --financial-tx 0x<hash> --protocol-tx 0x<hash>\n  node scripts/qa-admin.mjs activate 0x<confirmed-profile-hash>\n  node scripts/qa-admin.mjs plan|check|build|start\nConfirmation and local selection never sign, broadcast, estimate scripts or restart services. Neither the immutable v3 base nor the published qa default is changed. Ordinary pnpm qa needs no activation.';
export function parseAdminArguments(argv){
  if(argv.length===5&&argv[0]==='confirm'&&argv[1]==='--financial-tx'&&argv[3]==='--protocol-tx'&&[argv[2],argv[4]].every(v=>/^0x[0-9a-f]{64}$/i.test(v)))return {action:'confirm',financialHash:argv[2].toLowerCase(),protocolHash:argv[4].toLowerCase()};
  if(argv.length===2&&argv[0]==='activate'&&/^0x[0-9a-f]{64}$/i.test(argv[1]))return {action:'activate',profileHash:argv[1].toLowerCase()};
  if(argv.length===1&&['plan','check','build','start','next','help','--help'].includes(argv[0]))return {action:argv[0]};
  if(argv.length===0)return {action:'help'};
  throw Error(usage);
}
export async function selectConfirmedAdminProfile(profileHash,{dappDirectory=APP,confirmFresh}={}){
  assert(typeof profileHash==='string'&&/^0x[0-9a-f]{64}$/.test(profileHash),'Only a complete confirmed profile hash may select a local v4 path.');
  const {validateIsolatedRuntimeConfig}=await import('../lib/ckb/isolated-runtime.mjs');
  const file=path.join(dappDirectory,'.qa-local/admin-upgrade/confirmed',profileHash.slice(2),'runtime-config.json');
  const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);let saved;
  try{const info=await handle.stat();assert(info.isFile()&&info.size>0&&info.size<=200000,'Invalid bounded confirmed runtime file.');saved=validateIsolatedRuntimeConfig(JSON.parse(await handle.readFile('utf8')));}finally{await handle.close();}
  assert(saved.schema==='ckboost-isolated-testnet-runtime/v4'&&saved.profileHash===profileHash,'Only this exact independently confirmed v4 profile may be selected.');
  const bundle=saved.sources.adminUpgradeBundle;
  const {confirmAdminUpgradeFromChain,createAdminPublicRpc}=await import('./qa-admin-confirm.mjs');
  const fresh=await (confirmFresh??confirmAdminUpgradeFromChain)({financialHash:bundle.financial.protocolLock.transactionHash,protocolHash:bundle.protocolUpdate.transactionHash,rpc:createAdminPublicRpc()});
  assert(JSON.stringify(fresh.config)===JSON.stringify(saved),'Current chain proof differs from this saved v4 profile. Run confirmation again; no profile was selected.');
  const directory=path.join(dappDirectory,'.qa-local/admin-upgrade');await fs.mkdir(directory,{recursive:true,mode:0o700});
  const real=await fs.realpath(directory),root=await fs.realpath(dappDirectory);assert(real.startsWith(`${root}${path.sep}`),'Local selection must remain inside this checkout.');
  const target=path.join(directory,'active-runtime.json');
  try{const stat=await fs.lstat(target);assert(stat.isFile()&&!stat.isSymbolicLink(),'Refuse an unexpected existing local profile selection.');}catch(error){if(error.code!=='ENOENT')throw error;}
  const temporary=path.join(directory,`active-runtime-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);await fs.writeFile(temporary,json(saved),{flag:'wx',mode:0o600});await fs.rename(temporary,target);
  return {selectedLocalProfile:true,profileHash,profileFile:target,baseV3Unchanged:true,publishedDefaultUnchanged:true,processesStarted:false,didSign:false,didBroadcast:false,message:'Local v4 selection is recorded. Run qa-admin build, then qa-admin start explicitly. No running service was changed.'};
}
export async function main(argv=process.argv.slice(2)){
  const args=parseAdminArguments(argv);let result;
  if(['help','--help'].includes(args.action)){console.log(usage);return {help:true};}
  if(args.action==='confirm'){const {writeAdminConfirmation}=await import('./qa-admin-confirm.mjs');result=await writeAdminConfirmation(args);if(result.status!=='confirmed')process.exitCode=1;}
  else if(args.action==='activate')result=await selectConfirmedAdminProfile(args.profileHash);
  else {const {createQaLauncher}=await import('./qa.mjs');const launcher=createQaLauncher({adminProfile:true});const value=await launcher[args.action]();result=args.action==='plan'?value.summary:value;}
  console.log(json(result));return result;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main().catch(error=>{console.error(error.message);process.exitCode=1;});
