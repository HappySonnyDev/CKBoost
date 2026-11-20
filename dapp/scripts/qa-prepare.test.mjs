import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareWorkspace, assertNodeVersion, main } from './qa-prepare.mjs';

const write = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value); };
const copy = async (source, target) => { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.cp(source, target, { recursive: true }); };
const names = ['contracts/contracts/claimable-pool-lock/ts', 'packages/ssri-ckboost', 'dapp'];

/** Only fake package layouts and an injected runner. No dependency installer,
 * TypeScript compiler, lifecycle hook or server is actually executed. */
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ckboost-qa-prepare-')));
  const [pool, sdk, dapp] = names.map(name => path.join(root, name));
  const packages = [{ name: 'ckb-claimable-pool-lock' }, { name: 'ssri-ckboost', exports: { '.': { import: './dist/index.js' } } }, { name: 'ckboost-dapp' }];
  for (const [index, directory] of [pool, sdk, dapp].entries()) {
    await write(path.join(directory, 'package.json'), JSON.stringify(packages[index]));
    await write(path.join(directory, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  }
  await write(path.join(pool, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noEmit: true, outDir: './dist' } }));
  await write(path.join(pool, 'tsconfig.build.json'), JSON.stringify({ extends: './tsconfig.json', compilerOptions: { noEmit: false } }));
  await write(path.join(pool, 'src/index.ts'), 'export {};\n');
  await write(path.join(pool, 'src/generated/claimable-pool.ts'), 'export const codec = true;\n');
  await write(path.join(sdk, 'src/generated/ckboost.ts'), 'export const codec = true;\n');
  await write(path.join(sdk, 'tsconfig.json'), JSON.stringify({ compilerOptions: { outDir: './dist' } }));
  await write(path.join(dapp, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: {
    'ssri-ckboost': ['../packages/ssri-ckboost/dist'], 'ssri-ckboost/types': ['../packages/ssri-ckboost/dist/generated'], 'ssri-ckboost/*': ['../packages/ssri-ckboost/dist/*'],
  } } }));
  await write(path.join(dapp, 'postinstall.mjs'), '// Fixture: never actually executed.\n');
  const calls = [];
  async function run(command, args, options) {
    calls.push({ command, args: [...args], ...options });
    if (command === 'pnpm' && args[0] === '--version') return { stdout: '9.15.9\n' };
    if (command === 'pnpm' && args[0] === 'install') {
      await write(path.join(options.cwd, 'node_modules/typescript/bin/tsc'), '// Fixture compiler, not executable.');
      if (options.cwd !== pool) {
        const target = path.join(options.cwd, 'node_modules/ckb-claimable-pool-lock');
        for (const name of ['src', 'tsconfig.json', 'tsconfig.build.json', 'package.json']) await copy(path.join(pool, name), path.join(target, name));
      }
      if (options.cwd === dapp) await write(path.join(dapp, 'node_modules/tinymce/tinymce.min.js'), '// TinyMCE fixture');
      return { stdout: '' };
    }
    assert.equal(command, process.execPath);
    if (args[0].endsWith(`${path.sep}typescript${path.sep}bin${path.sep}tsc`)) {
      await write(path.join(options.cwd, 'dist/index.js'), '// compiled fixture');
      if (options.cwd === sdk) for (const name of ['generated/ckboost.js', 'logging/index.js']) await write(path.join(sdk, 'dist', name), '// compiled fixture');
      return { stdout: '' };
    }
    assert.equal(args[0], path.join(dapp, 'postinstall.mjs'));
    await copy(path.join(dapp, 'node_modules/tinymce/tinymce.min.js'), path.join(dapp, 'public/tinymce/tinymce.min.js'));
    return { stdout: '' };
  }
  return { root, pool, sdk, dapp, calls, run, options: { root, run, nodeVersion: '22.19.0', environment: { npm_config_store_dir: path.join(root, 'pnpm-store'), HTTPS_PROXY: 'http://opaque-proxy.invalid:8080' }, log() {} }, dispose: () => fs.rm(root, { recursive: true, force: true }) };
}

