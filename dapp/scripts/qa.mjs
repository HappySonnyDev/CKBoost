#!/usr/bin/env node
// Explicit local QA only. No dotenv, key, RPC, signing, deployment or process
// discovery/termination API. Runtime paths derive from this checkout.
import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { QA_DEFAULT_PROFILE, QA_BASE_PROFILE_HASH, QA_PROFILE_PROTOCOL_HASH, validateQaPublishedRuntime } from './qa-profile.mjs';

export { QA_BASE_PROFILE_HASH } from './qa-profile.mjs';
export const QA_PROFILE_HASH = QA_DEFAULT_PROFILE.profileHash;
export const QA_PROTOCOL_HASH = QA_PROFILE_PROTOCOL_HASH;
export const NETLIFY_CLI_VERSION = '27.20.0';
export const PORTS = Object.freeze({ browser: 9004, next: 9005, functions: 9994 });
const APP_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREPARE = 'Install the checkout dependencies and run pnpm run qa:prepare from dapp, then retry. No existing deployment or default profile will be used.';
const assert = (value, message) => { if (!value) throw new Error(message); };
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const inside = (candidate, directory) => candidate === directory || candidate.startsWith(`${directory}${path.sep}`);

export function requireSupportedNode(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  assert(major > 22 || (major === 22 && minor >= 13), 'QA requires Node.js 22.13 or newer, matching pinned Netlify CLI 27.20.0.');
}
export function qaEnvironment(config, runtime) {
  const env = runtime.isolatedRuntimeEnvironment(config);
  return { ...env,
    NEXT_PUBLIC_CKBOOST_ORGANIZER_AUTH_LOCK_HASHES: config.current.testnet.ckboostProtocolLock.typeHash,
    CKBOOST_ENABLE_TESTNET_SETUP: '0', NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1', NETLIFY_TELEMETRY_DISABLED: '1', BROWSER: 'none',
    NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1',
  };
}
export function qaPaths(dappDirectory = APP_DIRECTORY, profileHash = QA_PROFILE_HASH, profileFile, adminProfile = false) {
  assert(/^0x[0-9a-f]{64}$/.test(profileHash), 'A validated complete profile hash is required for local QA paths.');
  // A local release selection and the published default can have the same
  // profile hash but different internal Netlify commands. Keep their metadata
  // and receipts separate while both retain the exact profile-derived dist.
  const dapp = path.resolve(dappDirectory), local = path.join(dapp, '.qa-local', `${adminProfile ? '' : 'published-'}${profileHash.slice(2)}`);
  return { dapp, profile: profileFile ?? path.join(dapp, QA_DEFAULT_PROFILE.file), local, ...(adminProfile ? { adminProfile: true } : {}),
    runtime: path.join(local, 'runtime-config.json'), environment: path.join(local, 'process-env.json'),
    netlify: path.join(local, 'netlify.toml'), receipt: path.join(local, 'built-profile.json'),
    next: path.join(dapp, 'node_modules/next/dist/bin/next'), functions: path.join(dapp, 'netlify/functions'),
    dist: path.join(dapp, `.next-isolated-${profileHash.slice(2, 14)}`),
  };
}
export function netlifyConfiguration(paths) {
  // The generated directory is dapp/.qa-local/<hash>. This fixed relative
  // command has no checkout path to interpolate into a platform shell.
  const command = paths.adminProfile ? 'node ../../scripts/qa-admin.mjs next' : 'node ../../scripts/qa.mjs next';
  const routes = ['telegram-authenticate', 'resolve-lock-script', 'achievement-validate', 'achievement-query', 'streakBonus-query', 'streakBonus-validate', 'staff-approve-submissions', 'vellum-quest-claim', 'social-interactions', 'update-tipping-comments'];
  return `[functions]\ndirectory = ${JSON.stringify(paths.functions)}\n\n[dev]\ncommand = ${JSON.stringify(command)}\nframework = "#custom"\ntargetPort = ${PORTS.next}\nport = ${PORTS.browser}\nfunctionsPort = ${PORTS.functions}\nautoLaunch = false\npublish = "."\n\n` +
    routes.map(name => `[[redirects]]\nfrom = "/api/${name}"\nto = "/.netlify/functions/${name}"\nstatus = 200\n`).join('\n') +
    '\n[[redirects]]\nfrom = "/api/verification/*"\nto = "/.netlify/functions/verification-api/:splat"\nstatus = 200\n';
}
export function netlifyCommand(paths) {
  return { command: 'pnpm', args: [`--package=netlify-cli@${NETLIFY_CLI_VERSION}`, 'dlx', 'netlify', 'dev', '--cwd', paths.local, '--functions', paths.functions, '--offline', '--no-open', '--skip-gitignore', '--internal-disable-edge-functions', '--framework', '#custom', '--port', String(PORTS.browser), '--target-port', String(PORTS.next), '--functions-port', String(PORTS.functions)], cwd: paths.local };
}

