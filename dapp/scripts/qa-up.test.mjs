import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn as realSpawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runQaUp, createOwnedSupervisor, stopOwnedGroup, oneCommandPlan, main } from './qa-up.mjs';
import { SSRI_IMAGE } from './ssri-qa.mjs';

const DAPP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixedPorts = [9004, 9005, 9994, 9090, 9091];
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function phase(command, args) {
  if (command === 'pnpm') return 'version';
  if (command === 'docker') return args[0] === 'pull' ? 'pull' : 'docker-preflight';
  if (args[0].endsWith('qa-prepare.mjs')) return 'prepare';
  if (args[0].endsWith('ssri-qa.mjs')) return 'ssri';
  return args.at(-1) === 'build' ? 'build' : 'serve';
}
function fakeChild(pid) {
  const child = new EventEmitter(); child.pid = pid; child.stdout = new EventEmitter(); child.closed = false;
  child.close = (code = 0, signal = null) => { if (child.closed) return; child.closed = true; child.emit('close', code, signal); };
  return child;
}
function harness({ onSpawn, onStop, version = '9.15.9\n' } = {}) {
  const signals = new EventEmitter(), commands = [], children = [], stopped = [], events = [], ports = [], readiness = [];
  const h = { signals, commands, children, stopped, events, ports, readiness };
  h.deps = {
    signals, nodeVersion: '22.19.0', platform: 'darwin', log() {},
    freePort: async port => { ports.push(port); events.push(`port:${port}`); },
    dockerPreflight: async () => { events.push('preflight'); },
    waitPort: async (port, options) => { readiness.push({ port, options }); events.push('ready'); options.check(); },
    spawnChild(command, args, options) {
      const key = phase(command, args), child = fakeChild(50000 + children.length);
      children.push(child); commands.push({ phase: key, command, args: [...args], options, child }); events.push(`spawn:${key}`);
      queueMicrotask(() => {
        if (onSpawn?.(key, child, h) === false) return;
        if (key === 'version') child.stdout.emit('data', Buffer.from(version));
        if (key !== 'ssri') child.close(0);
      });
      return child;
    },
    async stopGroup(pid) {
      stopped.push(pid); events.push(`stop:${pid}`);
      await onStop?.(pid, h);
      children.find(child => child.pid === pid)?.close(null, 'SIGTERM');
    },
  };
  return h;
}
function cleaned(h) {
  assert.deepEqual([...h.stopped].sort((a, b) => a - b), h.children.map(child => child.pid).sort((a, b) => a - b));
  assert.equal(new Set(h.stopped).size, h.stopped.length);
  assert.equal(h.signals.listenerCount('SIGINT'), 0); assert.equal(h.signals.listenerCount('SIGTERM'), 0);
}

test('one-command plan fixes the verified profile, ports and no-sign/no-publish scope', () => {
  const plan = oneCommandPlan();
  assert.equal(plan.profileHash, '0x129cd99c43113ab92b4ec5331693c402dd1f40b9269fff6c223ad4d3c201b297');
  assert.equal(plan.browserUrl, 'http://localhost:9004/revamp'); assert.deepEqual(plan.ports, fixedPorts);
  assert.equal(plan.signsOrBroadcasts, false); assert.equal(plan.publishesWebsite, false); assert.equal(plan.preparesAndBuildsEveryRun, true);
});