test('fresh preparation uses frozen ignored-hook installs and pure tsc in dependency order, including both installed pool copies', async () => {
  const f = await fixture(); try {
    const result = await prepareWorkspace({ ...f.options, environment: { ...f.options.environment, NODE_ENV: 'production' } });
    assert.equal(result.ready, true); assert.equal(result.generatedSchemas, false); assert.equal(result.applicationBuilt, false); assert.equal(result.serverStarted, false);
    assert.equal(f.calls.length, 9);
    const installs = f.calls.filter(call => call.command === 'pnpm' && call.args[0] === 'install');
    assert.deepEqual(installs.map(call => call.cwd), [f.pool, f.sdk, f.dapp]);
    assert.ok(installs.every(call => JSON.stringify(call.args) === JSON.stringify(['install', '--frozen-lockfile', '--ignore-scripts', '--prod=false'])));
    const compiles = f.calls.filter(call => call.args.includes('-p'));
    assert.deepEqual(compiles.map(call => path.relative(f.root, call.cwd)), [names[0], `${names[1]}/node_modules/ckb-claimable-pool-lock`, names[1], 'dapp/node_modules/ckb-claimable-pool-lock']);
    assert.ok(compiles.every(call => call.command === process.execPath && call.args.at(-2) === '--incremental' && call.args.at(-1) === 'false'));
    assert.ok(f.calls.every(call => !call.args.some(arg => ['build', 'prebuild', 'generate', 'cargo', 'rustup', 'moleculec', 'next', '--prod'].includes(arg))));
    assert.ok(f.calls.every(call => call.env.CI === '1' && call.env.npm_config_store_dir === f.options.environment.npm_config_store_dir && call.env.HTTPS_PROXY === f.options.environment.HTTPS_PROXY));
    for (const file of ['dist/index.js', 'dist/generated/ckboost.js', 'dist/logging/index.js']) assert.ok((await fs.stat(path.join(f.sdk, file))).isFile());
    assert.ok((await fs.stat(path.join(f.dapp, 'public/tinymce/tinymce.min.js'))).isFile());
  } finally { await f.dispose(); }
});

test('checked-in root-only SDK exports work through explicit dapp aliases without hidden package patches or codec generation', async () => {
  const f = await fixture(); try {
    const files = [path.join(f.sdk, 'package.json'), path.join(f.sdk, 'src/generated/ckboost.ts'), path.join(f.pool, 'src/generated/claimable-pool.ts'), ...[f.pool, f.sdk, f.dapp].map(directory => path.join(directory, 'pnpm-lock.yaml'))];
    const before = await Promise.all(files.map(file => fs.readFile(file, 'utf8')));
    await prepareWorkspace(f.options);
    assert.deepEqual(await Promise.all(files.map(file => fs.readFile(file, 'utf8'))), before);
    assert.deepEqual(JSON.parse(before[0]).exports, { '.': { import: './dist/index.js' } });
  } finally { await f.dispose(); }
});

test('requires Node22.13 or newer and the exact pnpm9.15.9 before installing anything', async () => {
  for (const version of ['18.20.0', '20.19.0', '22.12.9', 'invalid']) assert.throws(() => assertNodeVersion(version), /Node.js/);
  for (const version of ['22.13.0', '22.19.0', '24.0.0']) assert.doesNotThrow(() => assertNodeVersion(version));
  const f = await fixture(); try {
    await assert.rejects(prepareWorkspace({ ...f.options, run: async (...args) => { f.calls.push(args); return { stdout: '10.0.0' }; } }), /pnpm9.15.9/);
    assert.equal(f.calls.length, 1);
  } finally { await f.dispose(); }
});

