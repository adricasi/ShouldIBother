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

## The walking skeleton (T-004)
`npm run dev` builds the app screens (`dist/web`) and starts the server, which serves them behind
the same pairing guard. The server uses Gemma through Ollama when `config/models.json` names a
model (`models.<primary>.tag`) and Ollama answers on 127.0.0.1; otherwise it runs on the fake model
(`test/fixtures/gemma/`) and says so loudly at start-up and on Today. Typed sentences go through
the Gemma listener; each weather card shows rule odds at once and Gemma's odds when they arrive
(or "Gemma offline · rule odds" with Retry after 45 s). The Ollama wire format is unverified
until T-010 runs it on the laptop (`src/server/model/ollama-wire.ts`). The weather is Open-Meteo, or fake weather
without a network when you start with `SIB_FAKE_WEATHER=1`. On the
phone: tap the "Water plants" or "Line-dry today" chip, read the rule odds, tap "Bet: do nothing"; once the settle time
has passed (the scheduler checks every 60 s) the bet appears under "Settle now" with one-tap
answers, and the fake judge's verdict and points are shown. After changing a screen, run
`npm run build:web` and reload. `npm run dev` builds the app screens once, when it starts: after
editing a screen, restart it (each restart prints a new pairing link) or run `npm run build:web`.

## Weather and attribution
Odds come from the Open-Meteo forecast for the neighbourhood coordinates in `config/household.json`
(`location`, rounded to 2 decimals before every request). The weather client calls only the four
Open-Meteo hosts of its allowlist (forecast, Previous Runs, Historical Forecast, archive) and counts
its calls (budget 1,000 a day). The app shows this attribution on Today:

> Weather data by Open-Meteo.com (https://open-meteo.com/), licensed CC BY 4.0.

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
