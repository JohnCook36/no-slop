import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,dirname} from "node:path";
import {analyze} from "../dist/semantic.js";
import {architecture,architectureDefaults} from "../dist/architecture.js";
async function fixture(t,files){
 const root=await mkdtemp(join(tmpdir(),"no-slop-arch-"));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const [name,body] of Object.entries(files)){const path=join(root,name);await mkdir(dirname(path),{recursive:true});await writeFile(path,body);}
 return root;
}
const ids=r=>r.findings.map(f=>f.rule);
test("ARCH-001 and ARCH-002: actual runtime cycle, type-only cycles excluded, stable evidence",async t=>{
 const root=await fixture(t,{
  "src/a/index.ts":"import { b } from '../b'; export function a(){return b()+1;}",
  "src/b/index.ts":"import { a } from '../a'; export function b(){return a()+1;}",
  "src/x/index.ts":"import type {Y} from '../y'; export type X=Y;",
  "src/y/index.ts":"import type {X} from '../x'; export type Y=X;",
 });
 const report=architecture(await analyze(root));
 assert.deepEqual(ids(report),["ARCH-001","ARCH-002"]);
 const cycle=report.findings[0];assert.deepEqual(cycle.members,["src/a","src/b"]);
 assert.deepEqual(cycle.witness,["src/a","src/b","src/a"]);
 assert.ok(cycle.evidence.every(e=>e.at.line===1));
 assert.deepEqual(architecture(await analyze(root)),report);assert.equal(report.complete,false);
});
test("ARCH-002: narrow forwarding preserves dependency, behavior-bearing wrappers remain",async t=>{
 const root=await fixture(t,{
  "src/a/index.ts":"import { bridge } from '../bridge'; export function a(n:number){return bridge(n)+1;}",
  "src/bridge/index.ts":"import { b } from '../b'; export function bridge(n:number){return b(n);} export function checked(n:number){if(n<0)throw Error();return b(n);}",
  "src/b/index.ts":"import { a } from '../a'; export function b(n:number){return a(n)+1;}",
 });
 const semantic=await analyze(root);
 assert.ok(semantic.symbols.find(s=>s.name==="bridge").forwardsTo);
 assert.equal(semantic.symbols.find(s=>s.name==="checked").forwardsTo,undefined);
 const tangle=architecture(semantic).findings.find(f=>f.rule==="ARCH-002");
 assert.ok(tangle);assert.ok(tangle.evidence.some(e=>e.via?.some(x=>x.endsWith("#bridge"))));
 assert.ok(!tangle.members.some(x=>x.endsWith("#bridge")));
});
test("ARCH-003: external write to guarded class, not internal or DTO writes",async t=>{
 const root=await fixture(t,{
  "src/domain/model.ts":"export class Account {private secret=1; balance=0; update(){this.balance++;} read(){return this.secret;}} export class DTO {value=0;}",
  "src/use/run.ts":"import {Account,DTO} from '../domain/model'; export function run(a:Account,d:DTO){a.balance++;d.value=1;return a.balance;}",
 });
 const findings=architecture(await analyze(root)).findings.filter(f=>f.rule==="ARCH-003");
 assert.equal(findings.length,1);assert.ok(findings[0].subject.endsWith("#Account.balance"));
 assert.equal(findings[0].evidenceCount,1);
});
test("ARCH-004: observed public surface vs internal operations, configurable and advisory",async t=>{
 const root=await fixture(t,{
  "src/a/index.ts":"export function x(){return 1;} export function y(){return 2;}",
  "src/b/index.ts":"import {x,y} from '../a'; export function b(){return x()+y();}",
 });
 const r=await analyze(root);
 assert.ok(!ids(architecture(r)).includes("ARCH-004"));
 const f=architecture(r,{...architectureDefaults,exposedOperations:1}).findings.find(x=>x.rule==="ARCH-004");
 assert.ok(f);assert.deepEqual(f.metrics,{external:2,internal:0,total:2});assert.equal(f.confidence,"low");
});
test("ARCH-005/006: relevant physical layout, ignored generated files, threshold boundaries",async t=>{
 const root=await fixture(t,{
  "src/a.ts":"// 1\n// 2\n// 3\n","src/b.ts":"// 1\n","src/c.ts":"// 1\n",
  "src/generated/d.ts":"// ignored\n",
 });
 const semantic=await analyze(root);
 assert.deepEqual(ids(architecture(semantic)),[]);
 const r=architecture(semantic,{...architectureDefaults,maxDirectoryEntries:2,maxFileLines:2});
 assert.deepEqual(ids(r),["ARCH-005","ARCH-006"]);
 assert.equal(r.findings[0].metrics.entries,3);assert.equal(r.findings[1].metrics.lines,3);
 assert.throws(()=>architecture(semantic,{...architectureDefaults,maxFileLines:0}));
});
