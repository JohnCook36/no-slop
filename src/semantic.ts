import ts from "typescript";
import { posix } from "node:path";
import { scan, defaults, type Limits } from "./scanner.js";
import { stronglyConnected, witness } from "./graph.js";

type EdgeKind = "runtime-import" | "type-import" | "runtime-export" | "type-export" | "dynamic-import" | "require";
type Span = { file: string; line: number; column: number };
type Link = { from: string; to: string; kind: EdgeKind; at: Span };
type SymbolInfo = { id: string; file: string; name: string; kind: string; at: Span };
type Reference = { from: string; to: string; kind: "call" | "construct" | "write" | "read" | "type"; at: Span };
type Gap = { code: string; at: Span };
type Obj = Record<string, unknown>;
const object = (x: unknown): Obj => x && typeof x === "object" && !Array.isArray(x) ? x as Obj : {};
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const root = "/project";
const virtual = (p: string) => root + "/" + p;
const relative = (p: string) => p.slice(root.length + 1);
const contained = (p: string) => p.startsWith(root + "/") || p === root;
const safeJoin = (dir: string, p: string) => {
  if (p.includes("\\") || p.includes("\0") || posix.isAbsolute(p) || /^[A-Za-z]:/.test(p)) return undefined;
  const joined = posix.normalize(posix.join(dir, p));
  return contained(joined) ? joined : undefined;
};
const locate = (sf: ts.SourceFile, node: ts.Node): Span => {
  const {line, character} = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return {file: relative(sf.fileName), line: line + 1, column: character + 1};
};
const atFile = (path: string): Span => ({file: relative(path),line:1,column:1});
const isTest = (p: string) => /(?:^|\/)(?:__tests__|tests?|__mocks__)(?:\/|$)|\.(?:test|spec)\.[^.]+$/i.test(p);

