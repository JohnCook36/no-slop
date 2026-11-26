import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,dirname} from "node:path";
import {analyze} from "../dist/semantic.js";
import {stronglyConnected,witness} from "../dist/graph.js";
async function fixture(t, files){
 const root=await mkdtemp(join(tmpdir(),"no-slop-sem-"));
 t.after(()=>rm(root,{recursive:true,force:true}));
 for(const [name,body] of Object.entries(files)){const path=join(root,name);await mkdir(dirname(path),{recursive:true});await writeFile(path,body);}
 return root;
}
test("iterative SCC and deterministic closed witness",()=>{
 const nodes=Array.from({length:20000},(_,i)=>String(i));
 const edges=nodes.slice(1).map((to,i)=>({from:nodes[i],to}));
 assert.deepEqual(stronglyConnected(nodes,edges),[]);
 const links=[{from:"b",to:"c"},{from:"c",to:"a"},{from:"a",to:"b"}];
 const result=stronglyConnected(["c","b","a"],links);
 assert.deepEqual(result,[["a","b","c"]]);assert.deepEqual(witness(result[0],links),["a","b","c","a"]);
});
test("runtime cycles, real symbol references, aliases and type-only separation",async t=>{
 const root=await fixture(t,{
  "tsconfig.json":JSON.stringify({compilerOptions:{baseUrl:".",paths:{"@/*":["src/*"]}}}),
  "src/a/index.ts":"import { b } from '@/b'; export function a(){return b();}",
  "src/b/index.ts":"import { a } from '../a'; export function b(){return a();}",
  "src/types/x.ts":"import type {Y} from './y'; export type X=Y;",
  "src/types/y.ts":"import type {X} from './x'; export type Y=X;",
  "src/a/test.spec.ts":"import '../b';",
 });
 const r=await analyze(root);
 assert.equal(r.semanticCoverage,"partial");
 assert.equal(r.cycles.files.length,1);
 assert.deepEqual(r.cycles.modules[0].members,["src/a","src/b"]);
 assert.equal(r.cycles.symbols.length,1);
 assert.ok(r.references.some(x=>x.kind==="call"&&x.to.endsWith("#b")));
 assert.equal(r.links.filter(x=>x.kind==="type-import").length,2);
 assert.deepEqual(await analyze(root),r);
});
test("local workspace packages, reexports, config limits, no external access",async t=>{
 const root=await fixture(t,{
  "package.json":JSON.stringify({name:"root",scripts:{preinstall:"exit 99"}}),
  "packages/core/package.json":JSON.stringify({name:"@local/core",exports:"./src/index.ts"}),
  "packages/core/src/index.ts":"export { value } from './value';",
  "packages/core/src/value.ts":"export const value=42;",
  "packages/mobile/src/a.ts":"import {value} from '@local/core'; export const result=value; import('./' + value); import '../../../../../outside';",
  "packages/mobile/tsconfig.json":JSON.stringify({extends:"../../outside.json",compilerOptions:{plugins:[{name:"evil"}]}}),
 });
 const r=await analyze(root);
 assert.ok(r.links.some(e=>e.to==="packages/core/src/index.ts"));
 assert.ok(r.references.some(e=>e.to.endsWith("value.ts#value")));
 assert.ok(r.gaps.some(e=>e.code==="DYNAMIC_SPECIFIER"));
 assert.ok(r.gaps.some(e=>e.code==="UNRESOLVED_IMPORT"));
 assert.ok(r.gaps.some(e=>e.code==="CONFIG_EXTENDS_UNSUPPORTED"));
 assert.ok(r.gaps.some(e=>e.code==="CONFIG_PLUGINS_IGNORED"));
 assert.equal(r.semanticCoverage,"partial");
});
