/* Local compatibility adapter for the pinned legacy SSRI executor.
 * No wallet, key, arbitrary upstream, or blockchain broadcast API. */
const http=require('node:http');
const path=require('node:path');
const {createRequire}=require('node:module');
const appRequire=createRequire(path.resolve(__dirname,'../package.json'));
const sdkRequire=createRequire(appRequire.resolve('@ckb-ccc/connector-react'));
const {ccc}=sdkRequire('@ckb-ccc/core');
const {cccA}=sdkRequire('@ckb-ccc/core/advanced');
const LIMIT=2*1024*1024;
const HEX=/^0x(?:[a-fA-F0-9]{2})*$/;
const H32=/^0x[a-fA-F0-9]{64}$/;
const Q=/^0x(?:0|[1-9a-fA-F][a-fA-F0-9]*)$/;
function assert(value,message){if(!value)throw Error(message);}
function keys(value,required,optional=[]){
  assert(value&&typeof value==='object'&&!Array.isArray(value),'Expected object');
  assert(required.every(k=>Object.hasOwn(value,k)),'Missing object field');
  assert(Object.keys(value).every(k=>required.includes(k)||optional.includes(k)),'Unknown object field');
}
function hex(v){assert(typeof v==='string'&&HEX.test(v)&&v.length<=LIMIT,'Invalid bytes');}
function hash(v){assert(typeof v==='string'&&H32.test(v),'Invalid hash');}
function quantity(v){assert(typeof v==='string'&&Q.test(v)&&v.length<=34,'Invalid quantity');}
function array(v,fn){assert(Array.isArray(v)&&v.length<=1000,'Invalid list');v.forEach(fn);}
function script(v){keys(v,['code_hash','hash_type','args']);hash(v.code_hash);assert(['data','type','data1','data2'].includes(v.hash_type),'Invalid hash type');hex(v.args);cccA.JsonRpcTransformers.scriptTo(v).toBytes();}
function output(v){keys(v,['capacity','lock'],['type']);quantity(v.capacity);script(v.lock);if(v.type!=null)script(v.type);cccA.JsonRpcTransformers.cellOutputTo(v).toBytes();}
function outPoint(v){keys(v,['tx_hash','index']);hash(v.tx_hash);quantity(v.index);assert(BigInt(v.index)<=0xffffffffn,'Invalid output index');}
function transaction(v){
  keys(v,['inner','hash']);hash(v.hash);
  const t=v.inner;
  keys(t,['version','cell_deps','header_deps','inputs','outputs','outputs_data','witnesses']);quantity(t.version);assert(BigInt(t.version)<=0xffffffffn,'Invalid transaction version');
  array(t.cell_deps,x=>{keys(x,['out_point','dep_type']);outPoint(x.out_point);assert(['code','dep_group'].includes(x.dep_type),'Invalid dependency');});
  array(t.header_deps,hash);array(t.inputs,x=>{keys(x,['since','previous_output']);quantity(x.since);outPoint(x.previous_output);});
  array(t.outputs,output);array(t.outputs_data,hex);array(t.witnesses,hex);assert(t.outputs.length===t.outputs_data.length,'Output data length mismatch');
  const parsed=cccA.JsonRpcTransformers.transactionTo(t);parsed.toBytes();assert(parsed.hash().toLowerCase()===v.hash.toLowerCase(),'Transaction hash mismatch');
}
function validateRequest(v){
  keys(v,['jsonrpc','id','method','params']);assert(v.jsonrpc==='2.0','Invalid JSON-RPC version');
  assert(typeof v.id==='string'||(typeof v.id==='number'&&Number.isSafeInteger(v.id)),'Invalid request ID');
  const methods={run_script_level_code:3,run_script_level_script:4,run_script_level_cell:4,run_script_level_transaction:4};
  assert(Object.hasOwn(methods,v.method),'Unsupported read-only SSRI method');
  assert(Array.isArray(v.params)&&v.params.length===methods[v.method],'Invalid parameters');
  const [txHash,index,args,context]=v.params;hash(txHash);assert(Number.isInteger(index)&&index>=0&&index<=0xffffffff,'Invalid code index');array(args,hex);assert(args.length>0&&args[0].length===18,'Expected SSRI method path');
  if(v.method==='run_script_level_script')script(context);
  if(v.method==='run_script_level_cell'){keys(context,['cell_output'],['hex_data']);output(context.cell_output);if(context.hex_data!=null)hex(context.hex_data);}
  if(v.method==='run_script_level_transaction')transaction(context);
  // ckb-jsonrpc-types TransactionView uses serde(flatten) for its inner
  // transaction, while installed CCC 0.2.x wraps it under `inner`.
  const params=v.method==='run_script_level_transaction'?[...v.params.slice(0,3),{...context.inner,hash:context.hash}]:v.params;
  return {jsonrpc:'2.0',id:v.id,method:v.method==='run_script_level_transaction'?'run_script_level_tx':v.method,params};
}
function createBridgeServer({fetcher=fetch}={}){
  let active=0;
  const server=http.createServer(async(req,res)=>{
    const origin=req.headers.origin;
    if(origin&&!/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin)){res.writeHead(403).end();return;}
    if(origin)res.setHeader('Access-Control-Allow-Origin',origin);
    res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Methods','POST');res.setHeader('Access-Control-Allow-Headers','Content-Type');
    if(req.method==='OPTIONS'){res.writeHead(204).end();return;}
    if(req.method!=='POST'||req.url!=='/'){res.writeHead(405).end();return;}
    if(active>=2){res.writeHead(429).end();return;}
    active++;let id=null;
    try{
      let length=0;const chunks=[];
      for await(const chunk of req){length+=chunk.length;assert(length<=LIMIT,'Request exceeds 2MiB');chunks.push(chunk);}
      const parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));id=parsed?.id??null;
      const body=validateRequest(parsed);
      const upstream=await fetcher('http://127.0.0.1:9090',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(20000)});
      assert(upstream.ok,'SSRI upstream HTTP error');
      const response=await upstream.text();assert(Buffer.byteLength(response)<=LIMIT,'SSRI response exceeds 2MiB');
      const rpc=JSON.parse(response);assert(rpc.jsonrpc==='2.0'&&rpc.id===body.id&&('result'in rpc||'error'in rpc),'Invalid upstream JSON-RPC response');
      res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(rpc));
    }catch(error){res.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32600,message:error.message}}));}
    finally{active--;}
  });
  server.requestTimeout=25000;
  server.headersTimeout=10000;
  return server;
}
function start(){
  const server=createBridgeServer();
  server.listen(9091,'127.0.0.1',()=>console.log('SSRI compatibility bridge: http://127.0.0.1:9091 → pinned localhost9090 executor; no broadcast API'));
  return server;
}
module.exports={validateRequest,createBridgeServer,start};
if(require.main===module){
  if(process.argv.length!==2)throw Error('This bridge has no configurable port or upstream arguments.');
  start();
}
