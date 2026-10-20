# Should I Bother?

A local Gemma 4 bookmaker that bets on doing nothing

> Global engineering standards are loaded automatically from `~/ai-toolkit/AGENTS.md`
> (Claude Code via `~/.claude/CLAUDE.md`, Gemini via `~/.gemini/AGENTS.md`).
> This file only adds what is specific to this project. Keep it short and current.

## Specification
`docs/spec/` is the source of truth: `product.md` (why), `requirements.md` (what, with
REQ/AC IDs), `design.md` (how), `tasks.md` (plan). Build with the `implement-task` skill;
change the spec first (`spec` skill) when requirements change. Reference IDs in commits.

## Project overview
<!-- Filled by the `spec` skill from docs/spec/product.md (3–5 lines). -->

## Stack
- TypeScript (strict) on Node.js LTS, ESM
- Vitest (+ v8 coverage), ESLint (typescript-eslint, type-checked), Prettier, npm audit

## Architecture
<!-- Filled by the `spec` skill: short summary + link to docs/spec/design.md and ADRs. -->

## Commands
```bash
npm ci                                   # install from lockfile
npm test                                 # tests (npm test -- --coverage)
npm run lint && npm run typecheck        # lint + types
npm run format                           # format
npm run build                            # compile to dist/
npm audit --audit-level=high             # dependency vulnerabilities
```

## Project rules
- Keep this repository's CI green; run the commands above before committing.
- Record significant decisions as ADRs in `docs/adr/` (use the `adr` skill).
<!-- TODO: add project conventions agents must follow (naming, module boundaries, API style). -->

## Domain rules
<!-- Filled by the `spec` skill: invariants from docs/spec/requirements.md. -->

## Project kit
<!-- Filled by the `project-kit` skill: project-specific agents/skills and when to use them. -->

## Do not touch without asking
- `.github/workflows/` (CI and security gates)
- `.claude/settings.json`, `.agents/` (agent configuration)
- `infra/` state/backend configuration
