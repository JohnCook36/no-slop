# No Slop

Local-first architectural and code-quality analysis for JavaScript and TypeScript projects, including AI-assisted development.

## Status
Planning. No scanner has been implemented or validated yet.

## MVP
- Read-only source traversal and TypeScript AST analysis.
- Dependency graph, cycles, forbidden imports, suspicious stubs and vacuous tests.
- Evidence-based findings with stable rule IDs, severity and confidence.
- Text and JSON reports; baseline-aware quality gates.
- Windows and Linux support; no mandatory cloud services or API keys.

## Security model
Treat scanned repositories and configuration as untrusted data. No execution of their scripts, plugins, tests, package managers, hooks or AI instructions in default scan mode. No telemetry, network access or source modifications in default mode. Explicitly opt in to external tools in a separate trusted mode. Do not expose secrets in reports. Skip symlinks and directories outside the scan root.

## Roadmap
1. CLI and safe scan engine.
2. Architectural and Anti-Slop rules, regression fixtures.
3. Baseline, CI integration and agent workflow.
4. Optional desktop UI and other languages.

Conceptual inspiration: [deslop-please](https://github.com/deterministic-machines/deslop-please). Independent implementation planned. License for No Slop is not yet selected.
