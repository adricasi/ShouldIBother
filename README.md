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
the same pairing guard. The server talks to Gemma through Ollama: set the tag in
`config/models.json` (`"models": { "e4b": { "tag": "gemma4:e4b" } }`); without it the app refuses
to start. If Ollama is down, the app still starts and Today shows "Gemma is offline" (rule odds,
Retry, settlements wait). The recorded-fixture model never runs unless you set `SIB_FAKE_MODEL=1`
(`npm run dev` does; CI and tests do), and then a banner says so and Today shows "(fake model)".
Typed sentences go through the Gemma listener; each weather card shows rule odds at once and
Gemma's odds when they arrive (or "Gemma offline · rule odds" with Retry after 45 s). The Ollama
wire format is unverified until T-010 runs it on the laptop (`src/server/model/ollama-wire.ts`).
The weather is Open-Meteo, or fake weather
without a network when you start with `SIB_FAKE_WEATHER=1`. On the
phone: tap the "Water plants" or "Line-dry today" chip, read the rule odds, tap "Bet: do nothing"; once the settle time
has passed (the scheduler checks every 60 s) the bet appears under "Settle now" with one-tap
answers, and the fake judge's verdict and points are shown. After changing a screen, run
`npm run build:web` and reload. `npm run dev` builds the app screens once, when it starts: after
editing a screen, restart it (each restart prints a new pairing link) or run `npm run build:web`.

## Settling, savings and your data (T-009)
At the settle time the app fetches the recorded weather of the bet's window (labelled "modelled
recent weather", from Open-Meteo's past hours) and asks for the outcome: one tap, or an after
photo (full points). Your answer is stored first; then the Gemma judge gives the verdict. If Gemma
is offline the bet waits as "Settle when Gemma is back" with your answer kept, and the scheduler
tries again every few minutes: the rule never settles a bet. With no answer 24 hours after the
settle time the judge settles from the weather record at half points. Wins print a PAID OUT
receipt; losses show the points, Gemma's reason and fixed, non-shaming words.

Savings per won bet come from `config/savings.json` (figures with their assumption and either a
source or "typical estimate") and your dryer in `config/household.json`; the figure is written on
the bet when it is placed. Today shows the week's net time back (time saved minus 30 s per bet),
water and electricity, Monday to Sunday in Madrid time, each with its assumption.

Your data (these commands refuse to run while the app is running, so stop it first; they touch only
the files the app owns in the data folder, and `config/household.json` is never touched):
```bash
npm run sib -- export ~/sib-export         # export.json (bets, decisions, verdicts, totals) + photos/
npm run sib -- delete-photos               # asks first; removes every photo and what Gemma read from it
npm run sib -- delete-photos --all-data    # asks first; also removes the database and its WAL files
```
The export folder holds household data: keep it out of the repository.

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
