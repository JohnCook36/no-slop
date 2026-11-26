# NS-003 architecture preview
Run node dist/cli.js check PATH --format json. This produces six advisory rule families on the partial local semantic graph. Exit 2 is deliberate: no clean gate is claimed. Programmatic architecture(report, thresholds) accepts positive integer overrides for tangleSize, exposedOperations, maxDirectoryEntries and maxFileLines. CLI configuration and policy gates are future work.

ARCH-001: possible runtime cycles among inferred modules, source edge evidence and a closed witness. Type-only edges excluded.
ARCH-002: symbol SCCs across inferred modules or larger than configured threshold, grouping class members, narrowly normalizing direct synchronous parameter-forwarding free functions. Raw semantic references retained separately.
ARCH-003: direct external writes/increments to public mutable properties of a class with private/protected state and nonstatic behavior. Not comprehensive escape analysis.
ARCH-004: observed cross-module calls relative to the count of local operations, excluding simple forwarding candidates. This is a low-confidence heuristic, not a public API inventory.
ARCH-005/006: relevant immediate directory entries and physical file lines; default preview thresholds 15/2000. Large tangles/API surface defaults 7. These are suggestions, not universal quality policy.

All findings are warnings; evidence locations, deterministic SHA-256 identity and counts accompany them. Evidence is capped at 30 entries per finding. Paths/symbol names may be sensitive. No original Rust code copied. No automated modification, baseline update or execution of target code.

Known limits: inferred module groups rather than configured hierarchy, no complete external symbol resolution, dynamic dispatch, nested/member forwarding, getter/alias escape detection, or reliable type-only classification in every complex expression. Some writes outside named declarations are missed. Cycles may be intentional. Layout counts eligible sources, not git tracking. Fingerprints do not yet support reliable refactor matching. Semantic CPU/memory not bounded by the inventory time limit. No production deployment or real-project calibration. Use read-only OS-isolated snapshots for untrusted projects. CI and manual review required.
