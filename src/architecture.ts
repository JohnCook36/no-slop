import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { analyze } from "./semantic.js";
import { stronglyConnected, witness } from "./graph.js";

type Semantic = Awaited<ReturnType<typeof analyze>>;
type Span = { file:string; line:number; column:number };
type Edge = { from:string; to:string; at:Span; via?:string[] };
type Rule = "ARCH-001"|"ARCH-002"|"ARCH-003"|"ARCH-004"|"ARCH-005"|"ARCH-006";
type Confidence = "high"|"medium"|"low";
type Finding = {
  rule:Rule; ruleVersion:1; fingerprint:string; severity:"warning"; confidence:Confidence;
  subject:string; message:string; suggestion:string; members:string[]; evidence:Edge[];
  evidenceCount:number; witness?:string[]; metrics?:Record<string,number>;
};
export interface Thresholds { tangleSize:number; exposedOperations:number; maxDirectoryEntries:number; maxFileLines:number }
export const architectureDefaults:Readonly<Thresholds>=Object.freeze({
  tangleSize:7,exposedOperations:7,maxDirectoryEntries:15,maxFileLines:2000,
});
const cmp=(a:string,b:string)=>a<b?-1:a>b?1:0;
const atFile=(file:string):Span=>({file,line:1,column:1});
const edgeOrder=(a:Edge,b:Edge)=>cmp(a.from,b.from)||cmp(a.to,b.to)||cmp(a.at.file,b.at.file)||a.at.line-b.at.line||a.at.column-b.at.column;
const sorted=(xs:Iterable<string>)=>[...new Set(xs)].sort(cmp);
const fingerprint=(rule:Rule,subject:string,members:string[])=>createHash("sha256").update(JSON.stringify([rule,subject,members])).digest("hex");
function finding(rule:Rule,subject:string,members:string[],message:string,suggestion:string,confidence:Confidence,evidence:Edge[],extra:Pick<Finding,"witness"|"metrics">={}):Finding{
  const ids=sorted(members);
  return {rule,ruleVersion:1,fingerprint:fingerprint(rule,subject,ids),severity:"warning",confidence,subject,message,suggestion,
    members:ids,evidence:[...evidence].sort(edgeOrder).slice(0,30),evidenceCount:evidence.length,...extra};
}
export function architecture(report:Semantic,thresholds:Thresholds=architectureDefaults){
  for(const key of Object.keys(architectureDefaults) as (keyof Thresholds)[])
    if(!Number.isSafeInteger(thresholds[key])||thresholds[key]<1)throw new Error("INVALID_THRESHOLD");
  const findings:Finding[]=[];
  const fileModules=new Map(report.files.map(f=>[f.path,f.module]));
  const byId=new Map(report.symbols.map(s=>[s.id,s]));
  const moduleOf=(id:string)=>fileModules.get(byId.get(id)?.file??"");
  const moduleEdges:Edge[]=[];
  for(const link of report.links){
    if(link.kind==="type-import"||link.kind==="type-export")continue;
    const from=fileModules.get(link.from),to=fileModules.get(link.to);
    if(from&&to&&from!==to)moduleEdges.push({from,to,at:link.at});
  }
  const moduleIds=sorted(fileModules.values());
  const indexComponents=(components:string[][],edges:Edge[])=>{
    const memberIndex=new Map<string,number>();
    components.forEach((group,i)=>group.forEach(id=>memberIndex.set(id,i)));
    const grouped=components.map(()=>[] as Edge[]);
    for(const e of edges){const i=memberIndex.get(e.from);if(i!==undefined&&i===memberIndex.get(e.to))grouped[i]!.push(e);}
    return components.map((members,i)=>({members,edges:grouped[i]!}));
  };
  for(const group of indexComponents(stronglyConnected(moduleIds,moduleEdges),moduleEdges)){
    findings.push(finding("ARCH-001","inferred-module-cycle",group.members,
      "Inferred modules have a cycle in the possible runtime dependency graph.",
      "Review the witness and move shared responsibility behind a cohesive contract; do not add a wrapper only to silence this rule.",
      "medium",group.edges,{witness:witness(group.members,group.edges)}));
  }
  // Resolve only proven syntactic forwarding candidates. Cycles in forwarding
  // chains are kept as-is; a wrapper is not a dependency-erasing boundary.
  const terminal=new Map<string,{target:string;via:string[]}>();
  for(const s of report.symbols){
    if(!s.forwardsTo)continue;
    const seen=new Set<string>([s.id]),via=[s.id];let next=s.forwardsTo;
    while(next&&!seen.has(next)&&via.length<64){
      const target=byId.get(next);
      if(!target)break;
      if(!target.forwardsTo){terminal.set(s.id,{target:next,via});break;}
      seen.add(next);via.push(next);next=target.forwardsTo;
    }
  }
  const refs: (Edge&{kind:Semantic["references"][number]["kind"]})[]=[];
  for(const r of report.references){
    if(r.kind==="call"&&terminal.has(r.from)&&byId.get(r.from)?.forwardsTo===r.to)continue;
    const redirect=r.kind==="call"?terminal.get(r.to):undefined;
    refs.push({...r,to:redirect?.target??r.to,...(redirect?{via:redirect.via}:{})});
  }
  const entity=(id:string)=>byId.get(id)?.classOwner??id;
  const entityIds=sorted(report.symbols.map(s=>entity(s.id)));
  const entityEdges=refs.filter(r=>r.kind!=="type").map(r=>({...r,from:entity(r.from),to:entity(r.to)})).filter(r=>r.from!==r.to);
  for(const group of indexComponents(stronglyConnected(entityIds,entityEdges),entityEdges)){
    const modules=sorted(group.members.map(moduleOf).filter((m):m is string=>m!==undefined));
    if(modules.length<2&&group.members.length<=thresholds.tangleSize)continue;
    findings.push(finding("ARCH-002","symbol-tangle",group.members,
      "Resolved symbols form a mutually dependent component.",
      "Review actual reference sites, responsibilities and forwarding chains; intentional recursion can be legitimate.",
      "medium",group.edges,{witness:witness(group.members,group.edges),metrics:{modules:modules.length,symbols:group.members.length}}));
  }
  // Direct external property assignments and ++/-- only. No speculative escape
  // analysis or mutation through alias/getter; DTO-like classes without guarded state are skipped.
  const writes=new Map<string,Edge[]>();
  for(const r of report.references){
    if(r.kind!=="write")continue;
    const field=byId.get(r.to),owner=field?.classOwner;
    if(!field?.mutableField||!owner||!byId.get(owner)?.domainClass||entity(r.from)===owner)continue;
    const list=writes.get(r.to)??[];list.push(r);writes.set(r.to,list);
  }
  for(const [field,edges] of writes){
    findings.push(finding("ARCH-003",field,[field],
      "External code directly writes a mutable property of a class with guarded state and behavior.",
      "Check whether a domain operation should own this mutation; do not replace legitimate DTOs or simple data access with boilerplate.",
      "medium",edges,{metrics:{writes:edges.length}}));
  }
  const operations=new Map<string,Set<string>>(),external=new Map<string,Map<string,Edge[]>>();
  for(const s of report.symbols){
    const mod=moduleOf(s.id);
    if(!mod||!s.operation||terminal.has(s.id))continue;
    const set=operations.get(mod)??new Set<string>();set.add(s.id);operations.set(mod,set);
  }
  for(const r of refs){
    if(r.kind!=="call")continue;
    const from=moduleOf(r.from),to=moduleOf(r.to);
    if(!from||!to||from===to||!operations.get(to)?.has(r.to))continue;
    const map=external.get(to)??new Map<string,Edge[]>();const list=map.get(r.to)??[];
    list.push(r);map.set(r.to,list);external.set(to,map);
  }
  for(const [mod,shown] of external){
    const total=operations.get(mod)?.size??0,hidden=total-shown.size;
    if(shown.size<=thresholds.exposedOperations||hidden>shown.size)continue;
    findings.push(finding("ARCH-004",mod,[mod],
      "Many locally observed operations are called from outside this module relative to its internal operations.",
      "Review the module's public surface and cohesion; wide legitimate APIs need no automatic refactor.",
      "low",[...shown.values()].flat(),{metrics:{external:shown.size,internal:hidden,total}}));
  }
  const directories=new Map<string,Set<string>>();
  for(const f of report.inventory.files){
    const parts=f.path.split("/");
    for(let i=0;i<parts.length;i++){
      const dir=parts.slice(0,i).join("/")||".",child=parts[i]!+(i===parts.length-1?"":"/");
      const children=directories.get(dir)??new Set<string>();children.add(child);directories.set(dir,children);
    }
    if(f.lines>thresholds.maxFileLines)findings.push(finding("ARCH-006",f.path,[f.path],
      "Source file exceeds the configured physical-line threshold.",
      "Review readability and responsibilities. Split only when the resulting interfaces are more cohesive.",
      "high",[{from:f.path,to:f.path,at:atFile(f.path)}],{metrics:{lines:f.lines,threshold:thresholds.maxFileLines}}));
  }
  for(const [dir,children] of directories){
    if(children.size<=thresholds.maxDirectoryEntries)continue;
    const edges=sorted(children).map(name=>({from:dir,to:posix.join(dir,name),at:atFile(posix.join(dir,name))}));
    findings.push(finding("ARCH-005",dir,[dir],
      "Directory contains more relevant source entries than the configured threshold.",
      "Review grouping by responsibility; do not create unnecessary subdirectories just to pass a metric.",
      "high",edges,{metrics:{entries:children.size,threshold:thresholds.maxDirectoryEntries}}));
  }
  findings.sort((a,b)=>cmp(a.rule,b.rule)||cmp(a.subject,b.subject)||cmp(a.fingerprint,b.fingerprint));
  return {schemaVersion:1,stage:"architecture" as const,complete:false,coverage:{inventoryComplete:report.complete,semantic:"partial" as const,gaps:report.gaps.length},
    thresholds:{...thresholds},findings,limitations:[...report.limitations,
      "advisory rules only; inferred module boundaries and incomplete runtime/type resolution",
      "field leak covers direct observed writes only, not mutable escapes, getters or alias flows",
      "shallow module counts observed cross-module calls, not all consumers or exported APIs",
      "forwarding normalization is narrow and does not prove behavioral equivalence",
      "layout includes scanned test files and excludes ignored/generated directories by convention",
      "reports contain symbol names and paths; review before sharing"],};
}
