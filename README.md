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

## Pairing a device
`npm run dev` / `sib start` listens on 127.0.0.1 and the laptop's private LAN address only
(override with `SIB_LAN_ADDRESS`, port with `SIB_PORT`), prints the Host allowlist, and prints a
pairing link and QR code valid for 10 minutes and 3 devices. Open it on the phone: it sets a
30-day cookie and redirects to `/`. More commands:
- `sib pair`: print a new link (older unused links stop working; paired devices stay signed in).
- `sib forget-devices`: sign every device out and cancel pending links.

Data lives in `~/.should-i-bother/` (`SIB_DATA_DIR` to change). `config/server.json`
(git-ignored; copy `config/server.example.json`) lists `publicOrigins` (e.g. a Tailscale Serve
`https://<machine>.<tailnet>.ts.net`) and `allowedHosts` (e.g. the Windows LAN IP behind a netsh
portproxy). Known limit: over plain HTTP on the LAN the cookie can be sniffed by someone already
on the Wi-Fi; use the Tailscale Serve origin for HTTPS (ADR-0007).

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
