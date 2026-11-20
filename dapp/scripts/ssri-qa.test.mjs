import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import net from 'node:net';
import {buildPlan,parseArgs,checkDocker,assertFreePort,startSsriQa,SSRI_IMAGE,CONTAINER_NAME} from './ssri-qa.mjs';

function child(){const process=new EventEmitter();process.kills=[];process.kill=signal=>{process.kills.push(signal);queueMicrotask(()=>process.emit('exit',null,signal));return true;};return process;}
function fixture(){
  const children=[],commands=[],free=[],waiting=[],signals=new EventEmitter();let checks=0;
  return {children,commands,free,waiting,signals,get checks(){return checks;},deps:{signals,log:()=>{},ensurePortFree:async port=>{free.push(port);},dockerPreflight:async()=>{checks++;},spawnChild:(command,args,options)=>{commands.push({command,args,options});const value=child();children.push(value);return value;},waitPort:async(port,options)=>{waiting.push(port);options.check();}}};
}

test('plan is fixed, pinned, loopback-only and contains no mounts or secret environment',()=>{
  const plan=buildPlan(),docker=plan.commands[0];
  assert.equal(plan.network,'testnet');assert.equal(plan.executorUrl,'http://127.0.0.1:9091/');assert.equal(plan.upstreamUrl,'http://127.0.0.1:9090/');
  assert.equal(docker.command,'docker');assert.equal(docker.args.at(-1),SSRI_IMAGE);assert.match(SSRI_IMAGE,/@sha256:[0-9a-f]{64}$/);
  for(const value of [CONTAINER_NAME,'--rm','linux/amd64','--read-only','ALL','no-new-privileges','512m','127.0.0.1:9090:9090'])assert.ok(docker.args.includes(value),value);
  for(const value of ['-d','--detach','-v','--volume','--mount','-e','--env','--env-file','--privileged','--network=host'])assert.equal(docker.args.includes(value),false,value);
  assert.match(plan.commands[1].args[0],/dapp\/scripts\/ssri-compat-bridge\.cjs$/);
});

test('CLI defaults to non-executing plan and rejects arbitrary upstream/image/port switches',()=>{
  assert.equal(parseArgs([]),'plan');assert.equal(parseArgs(['--plan']),'plan');assert.equal(parseArgs(['start']),'start');
  for(const args of [['--upstream','https://example.com'],['start','--port','9000'],['--image','other'],['stop']])assert.throws(()=>parseArgs(args),/fixed/);
});

test('Docker preflight refuses any existing same-name container without stopping it',async()=>{
  const commands=[];await assert.rejects(checkDocker(async args=>{commands.push(args);return args[0]==='info'?'29.0.0':CONTAINER_NAME;}),/not stopped or removed/);
  assert.equal(commands.length,2);assert.deepEqual(commands.map(args=>args[0]),['info','container']);assert.equal(commands.some(args=>args.includes('stop')||args.includes('rm')),false);
  await assert.rejects(checkDocker(async()=>{throw Error('ENOENT');}),/does not install or start/);
});

test('Docker preflight permits an available daemon with no same-name container',async()=>{
  const commands=[];await checkDocker(async args=>{commands.push(args);return args[0]==='info'?'29.0.0':'';});assert.equal(commands.length,2);
});

test('free-port check refuses an occupied ephemeral local socket and leaves it listening',async()=>{
  const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{await assert.rejects(assertFreePort(server.address().port),/existing service intact/);assert.equal(server.listening,true);}
  finally{await new Promise(resolve=>server.close(resolve));}
});

test('occupied configured port aborts before Docker checks or any child spawn',async()=>{
  const f=fixture();f.deps.ensurePortFree=async port=>{if(port===9091)throw Error('occupied9091');};
  await assert.rejects(startSsriQa(f.deps),/occupied9091/);assert.equal(f.checks,0);assert.equal(f.children.length,0);assert.equal(f.signals.listenerCount('SIGINT'),0);
});

test('foreground startup orders executor before bridge and Ctrl+C signals only owned children',async()=>{
  const f=fixture();const original=f.deps.waitPort;f.deps.waitPort=async(port,options)=>{await original(port,options);if(port===9091)queueMicrotask(()=>f.signals.emit('SIGINT'));};
  await startSsriQa(f.deps);
  assert.deepEqual(f.waiting,[9090,9091]);assert.deepEqual(f.free,[9090,9091,9091]);assert.equal(f.children.length,2);
  assert.equal(f.commands[0].command,'docker');assert.equal(f.commands[0].options.shell,false);assert.equal(f.commands[1].options.stdio,'inherit');
  for(const value of f.children)assert.deepEqual(value.kills,['SIGTERM']);
  assert.equal(f.signals.listenerCount('SIGINT'),0);assert.equal(f.signals.listenerCount('SIGTERM'),0);
});

test('early Docker exit never starts the host bridge or kills unrelated processes',async()=>{
  const f=fixture();f.deps.waitPort=async(_port,options)=>{f.children[0].emit('exit',1,null);options.check();};
  await assert.rejects(startSsriQa(f.deps),/Docker process exited/);assert.equal(f.children.length,1);assert.deepEqual(f.children[0].kills,[]);
});

test('bridge startup failure cleans only the owned foreground Docker and bridge children',async()=>{
  const f=fixture();f.deps.waitPort=async port=>{if(port===9091)throw Error('bridge startup failed');};
  await assert.rejects(startSsriQa(f.deps),/bridge startup failed/);assert.equal(f.children.length,2);
  for(const value of f.children)assert.deepEqual(value.kills,['SIGTERM']);
  assert.equal(f.commands.some(command=>command.args.includes('stop')||command.args.includes('kill')),false);
});

test('a later bridge exit also stops only its owned executor process',async()=>{
  const f=fixture();f.deps.log=()=>{queueMicrotask(()=>f.children[1].emit('exit',3,null));};
  await assert.rejects(startSsriQa(f.deps),/bridge exited/);assert.deepEqual(f.children[0].kills,['SIGTERM']);assert.deepEqual(f.children[1].kills,[]);
});

test('Docker preflight failure creates no children and restores signal handlers',async()=>{
  const f=fixture();f.deps.dockerPreflight=async()=>{throw Error('daemon unavailable');};
  await assert.rejects(startSsriQa(f.deps),/daemon unavailable/);assert.equal(f.children.length,0);assert.equal(f.signals.listenerCount('SIGINT'),0);
});
