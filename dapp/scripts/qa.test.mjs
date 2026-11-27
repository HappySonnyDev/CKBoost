import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createQaLauncher, main, netlifyCommand, qaPaths, requireSupportedNode, QA_PROFILE_HASH, QA_PROTOCOL_HASH, PORTS } from './qa.mjs';
import * as runtime from '../lib/ckb/isolated-runtime.mjs';
import { QA_DEFAULT_PROFILE, QA_BASE_PROFILE_HASH } from './qa-profile.mjs';

const publicProfile = JSON.parse(await fs.readFile(new URL(`../${QA_DEFAULT_PROFILE.file}`, import.meta.url), 'utf8'));
const baseProfile = JSON.parse(await fs.readFile(new URL('../config/qa/ckboost-testnet.json', import.meta.url), 'utf8'));
const serialize = value => `${JSON.stringify(value, null, 2)}\n`;

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ckboost-portable-qa-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  // Paths deliberately exercise spaces, apostrophes and shell metacharacters.
  const dappDirectory = path.join(directory, "another user's checkout $(literal)", 'dapp');
  const paths = qaPaths(dappDirectory);
  const files = [paths.profile, paths.next,
    path.join(dappDirectory, '../packages/ssri-ckboost/dist/index.js'),
    path.join(dappDirectory, '../packages/ssri-ckboost/dist/generated/ckboost.js'),
    path.join(dappDirectory, '../packages/ssri-ckboost/dist/logging/index.js'),
    path.join(dappDirectory, 'node_modules/ckb-claimable-pool-lock/dist/index.js'),
    path.join(dappDirectory, 'public/tinymce/tinymce.min.js')];
  await Promise.all(files.map(async file => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, file === paths.profile ? serialize(publicProfile) : '// dependency fixture\n'); }));
  await fs.mkdir(paths.functions, { recursive: true });
  const calls = [], ports = [], opens = [];
  let checks = 0, loads = 0, failBuild = false;
  const io = { ...fs, open: async (...args) => { opens.push(args[0]); return fs.open(...args); } };
  const runner = async (command, args, cwd, env) => {
    calls.push({ command, args: [...args], cwd, env: { ...env } });
    if (args[1] === 'build') {
      if (failBuild) throw new Error('simulated failed build');
      await fs.mkdir(paths.dist, { recursive: true });
      await fs.writeFile(path.join(paths.dist, 'BUILD_ID'), 'fixture-build-id\n');
    }
  };
  const launcher = createQaLauncher({ dappDirectory, io, runner,
    runtimeLoader: async () => { loads++; return runtime; },
    ssriReady: async () => { checks++; }, freePort: async port => { ports.push(port); },
    nodeVersion: '22.19.0', nodeExecutable: '/portable/node', ...options });
  return { launcher, paths, calls, ports, opens, io, runner,
    get checks() { return checks; }, get loads() { return loads; },
    failBuild() { failBuild = true; } };
}

test('plan uses the verified public profile without writes, spawning or socket checks', async t => {
  const f = await fixture(t), value = await f.launcher.plan();
  assert.equal(value.summary.profileHash, QA_PROFILE_HASH);
  assert.equal(value.summary.protocolTypeHash, QA_PROTOCOL_HASH);
  assert.equal(value.summary.networkChecks, false);
  assert.equal(value.summary.filesWritten, false);
  assert.equal(value.summary.processesStarted, false);
  assert.equal(value.summary.setupEnabled, false);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.ports, []);
  assert.equal(f.checks, 0);
  assert.deepEqual(f.opens, [f.paths.profile]);
  assert.equal(path.basename(f.paths.local), `published-${QA_PROFILE_HASH.slice(2)}`);
  await assert.rejects(fs.stat(f.paths.local), { code: 'ENOENT' });
  assert.match(value.summary.publicNetworkBoundary, /shared public Testnet.*shared Nostr/);
});

