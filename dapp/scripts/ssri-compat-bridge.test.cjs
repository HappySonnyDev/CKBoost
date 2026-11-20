const test=require('node:test');const assert=require('node:assert/strict');
const {createRequire}=require('node:module');const path=require('node:path');
const r=createRequire(path.resolve(__dirname,'../package.json'));
const rr=createRequire(r.resolve('@ckb-ccc/connector-react'));const {ccc}=rr('@ckb-ccc/core');const{cccA}=rr('@ckb-ccc/core/advanced');
const {validateRequest}=require('./ssri-compat-bridge.cjs');
const {createBridgeServer}=require('./ssri-compat-bridge.cjs');
const http=require('node:http');
const {once}=require('node:events');
const request=(method,context)=>({id:1,jsonrpc:'2.0',method,params:['0x'+'11'.repeat(32),0,['0x6f2a4642323106f8'],...(context?[context]:[])]});
test('only maps transaction method and preserves canonical unsigned payload',()=>{
  const tx=ccc.Transaction.from({});const context={inner:cccA.JsonRpcTransformers.transactionFrom(tx),hash:tx.hash()};
  const v=request('run_script_level_transaction',context);assert.deepEqual(validateRequest(v),{...v,method:'run_script_level_tx',params:[...v.params.slice(0,3),{...context.inner,hash:context.hash}]});
  assert.deepEqual(validateRequest(request('run_script_level_code')),request('run_script_level_code'));
});
test('rejects arbitrary/broadcast methods and batches',()=>{for(const method of ['send_transaction','sendTransaction','run_script_level_tx','fetch','constructor','__proto__'])assert.throws(()=>validateRequest(request(method)),/Unsupported/);assert.throws(()=>validateRequest([request('run_script_level_code')]));});
test('rejects malformed script, transaction hash, extra parameters and hidden fields',()=>{
  assert.throws(()=>validateRequest(request('run_script_level_script',{code_hash:'0x'+'11'.repeat(32),hash_type:'type',args:'javascript:alert(1)'})));
  const tx=ccc.Transaction.from({});assert.throws(()=>validateRequest(request('run_script_level_transaction',{inner:cccA.JsonRpcTransformers.transactionFrom(tx),hash:'0x'+'11'.repeat(32)})),/hash mismatch/);
  assert.throws(()=>validateRequest({...request('run_script_level_code'),url:'https://example.com'}),/Unknown/);
  assert.throws(()=>validateRequest({...request('run_script_level_code'),params:['0x'+'11'.repeat(32),0,['0x00'],'extra']}),/parameters/);
});

test('preserves actual witnesses and rejects mutations of the transaction body',()=>{
  const tx=ccc.Transaction.from({outputs:[{capacity:10000000000n,lock:{codeHash:'0x'+'22'.repeat(32),hashType:'type',args:'0x'+'33'.repeat(20)}}],outputsData:['0x1234'],witnesses:['0x123456']});
  const context={inner:cccA.JsonRpcTransformers.transactionFrom(tx),hash:tx.hash()};
  const mapped=validateRequest(request('run_script_level_transaction',context));
  assert.deepEqual(mapped.params[3].witnesses,['0x123456']);
  const changed=structuredClone(context);changed.inner.outputs_data[0]='0x5678';
  assert.throws(()=>validateRequest(request('run_script_level_transaction',changed)),/hash mismatch/);
  const unknown=structuredClone(context);unknown.inner.broadcast=true;
  assert.throws(()=>validateRequest(request('run_script_level_transaction',unknown)),/Unknown/);
});

async function serverFor(t,fetcher){
  const server=createBridgeServer({fetcher});server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  return server.address().port;
}
function send(port,{body=request('run_script_level_code'),origin='http://localhost:9004',method='POST',pathname='/'}={}){
  return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,path:pathname,method,headers:{...(origin?{origin}:{}),'content-type':'application/json','connection':'close'}},res=>{
      const parts=[];res.on('data',x=>parts.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text:Buffer.concat(parts).toString()}));
    });req.on('error',reject);req.end(typeof body==='string'?body:JSON.stringify(body));
  });
}

test('HTTP adapter permits local CORS and forwards only to fixed localhost9090',async t=>{
  const calls=[];const port=await serverFor(t,async(url,options)=>{calls.push({url,options});const q=JSON.parse(options.body);return new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result:'0x'}));});
  const tx=ccc.Transaction.from({}),context={inner:cccA.JsonRpcTransformers.transactionFrom(tx),hash:tx.hash()};
  const response=await send(port,{body:request('run_script_level_transaction',context)});
  assert.equal(response.status,200);assert.equal(response.headers['access-control-allow-origin'],'http://localhost:9004');
  assert.equal(calls.length,1);assert.equal(calls[0].url,'http://127.0.0.1:9090');assert.equal(calls[0].options.redirect,'error');
  assert.equal(JSON.parse(calls[0].options.body).method,'run_script_level_tx');assert.equal(calls[0].options.signal.aborted,false);
});

test('remote origins, arbitrary methods, batches and oversized bodies never reach upstream',async t=>{
  let calls=0;const port=await serverFor(t,async()=>{calls++;throw Error('Must not reach upstream');});
  for(const origin of ['https://example.com','http://localhost.evil:9004','null','https://localhost:9004'])assert.equal((await send(port,{origin})).status,403);
  assert.equal((await send(port,{method:'GET'})).status,405);
  assert.equal((await send(port,{body:request('send_transaction')})).status,400);
  assert.equal((await send(port,{body:[request('run_script_level_code')]})).status,400);
  assert.equal((await send(port,{body:'x'.repeat(2*1024*1024+1)})).status,400);
  assert.equal((await send(port,{method:'OPTIONS',origin:'http://127.0.0.1:9004'})).status,204);
  assert.equal(calls,0);
});

test('mismatched upstream JSON-RPC responses and transport failures fail closed',async t=>{
  let calls=0;const port=await serverFor(t,async()=>{calls++;if(calls===1)return new Response(JSON.stringify({jsonrpc:'2.0',id:999,result:'0x'}));throw Error('executor unavailable');});
  assert.match((await send(port)).text,/Invalid upstream JSON-RPC response/);
  assert.match((await send(port)).text,/executor unavailable/);
});

test('caps active executor requests at two without forwarding a third',async t=>{
  const waiting=[];let notify;const started=new Promise(resolve=>{notify=resolve;});
  const port=await serverFor(t,async(_url,options)=>{const q=JSON.parse(options.body);const result=new Promise(resolve=>waiting.push(()=>resolve(new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result:'0x'})))));if(waiting.length===2)notify();return result;});
  const first=send(port),second=send(port);await started;
  assert.equal((await send(port)).status,429);assert.equal(waiting.length,2);
  waiting.forEach(resolve=>resolve());assert.equal((await first).status,200);assert.equal((await second).status,200);
});
