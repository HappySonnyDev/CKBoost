#!/usr/bin/env node
// One foreground command for the fixed shared QA profile. No wallet, contract
// deployment, site publication, process discovery or existing-service removal.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { PORTS, QA_PROFILE_HASH, requireSupportedNode, requireFreePort } from './qa.mjs';
import { QA_PNPM_VERSION } from './qa-prepare.mjs';
import { SSRI_IMAGE, checkDocker, waitLoopbackPort } from './ssri-qa.mjs';

const DAPP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STOPPED = 'QA startup stopped by user.';

export function oneCommandPlan() {
  return { profileHash: QA_PROFILE_HASH, browserUrl: 'http://localhost:9004/revamp',
    ports: [...Object.values(PORTS), 9090, 9091],
    prerequisites: `macOS/Linux or WSL, Node22.13+, pnpm${QA_PNPM_VERSION}, running Docker`,
    phases: ['Check versions, free ports and Docker', 'Prepare frozen dependencies',
      'Pull the pinned linux/amd64 SSRI image', 'Start owned SSRI and compatibility bridge',
      'Build the fixed QA profile', 'Serve the application in this terminal'],
    preparesAndBuildsEveryRun: true, signsOrBroadcasts: false, publishesWebsite: false };
}

// Every PID here comes directly from our detached spawn. Never look up a PID
// by a port/container name. Complete each phase's group cleanup before retiring
// its PID, rather than retaining completed process groups across a long build.
export async function stopOwnedGroup(pid, { kill = process.kill, pause = delay, now = Date.now } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const exists = () => {
    try { kill(-pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  };
  const send = signal => {
    try { kill(-pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  if (!exists()) return;
  send('SIGTERM');
  // ssri-qa itself allows five seconds to stop its owned Docker/bridge children.
  const deadline = now() + 10000;
  while (exists() && now() < deadline) await pause(100);
  if (exists()) {
    send('SIGKILL');
    const finalDeadline = now() + 2000;
    while (exists() && now() < finalDeadline) await pause(100);
    if (exists()) throw new Error(`Owned QA process group ${pid} has not exited.`);
  }
}

export function createOwnedSupervisor({ signal, spawnChild = spawn, stopGroup = stopOwnedGroup } = {}) {
  const states = new Set();
  const interrupted = new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  // The promise is also used between phases, where there may be no active race.
  interrupted.catch(() => {});
  const assertRunning = () => signal.throwIfAborted();
  const serviceFailure = state => state.done.then(result => {
    throw new Error(`${state.label} exited unexpectedly (${result.error?.message ?? result.code ?? result.signal}).`);
  });
  const guard = (promise, services = []) => {
    assertRunning();
    return Promise.race([promise, interrupted, ...services.map(serviceFailure)]);
  };
  const retire = state => {
    if (!state.cleanup) state.cleanup = stopGroup(state.child.pid).finally(() => states.delete(state));
    return state.cleanup;
  };
  return {
    assertRunning, guard,
    start(label, command, args, { capture = false } = {}) {
      assertRunning();
      const child = spawnChild(command, args, { cwd: DAPP, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', shell: false, detached: true });
      const state = { child, label, output: '', result: null };
      state.done = new Promise(resolve => {
        const finish = result => { if (!state.result) { state.result = result; resolve(result); } };
        child.once('error', error => finish({ error }));
        child.once('close', (code, signal) => finish({ code, signal }));
        if (capture) child.stdout.on('data', chunk => {
          state.output += chunk;
          if (state.output.length > 4096) finish({ error: new Error('Version output exceeded its bound.') });
        });
      });
      states.add(state);
      return state;
    },
    async wait(state, services = []) {
      const result = await guard(state.done, services);
      assertRunning();
      if (result.error) throw result.error;
      if (result.code !== 0) throw new Error(`${state.label} failed (${result.code ?? result.signal}).`);
      await retire(state);
      assertRunning();
      return state.output;
    },
    assertServices(services) {
      assertRunning();
      const ended = services.find(state => state.result);
      if (ended) throw new Error(`${ended.label} exited unexpectedly.`);
    },
    async stopAll() {
      const results = await Promise.allSettled([...states].map(retire));
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('; '));
    },
  };
}

export async function runQaUp({ spawnChild = spawn, stopGroup = stopOwnedGroup,
  freePort = requireFreePort, dockerPreflight = checkDocker, waitPort = waitLoopbackPort,
  signals = process, nodeVersion = process.versions.node, platform = process.platform,
  log = console.log } = {}) {
  requireSupportedNode(nodeVersion);
  if (!['darwin', 'linux'].includes(platform)) throw new Error('Run QA from macOS, Linux or WSL; native Windows process launching is unsupported.');
  const controller = new AbortController();
  const stop = () => controller.abort(new Error(STOPPED));
  signals.on('SIGINT', stop); signals.on('SIGTERM', stop);
  const owned = createOwnedSupervisor({ signal: controller.signal, spawnChild, stopGroup });
  let failure;
  try {
    log('[QA 1/6] Checking Node, pnpm, ports and Docker.');
    const version = owned.start('pnpm version check', 'pnpm', ['--version'], { capture: true });
    const installed = (await owned.wait(version)).trim();
    if (installed !== QA_PNPM_VERSION) throw new Error(`Use pnpm${QA_PNPM_VERSION} (received ${installed || 'unknown'}).`);
    await owned.guard(Promise.all(oneCommandPlan().ports.map(port => freePort(port))));
    await owned.guard(dockerPreflight(async args => {
      const child = owned.start('Docker preflight', 'docker', args, { capture: true });
      return owned.wait(child);
    }));
    owned.assertRunning();
    log('[QA 2/6] Preparing frozen dependencies and checked-in TypeScript sources.');
    await owned.wait(owned.start('Dependency preparation', process.execPath, [path.join(DAPP, 'scripts/qa-prepare.mjs')]));
    log('[QA 3/6] Preparing the pinned SSRI image. First download can take several minutes.');
    await owned.wait(owned.start('Pinned image pull', 'docker', ['pull', '--platform', 'linux/amd64', SSRI_IMAGE]));
    // Preparation/pulling may take time; a foreign listener that appeared in the
    // meantime must be rejected before starting or building our services.
    await owned.guard(Promise.all(oneCommandPlan().ports.map(port => freePort(port))));
    log('[QA 4/6] Starting the owned SSRI executor and compatibility bridge.');
    const ssri = owned.start('QA SSRI service', process.execPath, [path.join(DAPP, 'scripts/ssri-qa.mjs'), 'start']);
    const services = [ssri];
    await owned.guard(waitPort(9091, { signal: controller.signal, timeoutMs: 90000,
      check: () => owned.assertServices(services) }), services);
    owned.assertServices(services);
    log('[QA 5/6] Building the fixed shared Testnet QA profile.');
    await owned.wait(owned.start('QA build', process.execPath, [path.join(DAPP, 'scripts/qa.mjs'), 'build']), services);
    owned.assertServices(services);
    log('[QA 6/6] Starting http://localhost:9004/revamp — keep this terminal open. Ctrl+C stops only this command’s services.');
    await owned.wait(owned.start('QA application', process.execPath, [path.join(DAPP, 'scripts/qa.mjs'), 'start']), services);
    return { completed: true };
  } catch (error) {
    if (controller.signal.aborted) { log('QA stopped. Cleaning up this command’s services.'); return { stopped: true }; }
    failure = error; throw error;
  } finally {
    try { await owned.stopAll(); }
    catch (error) { if (failure) log(`QA cleanup: ${error.message}`); else throw error; }
    finally { signals.removeListener('SIGINT', stop); signals.removeListener('SIGTERM', stop); }
  }
}

export async function main(argv = process.argv.slice(2), run = runQaUp) {
  if (argv.length === 1 && argv[0] === '--plan') { console.log(JSON.stringify(oneCommandPlan(), null, 2)); return; }
  if (argv.length === 1 && argv[0] === '--help') { console.log('Usage: pnpm qa [--plan]\nRequires Node22.13+, pnpm9.15.9 and running Docker. Starts only the fixed shared Testnet QA profile in one foreground terminal.'); return; }
  if (argv.length) throw new Error('Usage: pnpm qa [--plan]. Profile, ports and network cannot be overridden.');
  return run();
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