test('missing canonical codec, missing SDK subpath mappings or another lockfile generation fails without generating replacements', async () => {
  for (const change of [
    f => fs.rm(path.join(f.sdk, 'src/generated/ckboost.ts')),
    f => write(path.join(f.dapp, 'tsconfig.json'), '{"compilerOptions":{"paths":{}}}'),
    f => write(path.join(f.pool, 'pnpm-lock.yaml'), "lockfileVersion: '6.0'\n"),
  ]) {
    const f = await fixture(); try { await change(f); await assert.rejects(prepareWorkspace(f.options), /Missing|aliases|pnpm9/); assert.equal(f.calls.length, 0); } finally { await f.dispose(); }
  }
});

test('an installer failure stops before downstream compile/install rather than hiding partial preparation', async () => {
  const f = await fixture(); try {
    await assert.rejects(prepareWorkspace({ ...f.options, run: async (command, args, options) => {
      if (command === 'pnpm' && args[0] === 'install' && options.cwd === f.sdk) throw new Error('offline install failed');
      return f.run(command, args, options);
    } }), /offline install failed/);
    assert.ok(!f.calls.some(call => call.cwd === f.dapp && call.args[0] === 'install'));
  } finally { await f.dispose(); }
});

test('stale local package source is rejected instead of silently patching a copied dependency', async () => {
  const f = await fixture(); try {
    await assert.rejects(prepareWorkspace({ ...f.options, run: async (command, args, options) => {
      const result = await f.run(command, args, options);
      if (command === 'pnpm' && args[0] === 'install' && options.cwd === f.sdk) await write(path.join(f.sdk, 'node_modules/ckb-claimable-pool-lock/src/generated/claimable-pool.ts'), 'stale');
      return result;
    } }), /Stale local pool dependency/);
    assert.equal(await fs.readFile(path.join(f.pool, 'src/generated/claimable-pool.ts'), 'utf8'), 'export const codec = true;\n');
  } finally { await f.dispose(); }
});

test('external installed-package symlinks and output symlinks cannot redirect cleanup outside expected packages', async () => {
  const f = await fixture(), external = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-external-'));
  try {
    await write(path.join(external, 'keep'), 'unchanged');
    await assert.rejects(prepareWorkspace({ ...f.options, run: async (command, args, options) => {
      const result = await f.run(command, args, options);
      if (command === 'pnpm' && args[0] === 'install' && options.cwd === f.pool) await fs.symlink(external, path.join(f.pool, 'dist'), 'dir');
      return result;
    } }), /dist symlink/);
    assert.equal(await fs.readFile(path.join(external, 'keep'), 'utf8'), 'unchanged');
    await fs.unlink(path.join(f.pool, 'dist'));
    await assert.rejects(prepareWorkspace({ ...f.options, run: async (command, args, options) => {
      const result = await f.run(command, args, options);
      if (command === 'pnpm' && args[0] === 'install' && options.cwd === f.sdk) {
        const target = path.join(f.sdk, 'node_modules/ckb-claimable-pool-lock'); await fs.rm(target, { recursive: true }); await fs.symlink(external, target, 'dir');
      }
      return result;
    } }), /inside this checkout/);
    assert.equal(await fs.readFile(path.join(external, 'keep'), 'utf8'), 'unchanged');
  } finally { await f.dispose(); await fs.rm(external, { recursive: true, force: true }); }
});

test('nonfatal TinyMCE sync errors cannot report ready without actual browser assets', async () => {
  const f = await fixture(); try {
    await assert.rejects(prepareWorkspace({ ...f.options, run: async (command, args, options) => {
      if (args[0] === path.join(f.dapp, 'postinstall.mjs')) return { stdout: '' }; return f.run(command, args, options);
    } }), /TinyMCE browser assets/);
  } finally { await f.dispose(); }
});

test('CLI rejects caller paths, endpoints and signing/server flags', async () => {
  for (const args of [['--root', '/private'], ['--send'], ['--endpoint', 'https://foreign.invalid'], ['start']]) await assert.rejects(main(args), /takes no paths/);
});
