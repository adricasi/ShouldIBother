# Release checklist (T-020)

The builder runs these checks on Saturday 24 Oct 2026 before the 14:00 freeze and before the post is
published. Tick each box when the check passes and write what you saw in the "Result" line. The
agent drafted this list and the README; none of the checks below has been run yet.

Traces: NFR-001, NFR-002, NFR-008, NFR-011, AC-014.6. Task: T-020 in
[tasks.md](spec/tasks.md). Do not tick T-020 in `tasks.md` until every box here is ticked.

## 1. Network capture shows only Open-Meteo (NFR-002)

Goal: during one full capture, bet and settle cycle on the real app, the laptop talks to no host
other than Open-Meteo.

- [ ] Start the app on the real model: `npm run build && npm start`. Note the date and time.
- [ ] Warm the caches that would cause unrelated traffic: Ollama is already running with the model
      pulled, and `npm ci` is finished (setup downloads are not part of the capture).
- [ ] Start the capture in a second terminal. Capture everything except loopback:

  ```bash
  sudo tcpdump -i any -n 'not host 127.0.0.1 and not host ::1' -w capture.pcap
  ```

  Keep `capture.pcap` outside the repository (it is not in `.gitignore`).
- [ ] On the phone, do one full cycle: type a chore or tap a chip, read the odds, place the bet,
      add a photo, wait for the settle time (or use a chore with the shortest settle bound), answer
      with an after photo, read the verdict. Include one "I'll do it" if time allows.
- [ ] Stop the capture (Ctrl-C in the tcpdump terminal).
- [ ] List the remote hosts. DNS names first, then the addresses that were contacted:

  ```bash
  # DNS names the laptop looked up
  tcpdump -n -r capture.pcap 'udp port 53' 2>/dev/null | grep -oE ' A\? [^ ]+' | sort | uniq -c | sort -rn
  # TLS server names (SNI) in the handshakes
  tshark -r capture.pcap -Y 'tls.handshake.type == 1' -T fields -e ip.dst -e tls.handshake.extensions_server_name 2>/dev/null | sort | uniq -c | sort -rn
  # every remote address that carried traffic, as a fallback if tshark is not installed
  tcpdump -n -r capture.pcap 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+ [>:]' | awk -F. '{print $1"."$2"."$3"."$4}' | sort | uniq -c | sort -rn
  ```

  If `tshark` is missing: `sudo apt install tshark`. The phone talks to the laptop over the LAN, so
  the phone's private address (192.168.x.x or 10.x.x.x) appears as a peer of the app port: that is
  expected and is not an outbound host.
- [ ] Every name that is not the phone or the LAN is one of the five Open-Meteo hosts of the weather
      client's allowlist (`src/domain/open-meteo.ts`): `api.open-meteo.com`,
      `previous-runs-api.open-meteo.com`, `historical-forecast-api.open-meteo.com`,
      `archive-api.open-meteo.com`, `geocoding-api.open-meteo.com`. During the live capture, bet and settle cycle expect **only
      `api.open-meteo.com`**: the forecast, and the recent hours used for settlement, both come from
      it. The previous-runs, historical-forecast and archive hosts appear only when you run
      `sib snapshot` or `sib backtest`, and the geocoding host only when you press Search in the
      onboarding place search; seeing one during the live cycle is a failure to explain.
      Anything else (telemetry, CDN, font host, update checks, Ollama registry, Hugging Face) is a
      failure: find the cause and fix it before publishing.
- [ ] The host names in `src/domain/open-meteo.ts` carry an "UNVERIFIED" comment. Compare them with
      the names in the capture; if the capture shows a different Open-Meteo host, fix the constant,
      remove the comment and re-run the capture.
- [ ] Also confirm the app made no call to another host from its own logs: nothing in the console
      output names a non-Open-Meteo URL.

Result: `TODO(builder): hosts seen, date, capture duration`

## 2. Fresh clone to running app in 30 minutes (NFR-011)

Goal: someone with only the README gets from `git clone` to a paired phone in 30 minutes, not
counting the model download.

- [ ] Prerequisites exist: WSL2 Ubuntu, NVIDIA driver visible in WSL (`nvidia-smi`), Ollama
      installed, Node 24 available (`nvm`). Pre-pull the models first so the download is excluded.
- [ ] Start the clock and clone into a new folder, using only the README:

  ```bash
  cd "$(mktemp -d)" && date +%T && git clone https://github.com/adricasi/ShouldIBother.git && cd ShouldIBother
  time (nvm install && npm ci && npm run build)
  ```

