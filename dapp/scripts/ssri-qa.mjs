#!/usr/bin/env node
// Explicit, foreground-only QA tooling. No wallet or blockchain write methods.
import net from 'node:net';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

export const SSRI_IMAGE='hanssen0/ckb-ssri-server@sha256:fb7fe2465c7ee9930018042a01db0c4efdce9eab20a6f58ab1532a6f240a7a25';
export const CONTAINER_NAME='ckboost-ssri-qa';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const BRIDGE=path.join(ROOT,'dapp/scripts/ssri-compat-bridge.cjs');
const exec=promisify(execFile);

export function parseArgs(argv){
  if(argv.length===0)return 'plan';
  if(argv.length===1&&['plan','--plan','start','--start'].includes(argv[0]))return argv[0].replace(/^--/,'');
  throw Error('Usage: node dapp/scripts/ssri-qa.mjs [plan|start]. Ports, network, image and upstream are fixed.');
}

export function buildPlan(){
  return {
    schema:'ckboost-isolated-ssri-plan/v1',network:'testnet',
    executorUrl:'http://127.0.0.1:9091/',upstreamUrl:'http://127.0.0.1:9090/',
    notes:[
      'Plan prints commands only. Start runs both children in the foreground; no existing service is stopped.',
      'The image is pinned to a digest and linux/amd64. Its baked Testnet executor listens on 9090 with script_debug enabled.',
      'No mounts, wallet keys or host environment are passed into the container. Docker may pull the pinned image on explicit start.',
      'Port readiness is transport readiness, not proof of successful SSRI methods. Application preparation performs its own read-only calls.',
    ],
    commands:[
      {command:'docker',args:['run','--name',CONTAINER_NAME,'--rm','--platform','linux/amd64','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--cpus','1','--memory','512m','--sig-proxy=true','-p','127.0.0.1:9090:9090',SSRI_IMAGE],cwd:ROOT},
      {command:process.execPath,args:[BRIDGE],cwd:ROOT},
    ],
  };
}

export async function assertFreePort(port){
  const server=net.createServer();
  await new Promise((resolve,reject)=>{
    server.once('error',()=>reject(Error(`127.0.0.1:${port} is unavailable. Leave the existing service intact; choose whether to stop it yourself before retrying.`)));
    server.listen({host:'127.0.0.1',port,exclusive:true},()=>server.close(error=>error?reject(error):resolve()));
  });
}

export async function checkDocker(run=async args=>(await exec('docker',args,{timeout:10000,maxBuffer:65536})).stdout){
  try{await run(['info','--format','{{.ServerVersion}}']);}
  catch{throw Error('Docker is not available. Install/start Docker yourself, then retry; this launcher does not install or start the daemon.');}
  const existing=await run(['container','ls','-a','--filter',`name=^/${CONTAINER_NAME}$`,'--format','{{.Names}}']);
  if(existing.trim())throw Error(`Container ${CONTAINER_NAME} already exists. It was not stopped or removed.`);
}

function throwIfStopped(signal){if(signal.aborted)throw signal.reason??Error('SSRI QA stopped.');}
export async function waitLoopbackPort(port,{signal,check=()=>{},timeoutMs=45000}={}){
  const started=Date.now();
  while(Date.now()-started<timeoutMs){
    throwIfStopped(signal);check();
    const connected=await new Promise(resolve=>{
      const socket=net.createConnection({host:'127.0.0.1',port});
      const finish=ok=>{socket.destroy();resolve(ok);};
      socket.setTimeout(250,()=>finish(false));socket.once('error',()=>finish(false));socket.once('connect',()=>finish(true));
    });
    throwIfStopped(signal);check();if(connected)return;
    await delay(250,undefined,{signal});
  }
  throw Error(`The owned SSRI service did not open 127.0.0.1:${port} within ${timeoutMs/1000}s.`);
}

function track(child,label){
  const state={child,label,result:null,done:null};
  state.done=new Promise(resolve=>{
    const finish=result=>{if(!state.result){state.result=result;resolve(result);}};
    child.once('error',error=>finish({error}));child.once('exit',(code,signal)=>finish({code,signal}));
  });
  return state;
}
function checkChildren(states){
  const stopped=states.find(state=>state.result);
  if(stopped)throw Error(`${stopped.label} exited before shutdown${stopped.result.error?`: ${stopped.result.error.message}`:` (code ${stopped.result.code}, signal ${stopped.result.signal})`}. No existing service was stopped.`);
}
async function stopOwned(states){
  await Promise.all(states.map(async state=>{
    if(state.result)return;
    // docker run remains foreground with --sig-proxy; only its owned child PID
    // receives this signal. Never issue docker stop/rm against a name or ID.
    state.child.kill('SIGTERM');
    let timer;
    try{await Promise.race([state.done,new Promise(resolve=>{timer=setTimeout(()=>{if(!state.result)state.child.kill('SIGKILL');resolve();},5000);})]);}
    finally{clearTimeout(timer);}
  }));
}

export async function startSsriQa({ensurePortFree=assertFreePort,dockerPreflight=checkDocker,spawnChild=spawn,waitPort=waitLoopbackPort,signals=process,log=console.log}={}){
  const plan=buildPlan(),states=[],controller=new AbortController();
  const interrupt=()=>controller.abort(Error('SSRI QA stopped by user.'));
  const interrupted=new Promise(resolve=>controller.signal.addEventListener('abort',()=>resolve('interrupted'),{once:true}));
  signals.on('SIGINT',interrupt);signals.on('SIGTERM',interrupt);
  try{
    await Promise.all([ensurePortFree(9090),ensurePortFree(9091)]);
    throwIfStopped(controller.signal);await dockerPreflight();throwIfStopped(controller.signal);
    const add=(command,label)=>{const state=track(spawnChild(command.command,command.args,{cwd:command.cwd,stdio:'inherit',shell:false}),label);states.push(state);return state;};
    add(plan.commands[0],'Owned SSRI Docker process');
    const options={signal:controller.signal,check:()=>checkChildren(states)};
    await waitPort(9090,options);checkChildren(states);throwIfStopped(controller.signal);
    await ensurePortFree(9091);throwIfStopped(controller.signal);
    add(plan.commands[1],'Owned SSRI compatibility bridge');
    await waitPort(9091,options);checkChildren(states);throwIfStopped(controller.signal);
    log('QA SSRI ports ready: application → http://127.0.0.1:9091/ → pinned Testnet executor9090. This is transport readiness; keep this foreground process open. Ctrl+C signals only its owned children.');
    const result=await Promise.race([...states.map(state=>state.done),interrupted]);
    if(result!=='interrupted')checkChildren(states);
  }catch(error){if(!controller.signal.aborted)throw error;}
  finally{
    controller.abort();signals.removeListener('SIGINT',interrupt);signals.removeListener('SIGTERM',interrupt);
    await stopOwned(states);
  }
}

async function main(){const mode=parseArgs(process.argv.slice(2));if(mode==='plan')console.log(JSON.stringify(buildPlan(),null,2));else await startSsriQa();}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