export async function analyze(path: string, limits: Limits = defaults) {
  const source = new Map<string,string>(), configs = new Map<string,string>();
  const inventory = await scan(path, limits, (name, body, kind) => {
    (kind === "source" ? source : configs).set(virtual(name), body);
  });
  const gaps: Gap[] = [];
  const gap = (code: string, at: Span) => gaps.push({code,at});
  const config = new Map<string,Obj>();
  const packages = new Map<string,string[]>();
  for (const [name, body] of [...configs].sort(([a],[b])=>cmp(a,b))) {
    const parsed = ts.parseConfigFileTextToJson(name, body);
    if (parsed.error) { gap("INVALID_CONFIG", atFile(name)); continue; }
    const data = object(parsed.config);
    config.set(name,data);
    if (posix.basename(name) === "package.json" && typeof data.name === "string") {
      const list = packages.get(data.name) ?? [];
      list.push(posix.dirname(name)); packages.set(data.name,list);
    }
    if (posix.basename(name).startsWith("tsconfig")) {
      if (data.extends !== undefined) gap("CONFIG_EXTENDS_UNSUPPORTED",atFile(name));
      if (data.references !== undefined) gap("PROJECT_REFERENCES_UNSUPPORTED",atFile(name));
      if (data.include !== undefined || data.exclude !== undefined || data.files !== undefined) gap("CONFIG_SCOPE_NOT_APPLIED",atFile(name));
      const opts = object(data.compilerOptions);
      if (opts.plugins !== undefined) gap("CONFIG_PLUGINS_IGNORED",atFile(name));
    }
  }
  const sortedNames = [...source.keys()].sort(cmp);
  const dirs = new Set<string>([root]);
  for (const path of [...sortedNames,...configs.keys()]) {
    let d=posix.dirname(path);
    while (contained(d)) { dirs.add(d); if(d===root) break; d=posix.dirname(d); }
  }
  const pick = (p: string | undefined): string | undefined => {
    if (!p) return undefined;
    const stem=p.replace(/\.(?:mjs|cjs|js|jsx)$/i,"");
    const candidates=[p, ...[".ts",".tsx",".mts",".cts",".js",".jsx",".mjs",".cjs",".d.ts"].map(ext=>stem+ext),
      ...["index.ts","index.tsx","index.js","index.d.ts"].map(x=>posix.join(p,x))];
    return candidates.find(x=>source.has(x));
  };
  const nearest = (file: string, base: string) => {
    let dir=posix.dirname(file);
    while (contained(dir)) {
      const name=posix.join(dir,base); if (config.has(name)) return name;
      if(dir===root) break; dir=posix.dirname(dir);
    }
    return undefined;
  };
  const resolve = (specifier: string, from: string): string | undefined => {
    if (specifier.startsWith(".")) return pick(safeJoin(posix.dirname(from),specifier));
    const cfg=nearest(from,"tsconfig.json");
    if(cfg) {
      const opts=object(config.get(cfg)?.compilerOptions);
      const dir=posix.dirname(cfg);
      const base=typeof opts.baseUrl==="string"?safeJoin(dir,opts.baseUrl):dir;
      if(base) {
        const patterns=Object.entries(object(opts.paths)).sort(([a],[b])=>b.replace("*","").length-a.replace("*","").length||cmp(a,b));
        for (const [pattern,values] of patterns) {
          const star=pattern.indexOf("*");
          if (star!==pattern.lastIndexOf("*")) continue;
          let middle="";
          if(star<0) { if(pattern!==specifier) continue; }
          else {
            const prefix=pattern.slice(0,star),suffix=pattern.slice(star+1);
            if(!specifier.startsWith(prefix)||!specifier.endsWith(suffix)||specifier.length<prefix.length+suffix.length) continue;
            middle=specifier.slice(prefix.length,specifier.length-suffix.length);
          }
          if(!Array.isArray(values)) continue;
          for(const v of values) if(typeof v==="string") {
            const result=pick(safeJoin(base,v.replace("*",middle))); if(result) return result;
          }
        }
        if(typeof opts.baseUrl==="string") {const result=pick(safeJoin(base,specifier)); if(result) return result;}
      }
    }
    const parts=specifier.split("/");
    const name=specifier.startsWith("@")?parts.slice(0,2).join("/"):parts[0]!;
    const sub=parts.slice(specifier.startsWith("@")?2:1).join("/");
    const candidates=packages.get(name);
    if(candidates?.length!==1) return undefined;
    const dir=candidates[0]!, manifest=config.get(posix.join(dir,"package.json"))!;
    // Only explicit local package entry paths or simple index fallback; no conditional exports.
    if(manifest.exports!==undefined) {
      const exports=manifest.exports;
      const entry=typeof exports==="string"&&!sub?exports:object(exports)[sub?"./"+sub:"."];
      return typeof entry==="string"?pick(safeJoin(dir,entry)):undefined;
    }
    if(sub) return pick(safeJoin(dir,sub));
    for(const field of ["source","types","module","main"]) {
      const target=manifest[field]; if(typeof target==="string") {const found=pick(safeJoin(dir,target));if(found)return found;}
    }
    return pick(dir);
  };
  const options:ts.CompilerOptions={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,
    jsx:ts.JsxEmit.Preserve,allowJs:true,noLib:true,noEmit:true,types:[],skipLibCheck:true};
  const extension=(p:string):ts.Extension => p.endsWith(".d.ts")?ts.Extension.Dts:p.endsWith(".tsx")?ts.Extension.Tsx:
    p.endsWith(".mts")?ts.Extension.Mts:p.endsWith(".cts")?ts.Extension.Cts:p.endsWith(".mjs")?ts.Extension.Mjs:
    p.endsWith(".cjs")?ts.Extension.Cjs:p.endsWith(".jsx")?ts.Extension.Jsx:p.endsWith(".js")?ts.Extension.Js:ts.Extension.Ts;
  const host:ts.CompilerHost={
    getSourceFile:(p,version)=>{const body=source.get(p);return body===undefined?undefined:ts.createSourceFile(p,body,version,true);},
    getDefaultLibFileName:()=>"/no-lib.d.ts",writeFile:()=>{throw new Error("EMIT_FORBIDDEN");},
    getCurrentDirectory:()=>root,getDirectories:()=>[],fileExists:p=>source.has(p)||configs.has(p),
    readFile:p=>source.get(p)??configs.get(p),directoryExists:p=>dirs.has(p),realpath:p=>p,
    getCanonicalFileName:p=>p,useCaseSensitiveFileNames:()=>true,getNewLine:()=>"\n",
    resolveModuleNames:(names,from)=>names.map(n=>{const target=resolve(n,from);return target?{resolvedFileName:target,extension:extension(target),isExternalLibraryImport:false}:undefined;}),
    resolveTypeReferenceDirectives:names=>names.map(()=>undefined)
  };
  const program=ts.createProgram(sortedNames,options,host);
  const checker=program.getTypeChecker();
  const links:Link[]=[], symbols:SymbolInfo[]=[], refs:Reference[]=[];
  const byDeclaration=new Map<ts.Node,string>();
  const moduleOf=(p:string)=>{
    const pkg=nearest(p,"package.json");
    const pkgDir=pkg?posix.dirname(pkg):root;
    const r=posix.relative(pkgDir,p), segments=r.split("/");
    const head=segments[0]==="src"&&segments.length>2?segments.slice(0,2).join("/"):segments.length>1?segments[0]!:"(root)";
    return (pkgDir===root?"":relative(pkgDir)+"/")+head;
  };
  const declaration=(n:ts.Node): n is ts.Declaration & {name:ts.Identifier} => (
    ts.isFunctionDeclaration(n)||ts.isClassDeclaration(n)||ts.isInterfaceDeclaration(n)||ts.isTypeAliasDeclaration(n)||
    ts.isEnumDeclaration(n)||ts.isMethodDeclaration(n)||ts.isPropertyDeclaration(n)||ts.isVariableDeclaration(n)
  ) && !!n.name && ts.isIdentifier(n.name);
  const sources=program.getSourceFiles().filter(sf=>source.has(sf.fileName)).sort((a,b)=>cmp(a.fileName,b.fileName));
  const walk=(node:ts.Node,visit:(n:ts.Node)=>void)=>{
    const stack=[node];while(stack.length){const n=stack.pop()!;visit(n);const kids:ts.Node[]=[];n.forEachChild(k=>{kids.push(k);});for(let i=kids.length-1;i>=0;i--)stack.push(kids[i]!);}
  };
  const seen=new Map<string,number>();
  for(const sf of sources) {
    if(sf.isDeclarationFile||isTest(sf.fileName)) continue;
    for(const diagnostic of program.getSyntacticDiagnostics(sf)) {
      const {line,character}=sf.getLineAndCharacterOfPosition(diagnostic.start??0);
      gap("SYNTAX_ERROR",{file:relative(sf.fileName),line:line+1,column:character+1});
    }
    walk(sf,n=>{
      if(!declaration(n))return;
      const owners:string[]=[];
      for(let p=n.parent;p&&!ts.isSourceFile(p);p=p.parent) if(declaration(p)) owners.unshift(p.name.text);
      const base=relative(sf.fileName)+"#"+[...owners,n.name.text].join(".");
      const count=(seen.get(base)??0)+1;seen.set(base,count);
      const id=count===1?base:base+"~"+count;
      byDeclaration.set(n,id);symbols.push({id,file:relative(sf.fileName),name:n.name.text,kind:ts.SyntaxKind[n.kind]!,at:locate(sf,n)});
    });
  }
  const owner=(n:ts.Node)=>{
    for(let p:ts.Node|undefined=n;p;p=p.parent){const id=byDeclaration.get(p);if(id)return id;}
    return undefined;
  };
  const symbolId=(n:ts.Node)=>{
    let s=checker.getSymbolAtLocation(n);if(!s)return undefined;
    if(s.flags&ts.SymbolFlags.Alias)s=checker.getAliasedSymbol(s);
    const declarations=s.declarations??[];
    return declarations.map(d=>byDeclaration.get(d)).find((id):id is string=>id!==undefined);
  };
  const kindOf=(n:ts.Identifier):Reference["kind"]=>{
    const p=n.parent;
    if(ts.isPropertyAccessExpression(p)&&p.name===n){
      const outer=p.parent;if(ts.isCallExpression(outer)&&outer.expression===p)return "call";
      if(ts.isBinaryExpression(outer)&&outer.left===p&&outer.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&outer.operatorToken.kind<=ts.SyntaxKind.LastAssignment)return "write";
    }
    if(ts.isCallExpression(p)&&p.expression===n)return "call";
    if(ts.isNewExpression(p)&&p.expression===n)return "construct";
    if(ts.isBinaryExpression(p)&&p.left===n&&p.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&p.operatorToken.kind<=ts.SyntaxKind.LastAssignment)return "write";
    if(ts.isTypeNode(p))return "type";
    return "read";
  };
  for(const sf of sources) {
    if(sf.isDeclarationFile||isTest(sf.fileName))continue;
    const add=(node:ts.Node,expr:ts.Expression|undefined,kind:EdgeKind)=>{
      if(!expr||!ts.isStringLiteralLike(expr)){gap("DYNAMIC_SPECIFIER",locate(sf,node));return;}
      const to=resolve(expr.text,sf.fileName);
      if(!to){gap("UNRESOLVED_IMPORT",locate(sf,node));return;}
      links.push({from:relative(sf.fileName),to:relative(to),kind,at:locate(sf,node)});
    };
    walk(sf,n=>{
      if(ts.isImportDeclaration(n)) {
        const clause=n.importClause;
        const named=clause?.namedBindings;
        const only=clause?.isTypeOnly||(!clause?.name&&named&&ts.isNamedImports(named)&&named.elements.length>0&&named.elements.every(e=>e.isTypeOnly));
        add(n,n.moduleSpecifier,only?"type-import":"runtime-import");
      } else if(ts.isExportDeclaration(n)&&n.moduleSpecifier) {
        const only=n.isTypeOnly||(n.exportClause&&ts.isNamedExports(n.exportClause)&&n.exportClause.elements.length>0&&n.exportClause.elements.every(e=>e.isTypeOnly));
        add(n,n.moduleSpecifier,only?"type-export":"runtime-export");
      } else if(ts.isCallExpression(n)&&n.expression.kind===ts.SyntaxKind.ImportKeyword) {
        add(n,n.arguments[0],"dynamic-import");
      } else if(ts.isCallExpression(n)&&ts.isIdentifier(n.expression)&&n.expression.text==="require") {
        // Only unbound require is considered CommonJS; locally shadowed functions are ordinary calls.
        if(!checker.getSymbolAtLocation(n.expression)) add(n,n.arguments[0],"require");
      } else if(ts.isImportEqualsDeclaration(n)) {
        if(ts.isExternalModuleReference(n.moduleReference))add(n,n.moduleReference.expression,n.isTypeOnly?"type-import":"require");
      }
      if(ts.isIdentifier(n)){
        if(declaration(n.parent)&&n.parent.name===n)return;
        if(ts.isImportClause(n.parent)||ts.isImportSpecifier(n.parent)||ts.isExportSpecifier(n.parent)||ts.isNamespaceImport(n.parent))return;
        const from=owner(n),to=symbolId(n);
        if(from&&to&&from!==to)refs.push({from,to,kind:kindOf(n),at:locate(sf,n)});
      }
    });
  }
  const nodes=sortedNames.filter(p=>!isTest(p)&&!p.endsWith(".d.ts")).map(relative);
  const allowed=new Set(nodes);
  const runtime=links.filter(e=>allowed.has(e.from)&&allowed.has(e.to)&&e.kind!=="type-import"&&e.kind!=="type-export");
  const modules=nodes.map(p=>moduleOf(virtual(p)));
  const moduleLinks=runtime.map(e=>({from:moduleOf(virtual(e.from)),to:moduleOf(virtual(e.to))})).filter(e=>e.from!==e.to);
  const cycle=(members:string[],edges:{from:string;to:string}[])=>({members,witness:witness(members,edges)});
  const cycles={
    files:stronglyConnected(nodes,runtime).map(c=>cycle(c,runtime)),
    modules:stronglyConnected([...new Set(modules)],moduleLinks).map(c=>cycle(c,moduleLinks)),
    symbols:stronglyConnected(symbols.map(s=>s.id),refs.filter(e=>e.kind!=="type")).map(c=>cycle(c,refs.filter(e=>e.kind!=="type")))
  };
  const sortBySpan=(a:{at:Span},b:{at:Span})=>cmp(a.at.file,b.at.file)||a.at.line-b.at.line||a.at.column-b.at.column;
  return {schemaVersion:1,stage:"semantic" as const,complete:inventory.complete,semanticCoverage:"partial" as const,
    limitations:["local symbol resolution only; no standard-library or dependency types","inferred module boundaries","dynamic dispatch, DI, aliasing and conditional exports not fully resolved","config scope, extends and project references not applied","semantic graph is not a security or architecture verdict"],
    inventory,files:nodes.map(p=>({path:p,module:moduleOf(virtual(p))})),symbols:symbols.sort((a,b)=>cmp(a.id,b.id)),links:links.sort(sortBySpan),references:refs.sort(sortBySpan),gaps:gaps.sort(sortBySpan),cycles};
}
