# Should I Bother?

A local Gemma 4 bookmaker that bets on doing nothing

> Global engineering standards are loaded automatically from `~/ai-toolkit/AGENTS.md`
> (Claude Code via `~/.claude/CLAUDE.md`, Gemini via `~/.gemini/AGENTS.md`).
> This file only adds what is specific to this project. Keep it short and current.

## Specification
Specification: `docs/spec/` — the source of truth: `product.md` (why), `requirements.md`
(what, with REQ/AC IDs), `design.md` (how), `tasks.md` (plan and slots). Build with the
`implement-task` skill; change the spec first (`spec` skill) when requirements change.
Reference IDs in commits.

## Project overview
"The Lazy Bookie": a local Gemma 4 E4B bookmaker that turns weather chores (balcony plants and
line-drying in the core loop; laundry overnight, AC and heater later) into bets on doing nothing, and settles each bet on evidence (modelled
recent weather + an after photo or one tap). Entry for the DEV Hacktoberfest Open-Source AI
Challenge Week 3 (Overall + Best Use of Gemma); feature freeze Sat 24 Oct 2026 14:00 Madrid,
publish by 23:00 the same day.

## Stack
- TypeScript (strict) on Node.js 24 (pinned: `.nvmrc`, `engines` `>=24 <25`), ESM
- Fastify, React + Vite, zod, better-sqlite3, sharp, pino
- Vitest (+ v8 coverage), ESLint (typescript-eslint, type-checked), Prettier, npm audit
- Python only in `training/` (uv, ruff, pytest) for the QLoRA fine-tune

## Architecture
Everything runs on one laptop (WSL2 + NVIDIA GPU): one Fastify process serves the React SPA
and JSON API, stores data in SQLite + a photos folder (`~/.should-i-bother/`, outside the
repo) and runs a 60 s scheduler loop. Gemma runs in Ollama on 127.0.0.1 behind a
`ModelClient` interface (Ollama · llama.cpp for audio · Fake with recorded fixtures). The
phone pairs over home Wi-Fi with a one-time token. In home mode the only outbound call is Open-Meteo (hosted mode: see the rule below).
Details: [design.md](docs/spec/design.md) and ADRs 0002–0008 in `docs/adr/`.

## Commands
```bash
npm ci                                   # install from lockfile
npm test                                 # tests (npm test -- --coverage)
npm run lint && npm run typecheck        # lint + types
npm run format                           # format
npm run build                            # compile to dist/
npm run test:e2e                         # Playwright journey at phone width (builds the SPA first; fake model + weather)
npm audit --audit-level=high             # dependency vulnerabilities
```

## Project rules
- Keep this repository's CI green; run the commands above before committing.
- Record significant decisions as ADRs in `docs/adr/` (use the `adr` skill).
- Tests and CI use the fake model (`FakeModelClient`, `test/fixtures/gemma/`) and fake
  weather: no GPU, model or network. Only builder tasks touch the real model.
- Stacked PRs: branch from the parent branch named in the task brief; the builder merges in
  stack order. Use the migration number given in the brief.
- Unfinished Should/Could features ship behind a flag in `config/flags.json`, off by default.
- Prompts are versioned files in `prompts/<job>.v<n>.md`; a prompt change bumps the version
  and re-records its fixtures. Fixtures are keyed by job + scenario name, never by input hash.
- Migration tests in agent tasks run on a seeded fixture database; the builder checks each
  migration on a copy of the live database at merge.

## Domain rules
- Gemma decides; code executes. Gemma returns an odds band (very likely · likely · toss-up ·
  unlikely · very unlikely → 85/70/50/35/15 %), never a raw percentage. Points, savings,
  settle-time bounds and safety are computed by code.
- The rule baseline is computed for every card and stored on every bet. Gemma ≥ 2 bands
  from the rule must explain or ask; no `get_forecast` call → retry once, then rule odds.
- Odds, band and payouts are locked at bet time. Undo only within 5 min.
- Safety is never a bet: the fixed heat/frost/storm backstop overrides Gemma.
- Settlement is always a Gemma verdict, never the rule. Gemma offline → the bet waits.
  No answer 24 h after settle time → auto-settle at ×0.5.
- Win = (100 − odds) × multiplier (photo ×1.0, tap/auto ×0.5), rounded half up; losses
  −25/−50/−150 regardless of evidence; do-it +5/−10.
- Savings count only on wins; time only for skipped steps; net time subtracts 30 s per bet;
  every figure shows its assumption.
- Rule-odds bets (`odds_source = rule`) never count toward Gemma's calibration. Calibration counts
  every win as a success, lucky wins included; `lucky_win` is computed by code from the outcome
  labels (`src/domain/outcomes.ts`), never by Gemma.
- Rule and safety thresholds in `config/rules.json` are final for this version: no tuning.
- Backtest and fine-tune decide only on forecasts from model runs started before the
  decision time (Previous Runs, day-1 lead); no Sep–Oct hold-out data in any training
  target or rule threshold; fine-tuned results are headlined on Sep–Oct only.
- Committed Gemma fixtures come from staged or synthetic inputs only, reviewed by hand.
- Fine-tune rows use a fixed synthetic habit profile; nothing from `config/household.json` may
  appear in the dataset (the build fails if it does).
- The weather client calls only the allowlisted Open-Meteo hosts. All times are Europe/Madrid.
- One GPU user at a time: stop Ollama (`ollama stop`) before training.
- Household data (photos, chore text, habits, audio) never leaves the laptop or enters git;
  photos are stripped of EXIF and resized to ≤ 1024 px. Ollama stays on 127.0.0.1.
- Hosted mode (REQ-032) is optional and off by default: it may call only DigitalOcean's inference
  host besides Open-Meteo, reads its key from the environment only, keeps photos on the server
  unless `SIB_DO_VISION=1`, and must say on screen that Gemma runs at DigitalOcean. Agents prepare
  the deployment; the builder runs `terraform apply` and the deploy.

## Project kit
Local to each machine: this repository is public, so `.claude/` is git-ignored. Recreate the
files from this list with the `project-kit` skill when you work from a fresh clone; cloud
workers get the checklists in their task brief.
- Skill `gemma-job` (`.claude/skills/gemma-job/`): checklist for adding or changing a Gemma
  job: versioned prompt, zod schema, retry budget and deadline, fixtures by job + scenario,
  decision logging, eval set. Use for T-006, T-007, T-009, T-013, T-022, T-028, T-030, T-038, T-039.
  (REQ-002/003/005/008/012/021/027/028/030/031, NFR-004/007/010)
- Subagent `bookie-rules-reviewer` (`.claude/agents/`): read-only check of a diff against
  odds, points, settlement, savings, rules, outcome labels, calibration populations and
  leakage. Use with `code-reviewer` on T-004, T-008, T-009, T-011, T-015, T-016, T-031, T-038.
  (REQ-006/008/009/011/013/016/018/019/020/030)
- Permissions (`.claude/settings.json`): routine npm/npx test, lint and build commands
  allowed; agents may not read or edit household data (`~/.should-i-bother/**`, `data/**`;
  NFR-002).

## Do not touch without asking
- `.github/workflows/` (CI and security gates) — the Node 24 pin and the `training/` Python
  job in T-002 are approved (2026-10-21)
- `.claude/settings.json`, `.agents/` (agent configuration)
- `infra/` state/backend configuration
