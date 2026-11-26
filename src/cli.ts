#!/usr/bin/env node
import { scan } from "./scanner.js";
import { analyze } from "./semantic.js";
const help = "Usage: no-slop scan|analyze <path> [--format text|json]\n" +
  "scan: inventory; analyze: experimental partial semantic graph (NS-002). No security verdict.\n" +
  "Exit codes: 0 complete inventory, 1 reserved for policy failure, 2 incomplete/error.";
async function main(args: string[]): Promise<number> {
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) { console.log(help); return 0; }
  if (args.length === 1 && ["--version", "-v"].includes(args[0]!)) { console.log("0.1.0"); return 0; }
  if (!["scan","analyze"].includes(args[0] ?? "") || !args[1] || args[1].startsWith("-") ||
      !(args.length === 2 || (args.length === 4 && args[2] === "--format" &&
        ["text", "json"].includes(args[3]!)))) { console.error(help); return 2; }
  if(args[0] === "analyze"){
    const result=await analyze(args[1]);
    if(args[3]==="json") console.log(JSON.stringify(result,null,2));
    else {
      console.log("No Slop semantic analysis: PARTIAL COVERAGE");
      console.log("Files: "+result.files.length+"; symbols: "+result.symbols.length+"; references: "+result.references.length);
      console.log("File cycles: "+result.cycles.files.length+"; module cycles: "+result.cycles.modules.length+"; symbol cycles: "+result.cycles.symbols.length);
      console.log("Coverage gaps: "+result.gaps.length);
      for(const limit of result.limitations) console.log(limit);
    }
    // Partial semantic coverage is never reported as a clean quality gate.
    return 2;
  }
  const report = await scan(args[1]);
  if (args[3] === "json") console.log(JSON.stringify(report, null, 2));
  else {
    console.log("No Slop inventory: " + (report.complete ? "complete" : "INCOMPLETE"));
    console.log("Files: " + report.coverage.files + "; bytes: " + report.coverage.bytes);
    for (const issue of report.issues) console.log(JSON.stringify(issue));
    console.log("Architecture and security rules not run (inventory stage).");
  }
  return report.complete ? 0 : 2;
}
try { process.exitCode = await main(process.argv.slice(2)); }
catch { console.error("No Slop: operational error"); process.exitCode = 2; }