async function readJson(file, io) {
  const handle = await io.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    assert(stat.isFile() && stat.size > 0 && stat.size <= 250_000, `Expected a bounded public QA JSON file: ${path.basename(file)}`);
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}
export function checkSsriTcp() {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: 9091 });
    let settled = false;
    const done = error => { if (settled) return; settled = true; socket.destroy(); error ? reject(error) : resolve(); };
    socket.setTimeout(1500, () => done(new Error('The local compatible SSRI service at 127.0.0.1:9091 is unavailable. Run node scripts/ssri-qa.mjs start in another terminal first.')));
    socket.once('connect', () => done());
    socket.once('error', () => done(new Error('The local compatible SSRI service at 127.0.0.1:9091 is unavailable. Run node scripts/ssri-qa.mjs start in another terminal first.')));
  });
}
export function requireFreePort(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(`Port ${port} is already in use. No existing process was stopped; close the service you own before starting another QA instance.`)));
    server.listen(port, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve()));
  });
}
export function runChild(command, args, cwd, publicEnvironment) {
  return new Promise((resolve, reject) => {
    // Ambient variables are passed opaquely. Only derived public QA values are
    // inspected/persisted, and they override inherited network/profile values.
    const child = spawn(command, args, { cwd, env: { ...process.env, ...publicEnvironment }, stdio: 'inherit', shell: false });
    const onInt = () => child.kill('SIGINT'), onTerm = () => child.kill('SIGTERM');
    const remove = () => { process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm); };
    process.once('SIGINT', onInt); process.once('SIGTERM', onTerm);
    child.once('error', error => { remove(); reject(error); });
    child.once('close', (code, signal) => { remove(); code === 0 ? resolve() : reject(new Error(`The QA child exited ${code ?? signal}.`)); });
  });
}

/** Injectable side effects are for focused offline tests. CLI users cannot
 * override the root, profile, code pins, endpoints, ports or process command. */
