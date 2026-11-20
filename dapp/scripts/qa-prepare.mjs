#!/usr/bin/env node
// Dependency/bootstrap preparation only. No profile, env-file, wallet, chain,
// Rust, Molecule generation, application build, server or deployment operation.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const QA_PNPM_VERSION = '9.15.9';
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDirectory, '../..');
const assert = (value, message) => { if (!value) throw new Error(message); };
const inside = (root, value) => value === root || value.startsWith(`${root}${path.sep}`);

export function assertNodeVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  assert(match && (Number(match[1]) > 22 || Number(match[1]) === 22 && Number(match[2]) >= 13), 'QA requires Node.js >=22.13.0; Node22.19.0 was used for the verified local flow.');
}

async function json(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function requireFile(file, label = file) {
  assert((await fs.stat(file).catch(() => null))?.isFile(), `Missing ${label}. Restore/install the checked-in workspace before preparing QA.`);
}

/** Real subprocesses are used only by an explicit CLI invocation. Tests inject
 * a runner and temporary files, so they never install or compile this checkout. */
export function runCommand(command, args, { cwd, capture = false, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, env, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
    let stdout = '', settled = false;
    if (capture) child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 4096 && !settled) { settled = true; child.kill(); reject(new Error('Package-manager version output exceeded its bound.')); }
    });
    child.on('error', () => { if (!settled) { settled = true; reject(new Error(`Could not start ${command}. Install Node and pnpm${QA_PNPM_VERSION} first.`)); } });
    child.on('close', code => {
      if (settled) return; settled = true;
      if (code !== 0) reject(new Error(`${path.basename(command)} ${args.join(' ')} failed (exit ${code}); QA preparation stopped.`));
      else resolve({ stdout });
    });
  });
}