test('generated Netlify paths are portable and the shell command contains no checkout interpolation', async t => {
  const f = await fixture(t), value = await f.launcher.plan();
  assert.match(value.toml, /command = "node \.\.\/\.\.\/scripts\/qa\.mjs next"/);
  assert.ok(value.toml.includes(`directory = ${JSON.stringify(f.paths.functions)}`));
  assert.ok(!value.toml.includes('exec '));
  assert.ok(!value.toml.includes('cd '));
  const command = netlifyCommand(f.paths);
  assert.equal(command.command, 'pnpm');
  assert.equal(command.cwd, f.paths.local);
  assert.deepEqual(command.args.slice(0, 4), ['--package=netlify-cli@27.20.0', 'dlx', 'netlify', 'dev']);
  for (const argument of ['--offline', '--no-open', '--internal-disable-edge-functions']) assert.ok(command.args.includes(argument));
  assert.equal(command.args[command.args.indexOf('--functions') + 1], f.paths.functions);
  assert.equal(command.args[command.args.indexOf('--cwd') + 1], f.paths.local);
  assert.match(value.toml, /from = "\/api\/verification\/\*"/);
});

test('public environment is fixed to QA scope, setup disabled and Organizer authorization enabled', async t => {
  const f = await fixture(t), { env, config } = await f.launcher.plan();
  assert.equal(env.CKBOOST_ISOLATED_QA, '1');
  assert.equal(env.NEXT_PUBLIC_CKBOOST_ISOLATED_QA, '1');
  assert.equal(env.NEXT_PUBLIC_CKB_NETWORK, 'testnet');
  assert.equal(env.NEXT_PUBLIC_PROTOCOL_TYPE_ARGS, config.protocol.typeScript.args);
  assert.equal(env.NEXT_PUBLIC_CKB_RPC_URL, 'https://testnet.ckbapp.dev/');
  assert.equal(env.NEXT_PUBLIC_SSRI_EXECUTOR_URL, 'http://127.0.0.1:9091/');
  assert.equal(env.CKBOOST_ENABLE_TESTNET_SETUP, '0');
  assert.equal(env.NODE_ENV, 'production');
  assert.equal(env.NEXT_PUBLIC_CKBOOST_ORGANIZER_AUTH_LOCK_HASHES, '0xe91b5a78463c293318331c21d372e031eb9ffad87b379fbe0563222fcdd28815');
  assert.equal(env.CKBOOST_NEXT_DIST_DIR, '.next-isolated-4faf44b759bb');
  assert.equal(config.sources.adminParentProfileHash, QA_BASE_PROFILE_HASH);
  assert.equal(JSON.parse(env.NEXT_PUBLIC_CKBOOST_ADMIN_REGISTRY).protocolTypeHash, QA_PROTOCOL_HASH);
  assert.equal(JSON.parse(env.NEXT_PUBLIC_CKBOOST_ADMIN_TIPPING).registryTypeHash, '0x97e23b14d33e0445c1eac09f1948e2c3652547bfbb7fb7db56978f48baff9690');
  assert.deepEqual(JSON.parse(env.NEXT_PUBLIC_CKBOOST_ISOLATED_RUNTIME_PROFILE), config);
  assert.deepEqual(JSON.parse(env.NEXT_PUBLIC_CKBOOST_CURRENT_DEPLOYMENTS), config.current);
});

test('missing prepared dependency fails before importing runtime or creating local state', async t => {
  const f = await fixture(t);
  await fs.rm(path.join(f.paths.dapp, '../packages/ssri-ckboost/dist/index.js'));
  await assert.rejects(f.launcher.plan(), /qa:prepare.*No existing deployment or default profile/);
  assert.equal(f.loads, 0);
  assert.deepEqual(f.calls, []);
  await assert.rejects(fs.stat(f.paths.local), { code: 'ENOENT' });
});

test('missing or tampered profile has no default or historical deployment fallback', async t => {
  const f = await fixture(t);
  // A valid base file remains present, but missing v4 must never select it.
  await fs.writeFile(path.join(f.paths.dapp, 'config/qa/ckboost-testnet.json'), serialize(baseProfile));
  await fs.rm(f.paths.profile);
  await assert.rejects(f.launcher.plan(), /public QA profile.*No fallback/);
  const tampered = structuredClone(publicProfile);
  tampered.current.testnet.ckboostUserType.typeHash = `0x${'11'.repeat(32)}`;
  await fs.writeFile(f.paths.profile, serialize(tampered));
  await assert.rejects(f.launcher.plan(), /runtime|profile|match|effective/i);
  assert.deepEqual(f.calls, []);
  await assert.rejects(fs.stat(f.paths.local), { code: 'ENOENT' });
});