export function createQaLauncher({ dappDirectory = APP_DIRECTORY, io = fs, runner = runChild, ssriReady = checkSsriTcp, freePort = requireFreePort, nodeExecutable = process.execPath, nodeVersion = process.versions.node, runtimeLoader, adminProfile = false } = {}) {
  let paths = qaPaths(dappDirectory);
  async function dependencyCheck() {
    const required = [paths.next, path.resolve(paths.dapp, '../packages/ssri-ckboost/dist/index.js'), path.resolve(paths.dapp, '../packages/ssri-ckboost/dist/generated/ckboost.js'), path.resolve(paths.dapp, '../packages/ssri-ckboost/dist/logging/index.js'), path.join(paths.dapp, 'node_modules/ckb-claimable-pool-lock/dist/index.js'), path.join(paths.dapp, 'public/tinymce/tinymce.min.js')];
    const missing = [];
    await Promise.all(required.map(async file => { try { await io.access(file); } catch { missing.push(path.relative(paths.dapp, file)); } }));
    assert(missing.length === 0, `QA dependencies are not prepared: ${missing.join(', ')}. ${PREPARE}`);
    await io.access(paths.functions);
  }
  async function plan() {
    requireSupportedNode(nodeVersion);
    await dependencyCheck();
    let profile;
    const profileFile = adminProfile ? path.join(paths.dapp, '.qa-local/admin-upgrade/active-runtime.json') : paths.profile;
    try { profile = await readJson(profileFile, io); }
    catch (cause) { throw new Error(`${adminProfile ? 'No explicitly selected confirmed Admin v4 profile exists. Run qa-admin confirm, then qa-admin activate.' : `The committed public QA profile ${QA_DEFAULT_PROFILE.file} could not be loaded.`} No fallback is allowed. ${cause.message}`); }
    let runtime;
    try { runtime = await (runtimeLoader ? runtimeLoader() : import(pathToFileURL(path.join(paths.dapp, 'lib/ckb/isolated-runtime.mjs')).href)); }
    catch (cause) { throw new Error(`QA runtime dependencies could not be loaded. ${PREPARE} ${cause.message}`); }
    const config = adminProfile ? runtime.validateIsolatedRuntimeConfig(profile) : validateQaPublishedRuntime(QA_DEFAULT_PROFILE, profile, runtime);
    if (adminProfile) {
      assert(config.schema === 'ckboost-isolated-testnet-runtime/v4' && config.sources.adminParentProfileHash === QA_BASE_PROFILE_HASH && config.protocol.typeHash === QA_PROTOCOL_HASH, 'Only an independently confirmed Admin v4 profile derived from the exact 129c parent may be selected. No default fallback is permitted.');
      paths = qaPaths(dappDirectory, config.profileHash, profileFile, true);
    }
    const env = qaEnvironment(config, runtime), toml = netlifyConfiguration(paths);
    return { paths, config, env, toml, summary: { schema: 'ckboost-portable-qa-plan/v1', mode: 'explicit-testnet-qa', profileFile: paths.profile, profileHash: config.profileHash, protocolTypeHash: config.protocol.typeHash, userTypeCodeHash: config.current.testnet.ckboostUserType.typeHash, projectDirectory: paths.dapp, localDirectory: paths.local, distDir: env.CKBOOST_NEXT_DIST_DIR, rpcUrl: config.rpcUrl, executorUrl: config.executorUrl, ports: PORTS, browserUrl: 'http://localhost:9004/revamp', netlifyCliVersion: NETLIFY_CLI_VERSION, setupEnabled: false, ssriRequirement: 'Run node scripts/ssri-qa.mjs start separately. check/build/start require TCP reachability at 127.0.0.1:9091; that check does not prove executor compatibility or code-cell liveness.', publicNetworkBoundary: 'This profile scopes shared public Testnet state and shared Nostr relays; it is not a private chain or a separate relay service.', filesWritten: false, processesStarted: false, networkChecks: false } };
  }
  async function preflight(value) {
    await ssriReady();
    await Promise.all(Object.values(PORTS).map(port => freePort(port)));
    return { ...value.summary, ready: true, networkChecks: 'local TCP and free-port checks only; no RPC' };
  }
  async function writeSame(file, content) {
    try { await io.writeFile(file, content, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; assert(await io.readFile(file, 'utf8') === content, `Generated QA file differs: ${path.basename(file)}. Review/remove only this checkout's .qa-local profile files and rebuild.`); }
  }
  async function writePublicEnvironment(value) {
    const content = json(value.env);
    try { await io.writeFile(paths.environment, content, { flag: 'wx', mode: 0o600 }); return; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    // One compatibility migration only: older v3 metadata predates the two
    // explicit empty capability keys. Every preexisting value must otherwise
    // be identical. A v4/nonempty capability can never enter via this path.
    const handle = await io.open(paths.environment, constants.O_RDONLY | constants.O_NOFOLLOW);
    let existing;
    try { const stat = await handle.stat(); assert(stat.isFile() && stat.size > 0 && stat.size <= 250_000, 'Invalid existing public environment metadata.'); existing = await handle.readFile('utf8'); }
    finally { await handle.close(); }
    if (existing === content) return;
    let old;
    try { old = JSON.parse(existing); } catch { throw new Error('Generated QA file differs: process-env.json. Inspect it and rebuild; no fallback is allowed.'); }
    const keys = ['NEXT_PUBLIC_CKBOOST_ADMIN_REGISTRY', 'NEXT_PUBLIC_CKBOOST_ADMIN_TIPPING'];
    const migrated = old && typeof old === 'object' && !Array.isArray(old) && keys.every(key => !Object.hasOwn(old, key) && value.env[key] === '') && canonical({ ...old, ...Object.fromEntries(keys.map(key => [key, ''])) }) === canonical(value.env);
    assert(migrated && value.config.schema === 'ckboost-isolated-testnet-runtime/v3' && value.config.profileHash === QA_BASE_PROFILE_HASH, 'Generated QA file differs: process-env.json. Only the exact v3 addition of two empty capability keys may migrate automatically.');
    const temporary = `${paths.environment}.migration-${process.pid}-${Date.now()}`;
    try {
      await io.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
      await io.rm(paths.receipt, { force: true });
      await io.rename(temporary, paths.environment);
    } finally { await io.rm(temporary, { force: true }); }
  }
  async function generate(value) {
    await io.mkdir(paths.local, { recursive: true, mode: 0o700 });
    assert(inside(await io.realpath(paths.local), await io.realpath(paths.dapp)), 'Generated QA directory must stay inside this checkout.');
    await writeSame(paths.runtime, json(value.config));
    await writePublicEnvironment(value);
    await writeSame(paths.netlify, value.toml);
  }
  async function validateGenerated(value) {
    let savedConfig, savedEnv, toml;
    try { [savedConfig, savedEnv, toml] = await Promise.all([readJson(paths.runtime, io), readJson(paths.environment, io), io.readFile(paths.netlify, 'utf8')]); }
    catch { throw new Error('This checkout has no matching QA build metadata. Run pnpm run qa:build first.'); }
    assert(canonical(savedConfig) === canonical(value.config) && canonical(savedEnv) === canonical(value.env) && toml === value.toml, 'Build/start QA profile, public environment or checkout paths differ. Rebuild this checkout; no fallback is permitted.');
  }
  async function validateBuild(value) {
    await validateGenerated(value);
    let receipt;
    try { receipt = await readJson(paths.receipt, io); }
    catch { throw new Error('No successful QA build receipt exists. Run pnpm run qa:build first.'); }
    const buildId = (await io.readFile(path.join(paths.dist, 'BUILD_ID'), 'utf8')).trim();
    assert(receipt.schema === 'ckboost-portable-qa-build/v1' && receipt.profileHash === value.config.profileHash && receipt.projectDirectory === paths.dapp && receipt.nodeExecutable === nodeExecutable && canonical(receipt.publicEnvironment) === canonical(value.env) && receipt.buildId === buildId, 'QA build and start must use the identical profile, environment, checkout and BUILD_ID. Rebuild instead of using a default/old build.');
  }
  return {
    get paths() { return paths; }, plan,
    async check() { return preflight(await plan()); },
    async build() {
      const value = await plan(); await preflight(value); await generate(value);
      // An unsuccessful rebuild must not leave an old successful receipt.
      await io.rm(paths.receipt, { force: true });
      await runner(nodeExecutable, [paths.next, 'build', paths.dapp, '--webpack'], paths.dapp, value.env);
      const buildId = (await io.readFile(path.join(paths.dist, 'BUILD_ID'), 'utf8')).trim();
      assert(buildId.length > 0 && buildId.length < 1024, 'Next did not produce a valid QA BUILD_ID; no successful receipt was recorded.');
      await io.writeFile(paths.receipt, json({ schema: 'ckboost-portable-qa-build/v1', profileHash: value.config.profileHash, projectDirectory: paths.dapp, nodeExecutable, publicEnvironment: value.env, buildId }), { flag: 'wx', mode: 0o600 });
      return { ...value.summary, built: true, filesWritten: true, processesStarted: 'one completed local Next build', receipt: paths.receipt };
    },
    async start() {
      const value = await plan(); await validateBuild(value);
      await preflight(value);
      const command = netlifyCommand(paths); await runner(command.command, command.args, command.cwd, value.env);
      return { ...value.summary, started: true };
    },
    // Netlify's fixed command above invokes this internal entry. Revalidation
    // prevents it from becoming an escape hatch to a default or stale build.
    async next() {
      const value = await plan(); await validateBuild(value);
      await ssriReady(); await freePort(PORTS.next);
      await runner(nodeExecutable, [paths.next, 'start', paths.dapp, '--port', String(PORTS.next), '--hostname', '127.0.0.1'], paths.dapp, value.env);
      return { ...value.summary, nextExited: true };
    },
  };
}

export async function main(argv = process.argv.slice(2), launcher = createQaLauncher()) {
  assert(argv.length <= 1, 'Usage: node scripts/qa.mjs plan|check|build|start. Profile, endpoints and ports cannot be overridden.');
  const action = argv[0] ?? 'plan';
  assert(['plan', 'check', 'build', 'start', 'next'].includes(action), 'Usage: node scripts/qa.mjs plan|check|build|start.');
  const value = await launcher[action]();
  console.log(json(action === 'plan' ? value.summary : value));
  return value;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main().catch(error => { console.error(error.message); process.exitCode = 1; });
