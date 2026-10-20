# Should I Bother?

A local Gemma 4 bookmaker that bets on doing nothing

## Getting started
```bash
npm ci                                   # install from lockfile
npm test                                 # tests (npm test -- --coverage)
npm run lint && npm run typecheck        # lint + types
npm run format                           # format
npm run build                            # compile to dist/
npm audit --audit-level=high             # dependency vulnerabilities
```

## Development workflow (AI-assisted, spec-driven)
Built with the personal ai-toolkit (`~/ai-toolkit`). In Claude Code:
1. `/spec` — define or refine the specification in `docs/spec/` (once, then when requirements change).
2. `/project-kit` — tailor project-specific agents and skills to the spec.
3. `/next` — implement the next task: branch, tests from acceptance criteria, code, checks, review, commit.
4. `/review-all` then `/ship` — full review (Claude + Gemini) and PR preparation.
5. `/handoff` — leave a progress note for the next session.
Commits run pre-commit (formatters, linters, gitleaks); agents may push feature branches and open pull requests; merging is done by a human.

## Specification
See [docs/spec](docs/spec/): product, requirements, design and task plan.

## Architecture decisions
See [docs/adr](docs/adr/).
