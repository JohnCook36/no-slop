import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { scan, defaults } from "../dist/scanner.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "no-slop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test("read-only inventory, exclusions, deterministic order", async t => {
  const root = await fixture(t);
  await mkdir(join(root, "src")); await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "src", "z.ts"), "export const z = 1;\n");
  await writeFile(join(root, "a.tsx"), "const a = <div/>;\r\n");
  await writeFile(join(root, "node_modules", "skip.ts"), "throw 1;");
  await writeFile(join(root, ".env.ts"), "SECRET_VALUE");
  await writeFile(join(root, "credentials.ts"), "SECRET_VALUE");
  await writeFile(join(root, "package.json"), '{"scripts":{"preinstall":"exit 42"}}');
  const original = await readFile(join(root, "a.tsx"), "utf8");
  const first = await scan(root); const second = await scan(root);
  assert.equal(first.complete, true);
  assert.deepEqual(first, second);
  assert.deepEqual(first.files.map(x => x.path), ["a.tsx", "src/z.ts"]);
  assert.equal(first.files[0].lines, 1);
  assert.equal(await readFile(join(root, "a.tsx"), "utf8"), original);
  assert.equal(JSON.stringify(first).includes("SECRET_VALUE"), false);
  assert.deepEqual((await readdir(root)).sort(), [".env.ts","a.tsx","credentials.ts","node_modules","package.json","src"]);
});
test("file size, invalid UTF-8, invalid root and limits fail explicitly", async t => {
  const root = await fixture(t);
  await writeFile(join(root, "big.ts"), "12345");
  await writeFile(join(root, "invalid.ts"), Buffer.from([255]));
  const report = await scan(root, { ...defaults, maxFileBytes: 4 });
  assert.equal(report.complete, false);
  assert.deepEqual(report.issues.map(x => x.code), ["FILE_LIMIT","INVALID_UTF8"]);
  assert.equal((await scan(join(root, "missing"))).complete, false);
  await assert.rejects(() => scan(root, { ...defaults, maxEntries: 0 }));
});
test("directory links never followed", async t => {
  const root = await fixture(t); const outside = await fixture(t);
  await writeFile(join(outside, "private.ts"), "do not read");
  try { await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (["EPERM","EACCES","ENOSYS"].includes(error.code)) { t.skip("link creation unavailable"); return; } throw error; }
  const report = await scan(root);
  assert.equal(report.files.length, 0);
  assert.equal(report.coverage.excluded, 1);
  assert.equal((await scan(join(root, "linked"))).complete, false);
});
test("entry and depth limits are explicit", async t => {
  const root = await fixture(t);
  await mkdir(join(root, "a", "b"), { recursive: true });
  await writeFile(join(root, "a", "b", "c.ts"), "1");
  assert.equal((await scan(root, { ...defaults, maxEntries: 1 })).complete, false);
  assert.equal((await scan(root, { ...defaults, maxDepth: 1 })).issues[0].code, "DEPTH_LIMIT");
});
test("CLI JSON and exit codes", async t => {
  const root = await fixture(t); await writeFile(join(root, "a.ts"), "1");
  const cli = resolve("dist/cli.js");
  const call = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  const ok = call("scan", root, "--format", "json");
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).stage, "inventory");
  assert.equal(call("scan", join(root, "missing")).status, 2);
  assert.equal(call("bad").status, 2);
  assert.equal(call("--version").stdout.trim(), "0.1.0");
});