test('same-hash local Admin selection cannot overwrite published launcher metadata', async t => {
  const f = await fixture(t), selected = qaPaths(f.paths.dapp, QA_PROFILE_HASH, '/local/selection.json', true);
  assert.notEqual(f.paths.local, selected.local);
  assert.notEqual(f.paths.receipt, selected.receipt);
  assert.equal(f.paths.dist, selected.dist);
  await f.launcher.plan();
  assert.deepEqual(f.calls, []);
});

test('valid ancestral v2 and v3 runtimes cannot replace the published v4 release', async t => {
  const f = await fixture(t);
  const original = runtime.makeIsolatedRuntimeConfig(publicProfile.sources.protocolManifest, publicProfile.sources.protocolCodeManifest, publicProfile.sources.campaignCodeManifest, publicProfile.sources.profile);
  const v2 = runtime.makeIndependentUserRuntimeConfig(original, publicProfile.sources.userCodeDeploymentManifest);
  await fs.writeFile(f.paths.profile, serialize(v2));
  await assert.rejects(f.launcher.plan(), /no fallback/);
  await fs.writeFile(f.paths.profile, serialize(baseProfile));
  await assert.rejects(f.launcher.plan(), /no fallback/);
  assert.deepEqual(f.calls, []);
});

test('missing SSRI and occupied ports stop before build state or process creation', async t => {
  const missing = await fixture(t, { ssriReady: async () => { throw new Error('local SSRI unavailable'); } });
  await assert.rejects(missing.launcher.build(), /SSRI unavailable/);
  await assert.rejects(fs.stat(missing.paths.local), { code: 'ENOENT' });
  assert.deepEqual(missing.calls, []);
  const occupied = await fixture(t, { freePort: async port => { if (port === PORTS.browser) throw new Error('Port 9004 occupied; no process stopped'); } });
  await assert.rejects(occupied.launcher.build(), /Port 9004 occupied/);
  assert.deepEqual(occupied.calls, []);
  await assert.rejects(fs.stat(occupied.paths.local), { code: 'ENOENT' });
});

test('check performs only injected local readiness checks and never generates files', async t => {
  const f = await fixture(t), value = await f.launcher.check();
  assert.equal(value.ready, true);
  assert.match(value.networkChecks, /no RPC/);
  assert.equal(f.checks, 1);
  assert.deepEqual(f.ports, [9004, 9005, 9994]);
  assert.deepEqual(f.calls, []);
  await assert.rejects(fs.stat(f.paths.local), { code: 'ENOENT' });
});

test('build and start share exactly the same public environment and retain project cwd', async t => {
  const f = await fixture(t);
  await f.launcher.build();
  const receipt = JSON.parse(await fs.readFile(f.paths.receipt, 'utf8'));
  assert.equal(receipt.buildId, 'fixture-build-id');
  assert.equal(receipt.profileHash, QA_PROFILE_HASH);
  assert.equal(receipt.projectDirectory, f.paths.dapp);
  assert.deepEqual(JSON.parse(await fs.readFile(f.paths.runtime, 'utf8')), publicProfile);
  await f.launcher.start();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0].args, [f.paths.next, 'build', f.paths.dapp, '--webpack']);
  assert.equal(f.calls[0].cwd, f.paths.dapp);
  assert.equal(f.calls[1].cwd, f.paths.local);
  assert.deepEqual(f.calls[0].env, f.calls[1].env);
  assert.deepEqual(receipt.publicEnvironment, f.calls[0].env);
  assert.deepEqual(JSON.parse(await fs.readFile(f.paths.environment, 'utf8')), f.calls[0].env);
  assert.ok(f.paths.local.startsWith(`${f.paths.dapp}${path.sep}`));
});

test('internal Next entry validates the receipt and starts from dapp using only its own free port', async t => {
  const f = await fixture(t);
  await f.launcher.build();
  f.ports.length = 0;
  await f.launcher.next();
  assert.deepEqual(f.ports, [9005]);
  assert.equal(f.calls[1].command, '/portable/node');
  assert.deepEqual(f.calls[1].args, [f.paths.next, 'start', f.paths.dapp, '--port', '9005', '--hostname', '127.0.0.1']);
  assert.equal(f.calls[1].cwd, f.paths.dapp);
  assert.deepEqual(f.calls[1].env, f.calls[0].env);
});

