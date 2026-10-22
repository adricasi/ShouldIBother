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
`npm run dev` (or `npm start` after `npm run build`) listens on 127.0.0.1 and the laptop's private
LAN address only (`SIB_LAN_ADDRESS` overrides it and must be a private or loopback address), prints
the Host allowlist, and prints a pairing link and QR code valid for 10 minutes and 3 devices. Open
it on the phone: it sets a 30-day cookie and redirects to `/`.

The console output (allowlist, pairing links, pairing lines) goes to stderr; stdout carries the
JSON logs, so `npm start > app.log` never writes a pairing link into a file. The logs never contain
tokens or session ids.

More commands (`sib` is the built binary; in development run them through npm):
```bash
npm run sib -- pair            # print a new link; older unused links stop working, devices stay signed in
npm run sib -- forget-devices  # sign every device out and cancel pending links
```

Settings: the data folder is `~/.should-i-bother/` (`SIB_DATA_DIR` to change; it is kept at 0700
and the database files at 0600). The port is `SIB_PORT`, else `port` in `config/server.json`
(default 8787), so `sib pair` and the server always agree. `config/server.json` is git-ignored: copy
`config/server.example.json`. It also lists `publicOrigins` (e.g. a Tailscale Serve
`https://<machine>.<tailnet>.ts.net`) and `allowedHosts` (e.g. the Windows LAN IP behind a netsh
portproxy).

### Security notes
- Over plain HTTP on the LAN the session cookie can be sniffed by someone already on the Wi-Fi.
  Use the Tailscale Serve origin for HTTPS (ADR-0007); sessions paired through it use a `Secure`,
  `__Host-` cookie.
- Cookies are not isolated by port: another app on the same host name (for example another dev
  server on `localhost`) receives the session cookie. Do not run untrusted software on the laptop.
- The rate limit is per client address. Behind Tailscale Serve or a netsh portproxy every client
  shares one address, so after 10 failed requests everyone without a session is locked out for a
  minute. Paired devices are never affected. This is accepted for a one-household app.

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
