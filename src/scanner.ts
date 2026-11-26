import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";

export interface Limits {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxEntries: number;
  maxDepth: number;
  maxMs: number;
}
export const defaults: Readonly<Limits> = Object.freeze({
  maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 128 * 1024 * 1024,
  maxEntries: 100_000, maxDepth: 64, maxMs: 30_000,
});
export interface FileInfo { path: string; bytes: number; lines: number }
export interface ScanReport {
  schemaVersion: 1;
  stage: "inventory";
  complete: boolean;
  coverage: { entries: number; files: number; bytes: number; excluded: number };
  files: FileInfo[];
  issues: { path: string; code: string }[];
}
const excluded = new Set(["node_modules", "dist", "build", "coverage", "generated", "__generated__", "target"]);
const source = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const sensitive = /(?:^|[._-])(?:env|credentials?|secrets?|passwords?|private[-_]?key)(?:[._-]|$)/i;
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const inside = (root: string, name: string) => {
  const rel = relative(root, name);
  return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
};
const display = (root: string, name: string) => relative(root, name).split(sep).join("/") || ".";
const failure = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "READ_FAILED";
};
export async function scan(rootInput: string, limits: Limits = defaults, capture?: (path: string, text: string, kind: "source" | "config") => void): Promise<ScanReport> {
  for (const key of Object.keys(defaults) as (keyof Limits)[]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0) throw new Error("INVALID_LIMIT");
  }
  const report: ScanReport = {
    schemaVersion: 1, stage: "inventory", complete: true,
    coverage: { entries: 0, files: 0, bytes: 0, excluded: 0 }, files: [], issues: [],
  };
  const note = (path: string, code: string) => {
    report.complete = false;
    report.issues.push({ path, code });
  };
  const started = performance.now();
  const expired = () => performance.now() - started > limits.maxMs;
  const input = resolve(rootInput);
  let root: string;
  try {
    const info = await lstat(input);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("INVALID_ROOT");
    root = await realpath(input);
  } catch (error) {
    note(".", (error as Error).message === "INVALID_ROOT" ? "INVALID_ROOT" : failure(error));
    return report;
  }
  const pending: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  let stopped = false;
  while (pending.length && !stopped) {
    const { dir, depth } = pending.pop()!;
    if (expired()) { note(".", "TIME_LIMIT"); break; }
    if (depth > limits.maxDepth) { note(display(root, dir), "DEPTH_LIMIT"); continue; }
    try {
      const info = await lstat(dir);
      if (info.isSymbolicLink() || !info.isDirectory() || await realpath(dir) !== dir) {
        note(display(root, dir), "UNSAFE_PATH"); continue;
      }
      // Streaming directory traversal bounds memory even for very wide directories.
      const handle = await opendir(dir);
      for await (const entry of handle) {
        if (expired() || report.coverage.entries >= limits.maxEntries) {
          note(".", expired() ? "TIME_LIMIT" : "ENTRY_LIMIT"); stopped = true; break;
        }
        report.coverage.entries++;
        const name = entry.name;
        if (name.startsWith(".") || excluded.has(name.toLowerCase()) || sensitive.test(name)) {
          report.coverage.excluded++; continue;
        }
        const path = resolve(dir, name);
        const rel = display(root, path);
        if (!inside(root, path)) { note(rel, "UNSAFE_PATH"); continue; }
        try {
          const before = await lstat(path);
          if (before.isSymbolicLink()) { report.coverage.excluded++; continue; }
          if (await realpath(path) !== path) { note(rel, "UNSAFE_PATH"); continue; }
          if (before.isDirectory()) { pending.push({ dir: path, depth: depth + 1 }); continue; }
          const isConfig = !!capture && /^(?:package\.json|tsconfig(?:\.[\w-]+)?\.json)$/i.test(name);
          if (!before.isFile() || (!source.test(name) && !isConfig)) { report.coverage.excluded++; continue; }
          if (before.size > limits.maxFileBytes) { note(rel, "FILE_LIMIT"); continue; }
          if (report.coverage.bytes + before.size > limits.maxTotalBytes) {
            note(rel, "TOTAL_BYTES_LIMIT"); stopped = true; break;
          }
          const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
          try {
            const opened = await file.stat();
            if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
                opened.size !== before.size || await realpath(path) !== path) {
              note(rel, "UNSAFE_PATH"); continue;
            }
            const data = Buffer.alloc(opened.size + 1);
            let count = 0;
            while (count < data.length) {
              if (expired()) break;
              const result = await file.read(data, count, data.length - count, count);
              if (!result.bytesRead) break;
              count += result.bytesRead;
            }
            const after = await file.stat();
            if (expired()) { note(rel, "TIME_LIMIT"); stopped = true; break; }
            if (count !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs ||
                await realpath(path) !== path) { note(rel, "CHANGED_DURING_READ"); continue; }
            report.coverage.bytes += count;
            let text: string;
            try { text = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, count)); }
            catch { note(rel, "INVALID_UTF8"); continue; }
            if (capture) capture(rel, text, isConfig ? "config" : "source");
            if (isConfig) continue;
            const lines = text.length ? text.split(/\r\n|\r|\n/).length - (/\r$|\n$/.test(text) ? 1 : 0) : 0;
            report.files.push({ path: rel, bytes: count, lines });
            report.coverage.files++;
          } finally { await file.close(); }
        } catch (error) { note(rel, failure(error)); }
      }
    } catch (error) { note(display(root, dir), failure(error)); }
  }
  report.files.sort((a, b) => order(a.path, b.path));
  report.issues.sort((a, b) => order(a.path, b.path) || order(a.code, b.code));
  return report;
}
