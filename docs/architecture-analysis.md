# Semantic architecture analysis — independent implementation design

Status: proposed implementation specification; not implemented or benchmarked.
Reference studied: deterministic-machines/deslop-please, commit 64d43a31e194f191b7b0b80861d12c5fa1a0dbf6, version 0.1.6. No source code is copied. The goal is independent JS/TS algorithms informed by the observed behavior and standard graph theory.

## Architecture

Scan engine (NS-001) -> TypeScript semantic adapter (NS-002) -> normalized intermediate representation -> graph engine -> architecture rules -> deterministic evidence and baseline.

Use TypeScript Compiler API createProgram and TypeChecker with a restricted CompilerHost over vetted files and trusted TypeScript standard libraries. Read JSON/JSONC configuration as data. Resolve imports, re-exports, workspace manifests, TS path aliases and symbol aliases; distinguish runtime/type-only/dynamic edges. Never execute scanned project code, plugins, JS config, generators or package scripts. No unrestricted filesystem reads, network, or target writes. Unknown or unresolved references affect coverage, not fabricated edges. JS support is best-effort; record unsupported dynamic patterns, framework DI and configuration coverage explicitly.

IR: workspace/package/module/file/symbol IDs; definitions and owner; reference edges with kind (import, call, construct, read, write, type-reference, re-export, delegation); source span; test/generated classification; resolution confidence. IDs deterministic across runs, not derived only from line numbers. Module boundaries explicit in JSON policy; fallback inferred boundaries marked as such. Distinguish file import graph, module graph and symbol graph. Normalize alias/re-export chains; conservatively collapse only provable pure forwarding wrappers with no added business behavior; preserve original source evidence and bound cycle traversal.

## Rules

- ARCH-001 module-cycle: SCCs (independent iterative Tarjan or Kosaraju) of runtime module graph; distinguish type-only cycles, sibling aggregation and package boundaries; report members and actual closed witness with reference locations. Configured forbidden module edges can block; inferred architectural cycles initially warn. Do not equate import graph cycles with symbol cycles.
- ARCH-002 tangle: SCCs over resolved semantic symbol dependencies, grouping methods with owning class where appropriate, not self-recursion. Report multi-module components and configurable large intra-module components. Preserve edge evidence through pure forwarding. Distinguish intentional recursion and framework patterns; warning by default.
- ARCH-003 field-leak: external direct mutations and exposure of mutable domain state through accessors, considering owner and known references. Treat DTOs, immutable values, React props and legitimate serialization separately. Do not label every public property an error. Track only provable writes/escapes; unresolved aliasing reduces confidence. Warning by default.
- ARCH-004 shallow-module: compare externally consumed meaningful operations to internal operations, ignoring trivial delegation; report counts, callers and exposed surface, not arbitrary score. Original uses shown >7, a wide list and hidden <= shown; these are reference heuristics only, not default production policy. Configurable thresholds after pilot. Warning only; never force file merging or wrapper insertion.
- ARCH-005 wide-directory and ARCH-006 long-file: count relevant tracked/eligible source files and subdirectories, physical lines respectively; reference thresholds 15 and 2000 are optional starting suggestions. Exclude generated output and honor scope; advisory only.

## Diagnostics and baseline

Each finding: rule/version, stable semantic fingerprint, severity, confidence, relative source spans, evidence edges, explanation and suggestions, coverage state. No raw secret values. Reports text/JSON, SARIF later. Baseline is separately reviewed; show existing, new, resolved, worsened, and unknown. A cycle shrinking may be improvement but a new edge within same SCC must not automatically disappear. Do not auto-update baseline or block CI on low-confidence findings. Never claim scan success if analysis incomplete.

## Regression fixtures

For each rule positive and negative examples. Include: file cycle vs module cycle without mutual symbol dependency; type-only/re-export cycles; allowed DI/container or recursive patterns; cross-module symbol tangle; wrapper that does nothing vs wrapper adding validation; simple DTO vs exposed mutable aggregate; wide but legitimate API; file move/rename and re-export not automatically hiding problem; reduction of cycle vs new edge within existing component; missing/ambiguous dynamic edges; tsconfig aliases and workspace packages; Expo/NestJS framework boundaries; large/deep graph no stack overflow. Add deterministic snapshots and performance bounds; Windows/Linux tests. No target execution or network. No real project modifications during pilot.

## Delivery order

NS-001 stays safe traversal only. NS-002 builds semantic model/graphs; NS-003 implements architecture rules incrementally, module-cycle first, then layout, tangle, field-leak, shallow-module after reference accuracy is validated. NS-004 anti-slop AST checks are separate. Baseline and CI follow. Pilot on isolated Health with Love copy, report false positives and unsupported cases before enabling blocking gates.

License selection and name validation pending. If later reusing any original code, obtain approval and retain required notices. No runtime analyzer reuse required.