test('startup runs version, prepare, pinned pull, SSRI, build and serve in order with detached shell-free owned children', async () => {
  const h = harness(), result = await runQaUp(h.deps);
  assert.deepEqual(result, { completed: true });
  assert.deepEqual(h.commands.map(call => call.phase), ['version', 'prepare', 'pull', 'ssri', 'build', 'serve']);
  assert.deepEqual(h.commands[0].args, ['--version']);
  assert.deepEqual(h.commands[1].args, [path.join(DAPP, 'scripts/qa-prepare.mjs')]);
  assert.equal(h.commands[2].command, 'docker'); assert.deepEqual(h.commands[2].args, ['pull', '--platform', 'linux/amd64', SSRI_IMAGE]);
  assert.deepEqual(h.commands[3].args, [path.join(DAPP, 'scripts/ssri-qa.mjs'), 'start']);
  assert.deepEqual(h.commands[4].args, [path.join(DAPP, 'scripts/qa.mjs'), 'build']);
  assert.deepEqual(h.commands[5].args, [path.join(DAPP, 'scripts/qa.mjs'), 'start']);
  assert.ok(h.commands.filter(call => !['version', 'pull'].includes(call.phase)).every(call => call.command === process.execPath));
  assert.ok(h.commands.every(call => call.options.cwd === DAPP && call.options.detached === true && call.options.shell === false));
  assert.deepEqual(h.commands[0].options.stdio, ['ignore', 'pipe', 'inherit']);
  assert.ok(h.commands.slice(1).every(call => call.options.stdio === 'inherit'));
  assert.deepEqual(h.ports, [...fixedPorts, ...fixedPorts]);
  assert.equal(h.readiness[0].port, 9091); assert.equal(h.readiness[0].options.timeoutMs, 90000);
  // Every completed phase is reaped before the next process is started.
  for (let index = 0; index < 3; index++) assert.ok(h.events.indexOf(`stop:${h.children[index].pid}`) < h.events.indexOf(`spawn:${h.commands[index + 1].phase}`));
  assert.ok(h.events.indexOf(`stop:${h.children[4].pid}`) < h.events.indexOf('spawn:serve'));
  cleaned(h);
});

test('occupied ports, existing containers and wrong pnpm stop before preparation without touching existing services', async () => {
  for (const kind of ['port', 'container', 'pnpm']) {
    const h = harness(kind === 'pnpm' ? { version: '7.33.3\n' } : {});
    if (kind === 'port') h.deps.freePort = async port => { if (port === 9004) throw Error('occupied existing9004'); };
    if (kind === 'container') h.deps.dockerPreflight = async () => { throw Error('existing container was not removed'); };
    await assert.rejects(runQaUp(h.deps), /occupied|existing container|pnpm9.15.9/);
    assert.deepEqual(h.commands.map(call => call.phase), ['version']); cleaned(h);
  }
});

