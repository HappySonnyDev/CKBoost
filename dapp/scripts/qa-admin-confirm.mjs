// Full public-chain confirmation for the explicit QA Admin release. All writes
// are local public audit artifacts. No Signer/provider/sign/send/estimate API.
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';

export const ADMIN_CONFIRM_ENDPOINT='https://testnet.ckbapp.dev/';
const APP=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const allowed=new Set(['get_transaction','get_live_cell','get_header','get_cells','get_indexer_tip']);
const assert=(ok,message)=>{if(!ok)throw Error(message);};
const hash=v=>{assert(typeof v==='string'&&/^0x[a-f0-9]{64}$/i.test(v),'A complete public transaction hash is required.');return v.toLowerCase();};
const json=v=>`${JSON.stringify(v,null,2)}\n`;
const canonical=v=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`:JSON.stringify(v);

export function createAdminPublicRpc({fetcher=fetch,deadline=Date.now()+30000,network=[]}={}){
  let requestId=0,active=0;const queue=[];
  return async(method,params)=>{
    assert(allowed.has(method),'Only fixed public get_* methods are allowed; signing, broadcasting and script estimation are forbidden.');assert(Date.now()<deadline&&requestId<80,'The 30-second public confirmation budget ended.');
    await new Promise(resolve=>{if(active<4){active++;resolve();}else queue.push(resolve);});
    if(Date.now()>=deadline){const next=queue.shift();if(next)next();else active--;throw Error('The 30-second public confirmation budget ended.');}
    const id=++requestId,row={method,params,startedAt:new Date().toISOString()};network.push(row);
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.min(10000,Math.max(1,deadline-Date.now())));
    try{const response=await fetcher(ADMIN_CONFIRM_ENDPOINT,{method:'POST',headers:{'content-type':'application/json'},cache:'no-store',redirect:'error',signal:controller.signal,body:JSON.stringify({jsonrpc:'2.0',id,method,params})});assert(response.ok,'The fixed public Testnet read failed.');const body=await response.text();assert(body.length<4000000,'The public RPC response exceeds its bounded size.');const value=JSON.parse(body);assert(value.jsonrpc==='2.0'&&value.id===id,'Mismatched public RPC response.');if(value.error){const error=Error(`Read RPC ${value.error.code}: ${value.error.message}`);error.rpcCode=value.error.code;throw error;}assert(Object.hasOwn(value,'result'),'Missing matching public RPC result.');row.status='read';row.result=value.result;return value.result;}catch(error){row.status='failed';row.error=error.message;throw error;}finally{clearTimeout(timer);const next=queue.shift();if(next)next();else active--;}
  };
}
async function dependencies(){
  const require=createRequire(import.meta.url),product=require('./public-product-ts.cjs');
  const [runtime,{ADMIN_TIPPING_RELEASE:pin}]=await Promise.all([import('../lib/ckb/isolated-runtime.mjs'),import('../../contracts/admin-tipping/release-pins.mjs')]);
  const codec=product.appRequire(path.join(APP,'../packages/ssri-ckboost/dist/generated/ckboost.js'));
  return {...product,runtime,pin,codec,financial:product.loadPureTs(path.join(APP,'lib/revamp/testnet-admin-financial-upgrade.ts')),operator:product.loadPureTs(path.join(APP,'lib/revamp/testnet-admin-upgrade.ts'))};
}
async function parallel(items,fn){let next=0;const values=Array(items.length),errors=[];await Promise.all(Array.from({length:Math.min(4,items.length)},async()=>{while(next<items.length){const i=next++;try{values[i]=await fn(items[i],i);}catch(error){errors.push(error);}}}));if(errors.length)throw errors[0];return values;}
export async function confirmAdminUpgradeFromChain({financialHash,protocolHash,rpc,baseProfile,dependencies:provided}={}){
  financialHash=hash(financialHash);protocolHash=hash(protocolHash);assert(financialHash!==protocolHash,'Code batch and protocol configuration are separate transactions.');
  const dep=provided??await dependencies(),{ccc,cccA,runtime,pin,codec,financial,operator}=dep;
  const base=runtime.validateIsolatedRuntimeConfig(baseProfile??JSON.parse(await fs.readFile(path.join(APP,'config/qa/ckboost-testnet.json'),'utf8')));
  assert(base.schema==='ckboost-isolated-testnet-runtime/v3'&&base.profileHash==='0x129cd99c43113ab92b4ec5331693c402dd1f40b9269fff6c223ad4d3c201b297','Only the committed v3 QA parent is supported.');
  const fixed=operator.validateAdminRegistryUpgradePlan(),owner=ccc.Script.from(fixed.source.owner.lock),transactions=new Map(),headers=new Map();
  const sj=s=>({codeHash:s.codeHash,hashType:s.hashType,args:s.args}),pj=p=>({txHash:p.txHash,index:ccc.numToHex(p.index)}),point=p=>`${p.txHash}:${ccc.numFrom(p.index)}`;
  const output=o=>ccc.CellOutput.from({capacity:o.capacity,lock:{codeHash:o.lock.code_hash,hashType:o.lock.hash_type,args:o.lock.args},type:o.type?{codeHash:o.type.code_hash,hashType:o.type.hash_type,args:o.type.args}:undefined});
  async function transaction(id){
    id=hash(id);if(!transactions.has(id))transactions.set(id,(async()=>{const raw=await rpc('get_transaction',[id]);assert(raw?.tx_status?.status==='committed'&&raw.transaction,`Transaction ${id} is not committed. No confirmed bundle/profile will be written.`);const tx=ccc.Transaction.fromBytes(cccA.JsonRpcTransformers.transactionTo(raw.transaction).toBytes());assert(tx.hash()===id&&(!raw.transaction.hash||raw.transaction.hash===id),'Canonical committed raw transaction hash mismatch.');return {raw,tx};})());return transactions.get(id);
  }
  async function block(record){const status=record.raw.tx_status;if(status.block_number)return ccc.numFrom(status.block_number);const id=hash(status.block_hash);if(!headers.has(id))headers.set(id,rpc('get_header',[id]));const h=await headers.get(id);assert(h?.hash===id,'Committed block header mismatch.');return ccc.numFrom(h.number);}
  async function inputCell(input){const {tx}=await transaction(input.previousOutput.txHash),index=Number(input.previousOutput.index);assert(tx.outputs[index]&&typeof tx.outputsData[index]==='string','The actual committed input output is unavailable.');return ccc.Cell.from({outPoint:input.previousOutput,cellOutput:tx.outputs[index],outputData:tx.outputsData[index]});}
  async function liveCell(tx,index,keepData=false){const result=await rpc('get_live_cell',[{tx_hash:tx.hash(),index:ccc.numToHex(index)},true]);assert(result?.status==='live'&&result.cell?.output&&result.cell?.data,'An exact confirmed output is not currently live.');const actual=output(result.cell.output),data=result.cell.data.content;assert(ccc.hexFrom(actual.toBytes())===ccc.hexFrom(tx.outputs[index].toBytes())&&data===tx.outputsData[index]&&ccc.hashCkb(data)===result.cell.data.hash,'Live output differs from the exact committed script/owner/capacity/data.');assert(actual.type,'A typed live release output is required.');return {live:true,outPoint:{txHash:tx.hash(),index:ccc.numToHex(index)},typeScript:sj(actual.type),lockScript:sj(actual.lock),capacityShannons:actual.capacity.toString(),dataHash:ccc.hashCkb(data),dataBytes:ccc.bytesFrom(data).length,...(keepData?{dataHex:data}:{})};}
  function plain(cell){assert(!cell.cellOutput.type&&cell.cellOutput.lock.eq(owner)&&cell.outputData==='0x','Only actual empty Account 1 native inputs may fund these transactions.');}
  function fee(tx,cells){const value=cells.reduce((s,c)=>s+c.cellOutput.capacity,0n)-tx.getOutputsCapacity();assert(value>0n&&value<=100000000n,'Actual fee is outside the reviewed one-tCKB limit.');return value;}
  const ids=[fixed.code.hash(),fixed.state.hash(),financialHash,protocolHash],records=await parallel(ids,id=>transaction(id)),[regCode,regState,fin,config]=records;
  assert(ccc.hexFrom(regCode.tx.rawToBytes())===ccc.hexFrom(fixed.code.rawToBytes())&&ccc.hexFrom(regState.tx.rawToBytes())===ccc.hexFrom(fixed.state.rawToBytes()),'Actual Registry creation bodies differ from the fixed reviewed linked plan.');
  const [regCodeInputs,regStateInputs,financialInputs,configInputs]=await parallel(records,r=>parallel(r.tx.inputs,i=>inputCell(i)));
  regCodeInputs.forEach(plain);regStateInputs.forEach(plain);assert(fee(regCode.tx,regCodeInputs).toString()===fixed.source.code.feeShannons&&fee(regState.tx,regStateInputs).toString()===fixed.source.state.feeShannons,'Actual Registry fee differs from the fixed plan.');
  assert(config.tx.inputs.length>=2&&config.tx.inputs.length<=40&&config.tx.inputs[0].since===0n,'Protocol input shape is invalid.');const before=configInputs[0];assert(before.cellOutput.type?.hash()===base.protocol.typeHash,'The actual protocol input belongs to a different protocol.');
  const codePlan=financial.buildAdminFinancialCodePlan({protocolCell:before,oldProtocolCode:financialInputs[0],fundingCells:financialInputs.slice(1),binaries:{protocolLock:fin.tx.outputsData[0],tippingType:fin.tx.outputsData[1],fundingLock:fin.tx.outputsData[2]}});
  assert(codePlan.status==='unsigned-prepared'&&codePlan.transaction.hash()===financialHash&&ccc.hexFrom(codePlan.transaction.rawToBytes())===ccc.hexFrom(fin.tx.rawToBytes()),'Actual financial batch does not match the reviewed factory/pins/inputs/outputs/deps/fees.');financial.assertAdminFinancialCodePlan(codePlan);financialInputs.slice(1).forEach(plain);fee(fin.tx,financialInputs);configInputs.slice(1).forEach(plain);fee(config.tx,configInputs);
  const blocks=await parallel(records,r=>block(r)),[codeBlock,stateBlock,finBlock,configBlock]=blocks;
  assert(codeBlock<stateBlock&&stateBlock<finBlock&&finBlock<configBlock,'Registry, financial batch and configuration must be committed in that order.');
  const lives=await parallel([[regCode.tx,0,false],[regState.tx,0,true],[fin.tx,0,false],[fin.tx,1,false],[fin.tx,2,false],[config.tx,0,true]],([tx,index,keep])=>liveCell(tx,index,keep));
  const liveCells={registryCode:lives[0],registryState:lives[1],protocolLock:lives[2],tippingType:lives[3],fundingLock:lives[4],protocolState:lives[5]};
  const beforeData=codec.ProtocolData.decode(before.outputData),codes=beforeData.protocol_config.script_code_hashes,tipCode=ccc.hexFrom(codes.ckb_boost_tipping_type_code_hash),fundCode=ccc.hexFrom(codes.ckb_boost_funding_lock_code_hash),campaignCode=ccc.hexFrom(codes.ckb_boost_campaign_type_code_hash);
  const rscript=s=>({code_hash:s.codeHash,hash_type:s.hashType,args:s.args});
  async function pages(script,kind,mode='prefix'){const values=[];let cursor;for(let page=0;page<20;page++){const params=[{script:rscript(script),script_type:kind,script_search_mode:mode,with_data:true},'desc','0x64'];if(cursor)params.push(cursor);const response=await rpc('get_cells',params);assert(Array.isArray(response.objects),'Invalid complete financial namespace page.');values.push(...response.objects);if(response.objects.length<100)return values;assert(response.last_cursor&&response.last_cursor!==cursor,'Financial namespace pagination did not advance.');cursor=response.last_cursor;}throw Error('Financial namespace completeness exceeds the bounded budget.');}
  async function emptyFunding(args){const lock=ccc.Script.from({codeHash:fundCode,hashType:'type',args}),response=await rpc('get_cells',[{script:rscript(lock),script_type:'lock',script_search_mode:'exact',with_data:true},'desc','0x1']);assert(Array.isArray(response.objects),'Invalid exact Funding namespace response.');for(const v of response.objects)assert(output(v.output).lock.eq(lock),'Unexpected Funding namespace result.');return response.objects.length;}
  const [tips,campaignRows,protocolFunding]=await parallel([0,1,2],async name=>name===0?pages({codeHash:tipCode,hashType:'type',args:'0x'},'type'):name===1?pages({codeHash:campaignCode,hashType:'type',args:'0x'},'type'):emptyFunding(base.protocol.typeHash));
  function scopedType(raw,code){const s=output(raw.output).type;assert(s&&s.codeHash===code&&s.hashType==='type','Unexpected code namespace result.');const id=codec.ConnectedTypeID.decode(s.args);assert(ccc.hexFrom(codec.ConnectedTypeID.encode(id))===s.args,'Noncanonical ConnectedTypeID.');return ccc.hexFrom(id.connected_key)===base.protocol.typeHash?s:null;}
  const oldQaTips=tips.filter(raw=>scopedType(raw,tipCode)).length,campaigns=[];
  for(const raw of campaignRows){const type=scopedType(raw,campaignCode);if(!type)continue;const d=codec.CampaignData.decode(raw.output_data);assert(ccc.hexFrom(codec.CampaignData.encode(d))===raw.output_data,'Noncanonical QA CampaignData.');assert(!campaigns.some(s=>s.hash()===type.hash()),'Duplicate QA Campaign identity.');campaigns.push(type);}
  const campaignFunding=(await parallel(campaigns,s=>emptyFunding(s.hash()))).reduce((s,n)=>s+n,0);
  const inventory={complete:true,oldQaTips,protocolFunding,campaignFunding,campaignTypeHashes:campaigns.map(s=>s.hash())};assert(oldQaTips===0&&protocolFunding===0&&campaignFunding===0,'Old QA financial cells remain. A separate migration is required; no runtime can be generated.');
  const expected=financial.makeAdminFinancialProtocolData(before,codePlan,{complete:true,oldTips:oldQaTips,protocolFunding,campaignFunding},codec.ProtocolData.decode(config.tx.outputsData[0]).last_updated);
  assert(ccc.hexFrom(codec.ProtocolData.encode(expected))===config.tx.outputsData[0],'Actual ProtocolData changed more than Tip/Funding hashes and last_updated.');
  const indexerTip=await rpc('get_indexer_tip',[]);assert(indexerTip&&ccc.numFrom(indexerTip.block_number)>=configBlock,'The Indexer has not reached the confirmed protocol update; funding completeness is not established.');
  const old=base.sources.effectiveProfile.dependencies.find(r=>r.name==='ckboostProtocolLock'),first=ccc.hexFrom(fin.tx.inputs[0].toBytes());
  const financialManifests=Object.fromEntries(['protocolLock','tippingType','fundingLock'].map((name,index)=>{const proof={transactionHash:financialHash,blockNumber:ccc.numToHex(finBlock),outputIndex:index},type=fin.tx.outputs[index].type,common={schema:index===0?'ckboost-testnet-code-upgrade/v1':'ckboost-testnet-code-deployment/v1',network:'testnet',contract:index===0?'protocol-lock':index===1?'tipping-type':'funding-lock',hashType:'type',isTypeId:true,typeScript:sj(type),typeHash:type.hash(),lockScript:sj(fin.tx.outputs[index].lock),transactionHash:financialHash,index:ccc.numToHex(index),blockNumber:ccc.numToHex(finBlock),dataHash:pin.dataHashes[name],contractSize:pin.byteLengths[name],capacityShannons:fin.tx.outputs[index].capacity.toString()};return [name,index===0?{...common,previous:{transactionHash:old.outPoint.txHash,index:old.outPoint.index,dataHash:old.dataHash,contractSize:old.dataBytes,capacityShannons:old.capacity},upgradeEvidence:{...proof,inputIndex:0,consumedInput:first,consumedOutPoint:old.outPoint}}:{...common,creationEvidence:{...proof,firstInput:first,typeIdArgs:type.args}}];}));
  const cellJson=c=>({outPoint:pj(c.outPoint),typeScript:c.cellOutput.type?sj(c.cellOutput.type):null,lockScript:sj(c.cellOutput.lock),capacityShannons:c.cellOutput.capacity.toString(),dataHex:c.outputData,dataHash:ccc.hashCkb(c.outputData)});
  const beforeParent=await transaction(before.outPoint.txHash),afterCell=ccc.Cell.from({outPoint:{txHash:protocolHash,index:0},cellOutput:config.tx.outputs[0],outputData:config.tx.outputsData[0]});
  const bundle={schema:'ckboost-admin-upgrade-confirmed/v1',network:'testnet',releaseId:pin.releaseId,
    registry:{schema:'ckboost-admin-registry-deployment/v1',network:'testnet',protocolTypeHash:base.protocol.typeHash,typeScript:sj(regState.tx.outputs[0].type),codeTypeScript:sj(regCode.tx.outputs[0].type),codeDataHash:fixed.source.release.dataHash,codeDeployment:{transactionHash:regCode.tx.hash(),index:'0x0',blockNumber:ccc.numToHex(codeBlock),capacityShannons:regCode.tx.outputs[0].capacity.toString(),contractSize:46600,ownerLockScript:sj(owner)},stateCreation:{transactionHash:regState.tx.hash(),index:'0x0',blockNumber:ccc.numToHex(stateBlock),capacityShannons:regState.tx.outputs[0].capacity.toString(),dataHash:ccc.hashCkb(regState.tx.outputsData[0]),firstInput:ccc.hexFrom(regState.tx.inputs[0].toBytes())}},financial:financialManifests,
    protocolUpdate:{transactionHash:protocolHash,blockNumber:ccc.numToHex(configBlock),transactionHex:ccc.hexFrom(config.tx.toBytes()),before:{...cellJson(before),transactionHex:ccc.hexFrom(beforeParent.tx.toBytes())},after:cellJson(afterCell),inputCells:configInputs.map(cellJson)},financialInventory:inventory,
    confirmation:{status:'confirmed',endpoint:ADMIN_CONFIRM_ENDPOINT,canonicalTransactionsVerified:true,canonicalInputParentsVerified:true,liveCells}};
  const configV4=runtime.makeAdminUpgradedIsolatedRuntimeConfig(base,bundle);return {bundle:configV4.sources.adminUpgradeBundle,config:configV4};
}

export async function writeAdminConfirmation({financialHash,protocolHash,dappDirectory=APP,fetcher=fetch}={}){
  const directory=path.join(dappDirectory,'.qa-local/admin-upgrade'),network=[],began=Date.now(),report={schema:'ckboost-admin-upgrade-public-audit/v1',checkedAt:new Date().toISOString(),didSign:false,didBroadcast:false,didEstimateCycles:false,didActivate:false,network};
  let result;
  try{result=await confirmAdminUpgradeFromChain({financialHash,protocolHash,rpc:createAdminPublicRpc({fetcher,network,deadline:began+30000})});Object.assign(report,{status:'confirmed',profileHash:result.config.profileHash});}
  catch(error){Object.assign(report,{status:'unverified',error:error.message});}
  report.elapsedMs=Date.now()-began;await fs.mkdir(directory,{recursive:true,mode:0o700});
  const audit=path.join(directory,`confirmation-${new Date().toISOString().replaceAll(':','-')}.json`);await fs.writeFile(audit,json(report),{flag:'wx',mode:0o600});
  if(!result)return {status:'unverified',error:report.error,auditFile:audit};
  const target=path.join(directory,'confirmed',result.config.profileHash.slice(2));await fs.mkdir(target,{recursive:true,mode:0o700});
  for(const [name,value]of [['bundle.json',result.bundle],['runtime-config.json',result.config]]){const file=path.join(target,name),content=json(value);try{await fs.writeFile(file,content,{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;assert(await fs.readFile(file,'utf8')===content,'Existing confirmed artifacts differ; inspect them instead of overwriting.');}}
  return {status:'confirmed',profileHash:result.config.profileHash,bundleFile:path.join(target,'bundle.json'),runtimeFile:path.join(target,'runtime-config.json'),auditFile:audit,didActivate:false};
}