- [ ] Follow the README top to bottom: `config/models.json`, optional config copies, mirrored
      networking and firewall, `npm start`, scan the QR code with the phone. Do not use anything not
      written in the README. Write down every step where you had to guess.
- [ ] Stop the clock when the phone shows Today. Total time (excluding model download):
      `TODO(builder)` minutes. Target: 30 minutes or less.
- [ ] The fresh clone uses its own data folder so the live data is not touched:
      `SIB_DATA_DIR=$(mktemp -d) npm start`.
- [ ] Every README gap found is fixed in the README, and the run is repeated if the gap cost more
      than a minute.

Result: `TODO(builder): minutes, gaps found`

## 3. Ollama listens on 127.0.0.1 only (NFR-001)

- [ ] With the app and Ollama running:

  ```bash
  ss -ltnp | grep -E ':(11434|8787)\b'
  ```

  Expected: port 11434 is on `127.0.0.1:11434` only (never `0.0.0.0:11434`, `*:11434` or
  `[::]:11434`). The app port 8787 (or your `SIB_PORT`) is on 127.0.0.1 and the LAN address only,
  not on `0.0.0.0`.
- [ ] `echo "$OLLAMA_HOST"` is empty in the shell and in the Ollama service environment.
- [ ] No Windows firewall rule or `netsh` port proxy exists for 11434:
      `netsh interface portproxy show all` (PowerShell) and
      `Get-NetFirewallRule -Direction Inbound -Enabled True | Get-NetFirewallPortFilter | Where-Object LocalPort -eq 11434`
      list nothing for 11434.
- [ ] From the phone, `http://<laptop-ip>:11434` does not load.
- [ ] Gitleaks is clean and the dependency audit is clean on the final commit:

  ```bash
  npm audit --audit-level=high
  uvx pre-commit run --all-files
  ```

Result: `TODO(builder): paste the ss lines`

## 4. Q-9: challenge rules check

- [ ] Open the Week 3 rules page of the DEV Hacktoberfest Open-Source AI Challenge and read it now,
      not from memory. URL: `TODO(builder): paste the rules page URL`.
- [ ] **Repo window:** does the repository have to be created between 19 and 25 Oct 2026? Compare
      with the repository's creation date (`gh repo view adricasi/ShouldIBother --json createdAt`).
      If the window is not met, decide with the rules text in hand (new repo, or ask the organisers)
      before making anything public.
- [ ] **Licence:** is an open-source licence required, and is MIT (see `LICENSE`) accepted?
- [ ] **Required tags, categories and post template headings** match
      [docs/post/draft.md](post/draft.md) (Overall and Best Use of Gemma).
- [ ] Copy what the page says into `docs/spec/product.md`, close Q-9 there (it is still open), and
      record any rule that changes the plan.

Result: `TODO(builder): what the rules page says, with the date you read it`

## 5. Q-11: fine-tuned adapter on Hugging Face (by hand)

- [ ] T-014's hold-out report says whether the fine-tune is worth publishing. If not, leave the
      `finetunedBookmaker` flag off and say so in the post; skip the rest of this section.
- [ ] Create or choose the Hugging Face repo (name recorded in Q-11 of `docs/spec/product.md`).
      The token lives in your environment only (never in the repo or app).
- [ ] Upload only the adapter (and the model card). Never upload the base weights, the dataset or
      anything from `config/household.json`:

  ```bash
  # TODO(builder): exact command, for example: huggingface-cli upload <user>/<repo> <adapter-dir> .
  ```

- [ ] The model card states: base model and Gemma terms, the training data (public Barcelona
      weather outcomes and a fixed synthetic habit profile, never household data), the hold-out
      results with N, the licence and the link to this repository.
- [ ] The repo link is in the README (section "Set up") and in the post, and the adapter's digest
      or revision is written next to it.
- [ ] Close Q-11 in `docs/spec/product.md`.

Result: `TODO(builder): Hugging Face URL`

## 6. Flags for unfinished features are off

- [ ] Show the flags as committed:

  ```bash
  cat config/flags.json
  git diff origin/main -- config/flags.json
  ```

- [ ] Every flag is `false` unless its feature is merged, checked on the real app and listed as
      done in `docs/spec/tasks.md`. For each flag that is `true`, write down the task that was
      checked: `TODO(builder)`.
- [ ] The README flag table matches `config/flags.json` and `FLAG_NAMES` in
      `src/server/flags.ts` (13 flags today).