test('a port claimed during dependency preparation or image pull prevents SSRI/build startup', async () => {
  const h = harness(); let calls = 0;
  h.deps.freePort = async port => { calls++; if (calls > fixedPorts.length && port === 9091) throw Error('new foreign listener'); };
  await assert.rejects(runQaUp(h.deps), /foreign listener/);
  assert.deepEqual(h.commands.map(call => call.phase), ['version', 'prepare', 'pull']); cleaned(h);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  for (const target of ['preflight', 'prepare', 'pull', 'readiness', 'build', 'serve']) {
    test(`${signal} during ${target} stops only owned groups and cannot enter a later phase`, async () => {
      const h = harness({ onSpawn(key) { if (key === target) { h.signals.emit(signal); return false; } } });
      if (target === 'preflight') h.deps.dockerPreflight = () => { queueMicrotask(() => h.signals.emit(signal)); return new Promise(() => {}); };
      if (target === 'readiness') h.deps.waitPort = async () => { h.signals.emit(signal); };
      const result = await runQaUp(h.deps);
      assert.deepEqual(result, { stopped: true });
      const expectedLast = { preflight: 'version', prepare: 'prepare', pull: 'pull', readiness: 'ssri', build: 'build', serve: 'serve' }[target];
      assert.equal(h.commands.at(-1).phase, expectedLast);
      cleaned(h);
    });
  }
}

test('Docker preflight subprocesses are owned and cancellation of the first check cannot launch its second command', async () => {
  const h = harness({ onSpawn(key) { if (key === 'docker-preflight') { h.signals.emit('SIGINT'); return false; } } });
  h.deps.dockerPreflight = async run => { await run(['info', '--format', '{{.ServerVersion}}']); await run(['container', 'ls', '-a']); };
  assert.deepEqual(await runQaUp(h.deps), { stopped: true });
  assert.deepEqual(h.commands.map(call => call.phase), ['version', 'docker-preflight']);
  assert.equal(h.commands[1].options.detached, true); assert.equal(h.commands[1].options.shell, false);
  cleaned(h);
});

test('an SSRI process failure during build aborts the build and never starts the application', async () => {
  const h = harness({ onSpawn(key, _child, value) { if (key === 'build') { value.commands.find(call => call.phase === 'ssri').child.close(7); return false; } } });
  await assert.rejects(runQaUp(h.deps), /SSRI service exited unexpectedly/);
  assert.equal(h.commands.at(-1).phase, 'build');
  assert.ok(h.stopped.includes(h.commands.find(call => call.phase === 'build').child.pid)); cleaned(h);
});

test('build failure prevents serving and cleans its group together with the owned SSRI service', async () => {
  const h = harness({ onSpawn(key, child) { if (key === 'build') { child.close(2); return false; } } });
  await assert.rejects(runQaUp(h.deps), /QA build failed/);
  assert.equal(h.commands.at(-1).phase, 'build'); cleaned(h);
});

test('SSRI death during readiness or serving fails closed and cleans all launched groups', async () => {
  for (const at of ['readiness', 'serve']) {
    const h = harness({ onSpawn(key, _child, value) { if (at === 'serve' && key === 'serve') { value.commands.find(call => call.phase === 'ssri').child.close(8); return false; } } });
    if (at === 'readiness') h.deps.waitPort = async (_port, options) => { h.commands.find(call => call.phase === 'ssri').child.close(8); options.check(); };
    await assert.rejects(runQaUp(h.deps), /SSRI service exited unexpectedly/);
    assert.equal(h.commands.at(-1).phase, at === 'serve' ? 'serve' : 'ssri'); cleaned(h);
  }
});

test('oversized version output and spawn errors do not reach dependency installation', async () => {
  for (const failure of ['overflow', 'spawn']) {
    const h = harness({ onSpawn(key, child) { if (key === 'version') { if (failure === 'spawn') child.emit('error', Error('spawn failed')); else child.stdout.emit('data', Buffer.alloc(4097)); return false; } } });
    await assert.rejects(runQaUp(h.deps), /Version output|spawn failed/);
    assert.deepEqual(h.commands.map(call => call.phase), ['version']); cleaned(h);
  }
});

test('invalid Node/native Windows fails before signal registration or any spawned process', async () => {
  for (const change of [{ nodeVersion: '22.12.0' }, { platform: 'win32' }]) {
    const h = harness(); await assert.rejects(runQaUp({ ...h.deps, ...change }), /22.13|WSL/);
    assert.equal(h.children.length, 0); assert.equal(h.stopped.length, 0); assert.equal(h.signals.listenerCount('SIGINT'), 0);
  }
});

test('supervisor awaits cleanup of a completed group immediately instead of retaining its PID for later shutdown', async () => {
  const controller = new AbortController(), child = fakeChild(60001), entered = deferred(), release = deferred(), stopped = [];
  const owned = createOwnedSupervisor({ signal: controller.signal, spawnChild: () => child, stopGroup: async pid => { stopped.push(pid); entered.resolve(); await release.promise; } });
  const state = owned.start('completed phase', 'fixture', []), waiting = owned.wait(state); let returned = false;
  waiting.then(() => { returned = true; }); child.close(0); await entered.promise;
  assert.equal(returned, false); assert.deepEqual(stopped, [60001]);
  release.resolve(); await waiting; await owned.stopAll(); assert.deepEqual(stopped, [60001]);
});

test('a signal during completed version-group retirement cannot begin port checks or the next phase', async () => {
  const h = harness({ onStop(pid, value) { if (pid === value.children[0].pid) value.signals.emit('SIGINT'); } });
  assert.deepEqual(await runQaUp(h.deps), { stopped: true });
  assert.deepEqual(h.commands.map(call => call.phase), ['version']); assert.deepEqual(h.ports, []);
  assert.equal(h.events.includes('preflight'), false); cleaned(h);
});

test('one failed owned-group cleanup does not finish shutdown before other owned groups settle', async () => {
  const controller = new AbortController(), release = deferred(), entered = deferred(), children = [fakeChild(60011), fakeChild(60012)];
  const stopped = [], owned = createOwnedSupervisor({ signal: controller.signal, spawnChild: () => children.shift(), stopGroup: async pid => {
    stopped.push(pid); if (pid === 60011) throw Error('first owned cleanup failed'); entered.resolve(); await release.promise;
  } });
  owned.start('first service', 'fixture', []); owned.start('second service', 'fixture', []);
  let finished = false; const stopping = owned.stopAll(); stopping.then(() => { finished = true; }, () => { finished = true; });
  await entered.promise; await tick(); assert.equal(finished, false); assert.deepEqual(stopped, [60011, 60012]);
  release.resolve(); await assert.rejects(stopping, /first owned cleanup failed/);
});

test('group cleanup targets only its negative spawned PGID, handles missing groups and escalates a stuck owned group', async () => {
  const calls = []; let exists = true, clock = 0;
  await stopOwnedGroup(60002, { now: () => clock, pause: async ms => { clock += ms; }, kill(pid, signal) { calls.push([pid, signal]); if (!exists) throw Object.assign(Error('gone'), { code: 'ESRCH' }); if (signal === 'SIGKILL') exists = false; } });
  assert.ok(calls.every(([pid]) => pid === -60002)); assert.equal(calls.filter(([, signal]) => signal === 'SIGTERM').length, 1); assert.equal(calls.filter(([, signal]) => signal === 'SIGKILL').length, 1); assert.ok(clock >= 10000);
  let missing = 0; await stopOwnedGroup(60003, { kill() { missing++; throw Object.assign(Error('gone'), { code: 'ESRCH' }); } }); assert.equal(missing, 1);
  await stopOwnedGroup(undefined, { kill() { assert.fail('invalid PID must not signal'); } });
  await assert.rejects(stopOwnedGroup(60004, { kill() { throw Object.assign(Error('denied'), { code: 'EPERM' }); } }), /denied/);
});

test('CLI plans/help never execute and profiles/ports/endpoints cannot be overridden', async () => {
  let runs = 0; const run = async () => { runs++; return 'ran'; }, old = console.log; console.log = () => {};
  try {
    await main(['--plan'], run); await main(['--help'], run); assert.equal(runs, 0);
    for (const args of [['--port', '1'], ['--profile', 'foreign'], ['--network', 'mainnet'], ['--send'], ['--endpoint', 'https://foreign.invalid']]) await assert.rejects(main(args, run), /cannot be overridden/);
    assert.equal(runs, 0); assert.equal(await main([], run), 'ran'); assert.equal(runs, 1);
  } finally { console.log = old; }
});

test('real Unix cleanup ends the owned parent/grandchild group while leaving an unrelated isolated group alive', { skip: !['darwin', 'linux'].includes(process.platform), timeout: 20000 }, async t => {
  const code = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.on('SIGTERM',()=>{c.once('exit',()=>process.exit(0));c.kill('SIGTERM')});process.stdout.write(String(c.pid)+'\\n');setInterval(()=>{},1000);`;
  const owned = realSpawn(process.execPath, ['-e', code], { detached: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
  const unrelated = realSpawn(process.execPath, ['-e', "process.stdout.write('ready\\n');setInterval(()=>{},1000)"], { detached: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(async () => { await Promise.all([stopOwnedGroup(owned.pid), stopOwnedGroup(unrelated.pid)]); });
  const ownClosed = once(owned, 'close'), otherClosed = once(unrelated, 'close');
  const [[message]] = await Promise.all([once(owned.stdout, 'data'), once(unrelated.stdout, 'data')]);
  const grandchild = Number(message.toString().trim()); assert.ok(Number.isInteger(grandchild) && grandchild > 0);
  assert.doesNotThrow(() => process.kill(grandchild, 0));
  await stopOwnedGroup(owned.pid); await ownClosed;
  assert.throws(() => process.kill(-owned.pid, 0), error => error.code === 'ESRCH');
  assert.throws(() => process.kill(grandchild, 0), error => error.code === 'ESRCH');
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  await stopOwnedGroup(unrelated.pid); await otherClosed;
});
