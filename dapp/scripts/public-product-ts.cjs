'use strict';
// Node-only loader for reviewed pure TS exports. Never initializes a wallet,
// reads dotenv files, signs or sends. Preserve connector CCC's actual classes.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const dapp=path.resolve(__dirname,'..'),appRequire=Module.createRequire(path.join(dapp,'package.json'));
const {ccc}=appRequire('@ckb-ccc/connector-react'),{cccA}=appRequire('@ckb-ccc/core/advanced'),ts=appRequire('typescript'),cache=new Map();
function loadPureTs(input){
  const file=fs.realpathSync(path.resolve(input));if(!file.startsWith(`${dapp}${path.sep}`)||path.extname(file)!=='.ts')throw Error('Only a reviewed pure TS module inside the dapp may be loaded.');
  if(cache.has(file))return cache.get(file).exports;
  const loaded=new Module(file,module);loaded.filename=file;loaded.paths=Module._nodeModulePaths(path.dirname(file));cache.set(file,loaded);const original=loaded.require.bind(loaded);
  loaded.require=name=>{
    if(name==='ssri-ckboost/types')return appRequire(path.resolve(dapp,'../packages/ssri-ckboost/dist/generated/ckboost.js'));
    if(name.startsWith('@/')){const base=path.resolve(dapp,name.slice(2));if(!base.startsWith(`${dapp}${path.sep}`))throw Error('Product alias escapes the dapp.');if(fs.existsSync(`${base}.ts`))return loadPureTs(`${base}.ts`);return original(base);}
    if(name.startsWith('.')){const base=path.resolve(path.dirname(file),name),candidate=base.endsWith('.ts')?base:`${base}.ts`;if(fs.existsSync(candidate))return loadPureTs(candidate);}
    return original(name);
  };
  try{loaded._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,file);loaded.loaded=true;return loaded.exports;}catch(error){cache.delete(file);throw error;}
}
module.exports={dapp,appRequire,ccc,cccA,loadPureTs};
