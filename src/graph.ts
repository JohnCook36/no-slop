export interface Edge { from: string; to: string }
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function stronglyConnected(nodes: readonly string[], edges: readonly Edge[]): string[][] {
  // Iterative Kosaraju. Each vertex is finished once; reversed graph discovers components.
  const forward = new Map<string, string[]>(), reverse = new Map<string, string[]>();
  for (const n of nodes) { forward.set(n, []); reverse.set(n, []); }
  for (const e of edges) { forward.get(e.from)?.push(e.to); reverse.get(e.to)?.push(e.from); }
  const visited = new Set<string>(), finish: string[] = [];
  for (const start of [...forward.keys()].sort(cmp)) {
    if (visited.has(start)) continue;
    visited.add(start);
    const stack = [{ node: start, next: 0 }];
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const neighbors = forward.get(top.node)!;
      if (top.next === neighbors.length) { finish.push(top.node); stack.pop(); continue; }
      const next = neighbors[top.next++]!;
      if (forward.has(next) && !visited.has(next)) { visited.add(next); stack.push({ node: next, next: 0 }); }
    }
  }
  visited.clear();
  const components: string[][] = [];
  for (let i = finish.length - 1; i >= 0; i--) {
    const start = finish[i]!;
    if (visited.has(start)) continue;
    const queue = [start], members: string[] = [];
    visited.add(start);
    while (queue.length) {
      const n = queue.pop()!;
      members.push(n);
      for (const prev of reverse.get(n)!) {
        if (reverse.has(prev) && !visited.has(prev)) { visited.add(prev); queue.push(prev); }
      }
    }
    if (members.length > 1) components.push(members.sort(cmp));
  }
  return components.sort((a, b) => cmp(a[0]!, b[0]!));
}
export function witness(component: readonly string[], edges: readonly Edge[]): string[] {
  if (component.length < 2) return [];
  const allowed = new Set(component), start = component[0]!;
  const out = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!allowed.has(e.from) || !allowed.has(e.to) || e.from === e.to) continue;
    if (!out.has(e.from)) out.set(e.from, new Set());
    out.get(e.from)!.add(e.to);
  }
  const queue = [start], parent = new Map<string, string | null>([[start, null]]);
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i]!;
    for (const next of [...(out.get(at) ?? [])].sort(cmp)) {
      if (next === start && at !== start) {
        const path = [at];
        let p = parent.get(at);
        while (p != null) { path.push(p); p = parent.get(p); }
        return [...path.reverse(), start];
      }
      if (!parent.has(next)) { parent.set(next, at); queue.push(next); }
    }
  }
  return [];
}