async function verifyWorkspace(root) {
  const paths = { root, dapp: path.join(root, 'dapp'), sdk: path.join(root, 'packages/ssri-ckboost'), pool: path.join(root, 'contracts/contracts/claimable-pool-lock/ts') };
  for (const [name, directory] of [['pool', paths.pool], ['sdk', paths.sdk], ['dapp', paths.dapp]]) {
    await requireFile(path.join(directory, 'package.json'), `${name} package.json`);
    await requireFile(path.join(directory, 'pnpm-lock.yaml'), `${name} frozen pnpm lock`);
    assert(/^lockfileVersion:\s*['"]?9\.0['"]?\s*$/m.test(await fs.readFile(path.join(directory, 'pnpm-lock.yaml'), 'utf8')), `${name} requires the checked-in pnpm9 lockfile; it will not be rewritten.`);
  }
  await requireFile(path.join(paths.pool, 'src/generated/claimable-pool.ts'), 'checked-in pool codec');
  await requireFile(path.join(paths.sdk, 'src/generated/ckboost.ts'), 'checked-in CKBoost codec');
  const app = await json(path.join(paths.dapp, 'tsconfig.json')), sdk = await json(path.join(paths.sdk, 'package.json'));
  const aliases = app.compilerOptions?.paths ?? {};
  assert(aliases['ssri-ckboost']?.includes('../packages/ssri-ckboost/dist') && aliases['ssri-ckboost/types']?.includes('../packages/ssri-ckboost/dist/generated') && aliases['ssri-ckboost/*']?.includes('../packages/ssri-ckboost/dist/*'), 'The dapp SDK root/types/logging aliases must point at the compiled repository SDK. No node_modules export patch is applied.');
  assert(sdk.exports?.['.']?.import === './dist/index.js', 'The checked-in SDK root export is unexpected. Review the workspace mappings before preparing QA.');
  return paths;
}

async function sourceFiles(directory, prefix = '') {
  const result = [];
  for (const row of await fs.readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, row.name);
    assert(!row.isSymbolicLink(), 'Pool source symlinks are unsupported by QA preparation.');
    if (row.isDirectory()) result.push(...await sourceFiles(directory, relative));
    else if (row.isFile() && row.name.endsWith('.ts') && !row.name.endsWith('.test.ts')) result.push(relative);
  }
  return result;
}

async function installedPool(paths, consumer) {
  const directory = await fs.realpath(path.join(consumer, 'node_modules/ckb-claimable-pool-lock')).catch(() => null);
  assert(directory && inside(paths.root, directory), 'The installed pool package must resolve inside this checkout; external/shared symlinks will not be modified.');
  assert((await json(path.join(directory, 'package.json'))).name === 'ckb-claimable-pool-lock', 'The installed local pool package has an unexpected identity.');
  for (const relative of ['tsconfig.json', 'tsconfig.build.json', ...await sourceFiles(path.join(paths.pool, 'src')).then(files => files.map(file => path.join('src', file)))]) {
    const canonical = await fs.readFile(path.join(paths.pool, relative));
    const installed = await fs.readFile(path.join(directory, relative)).catch(() => null);
    assert(installed?.equals(canonical), `Stale local pool dependency in ${path.relative(paths.root, consumer)} (${relative}). Reinstall that package with pnpm install --force --frozen-lockfile --ignore-scripts, then retry qa:prepare.`);
  }
  return directory;
}

async function compile(paths, directory, compilerDirectory, config, run, env) {
  const compiler = path.join(compilerDirectory, 'node_modules/typescript/bin/tsc');
  await requireFile(compiler, 'installed TypeScript compiler');
  await requireFile(path.join(directory, config), 'checked-in TypeScript project');
  const output = path.join(directory, 'dist');
  const stat = await fs.lstat(output).catch(() => null);
  assert(!stat?.isSymbolicLink(), 'A dist symlink will not be removed by QA preparation.');
  // All directory arguments are fixed repository packages or verified in-repo
  // local package copies. Remove only compiler output, never source/config.
  assert(inside(paths.root, directory), 'Compiler output must remain inside this checkout.');
  await fs.rm(output, { recursive: true, force: true });
  await run(process.execPath, [compiler, '-p', config, '--incremental', 'false'], { cwd: directory, env });
  await requireFile(path.join(output, 'index.js'), 'compiled package dist/index.js');
}

export async function prepareWorkspace({ root = defaultRoot, run = runCommand, nodeVersion = process.versions.node, environment = process.env, log = console.log } = {}) {
  assertNodeVersion(nodeVersion);
  root = await fs.realpath(path.resolve(root));
  const paths = await verifyWorkspace(root), env = { ...environment, CI: '1' };
  // Preserve caller proxy/store settings opaquely; no env file is read/copied.
  const version = await run('pnpm', ['--version'], { cwd: paths.dapp, capture: true, env });
  assert(version.stdout.trim() === QA_PNPM_VERSION, `Use pnpm${QA_PNPM_VERSION} for the frozen QA workspace (received ${version.stdout.trim() || 'unknown'}).`);
  const install = async directory => { log(`Installing frozen dependencies: ${path.relative(root, directory)}`); await run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts', '--prod=false'], { cwd: directory, env }); };

  await install(paths.pool);
  await compile(paths, paths.pool, paths.pool, 'tsconfig.build.json', run, env);
  await install(paths.sdk);
  const sdkPool = await installedPool(paths, paths.sdk);
  await compile(paths, sdkPool, paths.sdk, 'tsconfig.build.json', run, env);
  await compile(paths, paths.sdk, paths.sdk, 'tsconfig.json', run, env);
  for (const name of ['generated/ckboost.js', 'logging/index.js']) await requireFile(path.join(paths.sdk, 'dist', name), `compiled SDK ${name}`);

  await install(paths.dapp);
  const dappPool = await installedPool(paths, paths.dapp);
  await compile(paths, dappPool, paths.dapp, 'tsconfig.build.json', run, env);
  // --ignore-scripts intentionally skips package lifecycle hooks. Run only the
  // repository's known TinyMCE asset sync, and check its nonfatal failure path.
  await requireFile(path.join(paths.dapp, 'postinstall.mjs'), 'TinyMCE asset sync');
  await run(process.execPath, [path.join(paths.dapp, 'postinstall.mjs')], { cwd: paths.dapp, env });
  await requireFile(path.join(paths.dapp, 'public/tinymce/tinymce.min.js'), 'synced TinyMCE browser assets');
  const result = { ready: true, pnpm: QA_PNPM_VERSION, node: nodeVersion, packages: ['pool TypeScript', 'repository SDK', 'SDK/dapp local pool copies', 'TinyMCE browser assets'], generatedSchemas: false, applicationBuilt: false, serverStarted: false };
  log('QA dependencies prepared. Next run qa:plan, then the separate SSRI/build/start commands.');
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--help') { console.log('Usage: pnpm --dir dapp qa:prepare\nRequires Node>=22.13 and pnpm9.15.9. Frozen installs and pure TypeScript compilation only; skips Rust/Molecule generation, env files, chain operations, app build and server start.'); return; }
  assert(argv.length === 0, 'qa:prepare takes no paths, profiles, endpoints or signing arguments.');
  await prepareWorkspace();
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main().catch(error => { console.error(error.message); process.exitCode = 1; });