- [ ] With the final flags, the app starts, and a flag that is off shows no UI entry point and
      exposes no route (AC-029.2). The `voice` flag stays off unless T-028 is merged.
- [ ] The post and the README describe flagged features as "next", not as shipped (freeze rule in
      `docs/spec/tasks.md`).

Result: `TODO(builder): flags that are on`

## 7. Migrations 0001 to 0014 run on a copy of the live database

Run on a copy, never on the live data folder. Stop the app first (the copy needs the WAL merged).

- [ ] Copy the data folder:

  ```bash
  pkill -f "dist/cli.js start" || true
  cp -a ~/.should-i-bother /tmp/sib-migration-check
  ls /tmp/sib-migration-check
  ```

- [ ] Start the final build against the copy and watch it migrate; use a different port so the live
      app is not disturbed:

  ```bash
  SIB_DATA_DIR=/tmp/sib-migration-check SIB_PORT=8799 npm start
  ```

  No error at start-up, and all migrations from `0001` to `0014` (see `src/server/migrations/`)
  are applied. Check the highest applied version (the migrations table name is in
  `src/server/migrations/`; `TODO(builder): command or query you used`).
- [ ] Open the copy from the phone or `curl` with a paired session: Today, Slips and Score load
      and the totals equal the live app's totals.
- [ ] `PRAGMA integrity_check;` on the copy returns `ok`.
- [ ] Delete the copy: `rm -rf /tmp/sib-migration-check`.
- [ ] Restart the live app and confirm it migrates the same way.

Result: `TODO(builder): highest migration applied, integrity_check output`

## 8. `/review-all` on the final diff

- [ ] Run `/review-all` on the final diff against `main` (all Claude reviewers plus Gemini),
      including `security-auditor` and `bookie-rules-reviewer`.
- [ ] No open Blockers. Should-fix findings are fixed or listed in the PR description with a reason.
- [ ] The full local suite passes on the final commit:

  ```bash
  npm ci && npm run lint && npm run typecheck && npm test && npm run build
  npm run test:e2e
  (cd training && uv sync && uv run ruff check . && uv run pytest)
  ```

- [ ] CI is green on the final commit (Node job, Python job, gitleaks, audit).
- [ ] Licences match NFR-008: `LICENSE` (MIT), `THIRD-PARTY.md` (fonts OFL, Lucide ISC), the Gemma
      terms and the Open-Meteo attribution (AC-014.6) appear in the README, and the attribution
      appears in the footer of Today on the running app.
- [ ] No photos, database, export, `capture.pcap`, `config/household.json` or `config/server.json`
      are tracked: `git ls-files | grep -E '\.(db|sqlite|pcap|jsonl|gguf|jpe?g|png|heic)$|household\.json|server\.json'`
      lists only the intended images in `docs/images/` (the Figma mockups). Look at every
      photo and screenshot in the repository and the post by hand (gitleaks does not catch images).

Result: `TODO(builder): review-all summary link`

## 9. Make the repository public

Do this last, after sections 1 to 8, and before the post is published. Only the builder can do it.

- [ ] Final check of history for secrets and household data:

  ```bash
  uvx pre-commit run --all-files
  gitleaks detect --source . --log-opts="--all"
  ```

- [ ] README renders on GitHub (pairing section, flag table, screenshot placeholder replaced).
- [ ] The README "Later commits" section has the freeze commit filled in.
- [ ] GitHub, Settings, General, Danger zone, "Change repository visibility", Public.
- [ ] Open the repository in a private browser window (not signed in): code, README, LICENSE and
      images load.
- [ ] Paste the public URL into the post and confirm the repo date is inside the challenge window
      (section 4).

Result: `TODO(builder): date and time made public`

## Open follow-ups

Not blockers for the post; record them in the post as "next" where they matter.

- **Playwright e2e is not in CI.** Running it in GitHub Actions needs a change to
  `.github/workflows/ci-node.yml` (install a browser, build, run `npm run test:e2e`). That folder
  is on the "Do not touch without asking" list, so it needs the builder's approval.
- **`gitleaks-action` is pinned by tag, not by commit SHA** (`gitleaks/gitleaks-action@v3` in
  `.github/workflows/security.yml`). Pin it to a full commit SHA, like the repo's rule for GitHub
  Actions versions. Same approval as above.
- **T-031 habits note.** The live app sends `{}` as the habit profile to the bookmaker, while the
  fine-tune rows use a fixed synthetic habit profile. T-014 evaluates both, so state in the results
  which one the headline number uses and that the other is reported beside it.