test('start rejects stale BUILD_ID, modified environment and missing QA artifacts before spawning', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.paths.dapp, '.next'), { recursive: true });
  await fs.writeFile(path.join(f.paths.dapp, '.next/BUILD_ID'), 'legacy-build');
  await assert.rejects(f.launcher.start(), /qa:build/);
  assert.deepEqual(f.calls, []);
  await f.launcher.build();
  await fs.writeFile(path.join(f.paths.dist, 'BUILD_ID'), 'different-build');
  await assert.rejects(f.launcher.start(), /identical profile, environment, checkout and BUILD_ID/);
  await fs.writeFile(path.join(f.paths.dist, 'BUILD_ID'), 'fixture-build-id');
  const env = JSON.parse(await fs.readFile(f.paths.environment, 'utf8'));
  env.NEXT_PUBLIC_CKB_RPC_URL = 'https://example.invalid/';
  await fs.writeFile(f.paths.environment, serialize(env));
  await assert.rejects(f.launcher.start(), /Build\/start QA profile, public environment or checkout paths differ/);
  assert.equal(f.calls.length, 1);
});

test('a failed rebuild invalidates the successful build receipt', async t => {
  const f = await fixture(t);
  await f.launcher.build();
  f.failBuild();
  await assert.rejects(f.launcher.build(), /simulated failed build/);
  await assert.rejects(fs.stat(f.paths.receipt), { code: 'ENOENT' });
  await assert.rejects(f.launcher.start(), /No successful QA build receipt.*qa:build/);
  assert.equal(f.calls.length, 2);
});

test('v4 capability keys cannot enter by the legacy empty-key migration', async t => {
  const f = await fixture(t); await f.launcher.build();
  const current = JSON.parse(await fs.readFile(f.paths.environment, 'utf8')), old = { ...current };
  delete old.NEXT_PUBLIC_CKBOOST_ADMIN_REGISTRY; delete old.NEXT_PUBLIC_CKBOOST_ADMIN_TIPPING;
  await fs.writeFile(f.paths.environment, serialize(old));
  const receipt = await fs.readFile(f.paths.receipt, 'utf8');
  await assert.rejects(f.launcher.build(), /Only the exact v3 addition/);
  assert.deepEqual(JSON.parse(await fs.readFile(f.paths.environment, 'utf8')), old);
  assert.notEqual(current.NEXT_PUBLIC_CKBOOST_ADMIN_REGISTRY, ''); assert.notEqual(current.NEXT_PUBLIC_CKBOOST_ADMIN_TIPPING, '');
  assert.equal(await fs.readFile(f.paths.receipt, 'utf8'), receipt);
  assert.equal(f.calls.length, 1);
});

test('legacy environment migration rejects any other public value change and leaves old metadata intact', async t => {
  const f = await fixture(t); await f.launcher.build();
  const old = JSON.parse(await fs.readFile(f.paths.environment, 'utf8'));
  delete old.NEXT_PUBLIC_CKBOOST_ADMIN_REGISTRY; delete old.NEXT_PUBLIC_CKBOOST_ADMIN_TIPPING;
  old.NEXT_PUBLIC_CKB_RPC_URL = 'https://another.invalid/';
  const previous = serialize(old), receipt = await fs.readFile(f.paths.receipt, 'utf8'); await fs.writeFile(f.paths.environment, previous);
  await assert.rejects(f.launcher.build(), /Only the exact v3 addition/);
  assert.equal(await fs.readFile(f.paths.environment, 'utf8'), previous); assert.equal(await fs.readFile(f.paths.receipt, 'utf8'), receipt);
  assert.equal(f.calls.length, 1);
});

test('Node version and command parsing reject unsupported or override invocations', async () => {
  for (const version of ['20.19.0', '22.12.9', 'invalid']) assert.throws(() => requireSupportedNode(version), /Node.js 22.13/);
  for (const version of ['22.13.0', '22.19.0', '24.0.0']) assert.doesNotThrow(() => requireSupportedNode(version));
  let called = false;
  const launcher = { plan: async () => { called = true; return { summary: { offline: true } }; } };
  await assert.rejects(main(['build', '--profile', '/tmp/arbitrary.json'], launcher), /cannot be overridden/);
  await assert.rejects(main(['deploy'], launcher), /Usage/);
  assert.equal(called, false);
});
