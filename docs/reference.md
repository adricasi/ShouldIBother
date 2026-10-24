# Reference: configuration, flags and commands

Every setting, feature flag and `sib` command, in one place. The step-by-step setup is in
[setup.md](setup.md); the hosted-mode procedure is in [deploy-digitalocean.md](deploy-digitalocean.md); the
design behind all of it is in [architecture.md](architecture.md) and [gemma.md](gemma.md).

Contents: [Configuration](#configuration) · [Hosted-mode settings](#hosted-mode-settings) ·
[Feature flags](#feature-flags) · [Presentation](#presentation) · [Commands (`sib`)](#commands-sib) ·
[Evaluating Gemma](#evaluating-gemma-sib-eval) · [Fine-tune dataset](#building-the-fine-tune-dataset-sib-snapshot-sib-dataset) ·
[Weather data](#weather-data-and-attribution) · [Your data](#your-data) · [Testing](#testing)

## Configuration

A few files in `config/` and some environment variables. The app starts without the git-ignored ones
(the committed `*.example.json` files are the fallback).

| File | Committed | What it holds |
|---|---|---|
| `config/models.json` | yes | Which Gemma model the app runs on, runtime addresses, tool-use and answer modes |
| `config/flags.json` | yes (all off) | Feature flags ([below](#feature-flags)); change them with `sib flags` ([Presentation](#presentation)) |
| `config/flags.presets.json` | yes | Named lists of flags to turn on together; `presentation` is the preset `sib flags` and `sib demo` use |
| `config/server.json` | no (git-ignored) | Port, extra hosts and origins ([Set up, step 3](setup.md#3-optional-config-files)) |
| `config/household.json` | no (git-ignored) | Your dryer, AC, heater and neighbourhood coordinates ([step 3](setup.md#3-optional-config-files)) |
| `config/rules.json`, `rules-rain.json`, `advice-rules.json`, `savings.json` | yes | Rule and safety thresholds (final for this version, not tuned), the city rain rules, the advice windows and the savings catalogue |

### `config/models.json`

| Key | Meaning | Default |
|---|---|---|
| `primary` | Key in `models` of the model the app runs on | `"e4b"` |
| `models.<key>` | `{ "tag", "quantization", "digest" }` for `e4b`, `e2b` (backtest comparison) and the optional `e4b-ft` (fine-tuned bookmaker) | none: `sib start` refuses to start without `models.<primary>.tag` unless `SIB_FAKE_MODEL=1` |
| `ollama.baseUrl` | Where Ollama listens; only `127.0.0.1` or `[::1]` is accepted | `http://127.0.0.1:11434` |
| `ollama.keepAlive` | How long Ollama keeps the model loaded | `24h` |
| `ollama.temperature` | Sampling temperature | `0` |
| `llamaCpp.baseUrl`, `llamaCpp.model` | The llama.cpp server for voice (flag `voice`); loopback only; `model` is only a label for the decision log | `http://127.0.0.1:8080`, `gemma4-audio` |
| `gemma.toolUse` | `native` (Gemma calls `get_forecast`) or `injected` (the app fetches the forecast and hands it over; the fallback if tool calling fails on the runtime) | `native` |
| `gemma.answerMode` | `single_call` (tool and schema together) or `two_step` (tool first, schema with the answer) | `single_call` |

The step-by-step is under [Set up](setup.md#2-install-ollama-and-pull-gemma-4). What each setting does to the
jobs: [docs/gemma.md, section 8](gemma.md#8-the-modelclient-boundary).

### Environment variables

The table is under [Development without a GPU](setup.md#development-without-a-gpu): `SIB_FAKE_MODEL`,
`SIB_FAKE_WEATHER`, `SIB_DATA_DIR`, `SIB_PORT`, `SIB_LAN_ADDRESS`. The hosted-mode variables
(`SIB_MODE`, `SIB_PUBLIC_ORIGIN`, `SIB_DO_MODEL`, `SIB_DO_INFERENCE_KEY`, `SIB_DO_VISION`,
`SIB_TOOL_USE`, `SIB_DAILY_MODEL_CALLS`, `SIB_BIND_ADDRESS`) are in the table under
[Hosted mode (optional)](#hosted-mode-settings). If you run Node with
`NODE_USE_ENV_PROXY=1` and a proxy, set `NO_PROXY=127.0.0.1,localhost,::1`: the app refuses to start
its model clients otherwise, so nothing local goes through a proxy.

## Hosted-mode settings

Home mode, everything above, is the default and stays as it is. For one household that wants to use
the app away from home without a GPU, `SIB_MODE=hosted` runs the same app on a small public server
(one DigitalOcean Droplet behind Caddy with automatic HTTPS), with Gemma from DigitalOcean's
Serverless Inference instead of Ollama. Releases are one command, `deploy/digitalocean/release.sh`
(build, push to the registry, deploy with automatic rollback). The step-by-step, costs and the
security checklist are in [docs/deploy-digitalocean.md](deploy-digitalocean.md); the decision is
[ADR-0011](adr/0011-optional-hosted-mode-on-digitalocean.md) and the requirement is REQ-032.

**The privacy trade-off, plainly.** In hosted mode **Gemma runs on DigitalOcean's inference service**.
Your chores, habits, answers to Gemma's questions and the area forecast are sent there. **Photos
stay on the server** unless you set `SIB_DO_VISION=1`; with it off (the default) photo upload is
refused, the photo buttons are gone and bets settle with one tap at half points (a photo answer
saved earlier is set aside and the bet asks for a tap). Voice and the
fine-tuned bookmaker are off. Your data (database and photos) lives on a cloud server and in its
backups, not on your laptop. The app says so on screen ("Gemma 4 · DigitalOcean · <model ID>" and a
privacy line on Today). DigitalOcean states it does not store this data or train on it; where it is
processed is not documented (ADR-0011). Home mode is unaffected and keeps "Your photos never leave
it".

How it differs, in short:

- **No accounts and no login.** Each phone is linked once and then remembered (a 30-day cookie
  renewed on use). On the server run `sib pair`; it prints `https://<your host>/pair#t=<token>` and a
  QR code to the terminal only. The page behind that link has a "Pair this phone" button; the token
  sits in the URL fragment, so no log or link preview ever sees it. `sib forget-devices` signs
  every device out.
- **Only your host answers.** The Host and Origin checks accept exactly `SIB_PUBLIC_ORIGIN`; the
  client address behind the proxy comes from `X-Forwarded-For`, believed only from the addresses in
  `SIB_TRUSTED_PROXY`.
- **A daily call cap.** At most `SIB_DAILY_MODEL_CALLS` requests to the inference API per Madrid
  day. From 80 % only judge verdicts call Gemma (cards say "Gemma's daily limit · rule odds"); at the
  cap verdicts wait ("Gemma's daily limit is used up; this settles after midnight (Madrid)") and go
  first after the reset. A request that would be refused anyway, such as a photo with vision off,
  is never sent and never counted.
- **`sib hosted-check`** calls the API once per check (model listed, JSON valid, a tool call comes
  back, a red image is seen) with a few synthetic pixels and no household data. Run it once after
  deploying, with the server's env file, then decide on `SIB_TOOL_USE` and `SIB_DO_VISION`. It is
  run by hand and its four calls are not counted against the daily cap.
- **One device per link by default.** `sib pair` makes a link for one device (`--devices 2` or
  `3` for more); `sib devices` lists who is linked. `sib forget-devices`, `sib devices` and
  `sib export` need only `SIB_MODE=hosted`, so a revoke works even with a half-written env file.
- **The container** runs as a non-root user with a read-only root filesystem. The app writes only
  in the data folder (`SIB_DATA_DIR`: the database with its `-wal`, `-shm` and `-journal` files,
  and `photos/`); that folder must be writable by the container user. Give it a small tmpfs `/tmp`
  for the image library (not used for ordinary photos). `/healthz` answers 204 without a session
  only to a request from 127.0.0.1 inside the container.

| Variable | Hosted mode | Default |
|---|---|---|
| `SIB_MODE` | `home` or `hosted`; any other value is refused. Hosted variables set in home mode are ignored with one warning | `home` |
| `SIB_PUBLIC_ORIGIN` | **Required.** `https://` origin only, e.g. `https://sib.example.com` | none |
| `SIB_DO_MODEL` | **Required.** A Gemma 4 model ID as `GET /v1/models` lists it (for example `gemma-4-31B-it`, unverified: see ADR-0011); the name must contain `gemma-4` or `gemma4` | none |
| `SIB_DO_INFERENCE_KEY` | **Required.** A model access key, inference only, read from the environment only; never logged, stored or returned | none |
| `SIB_DO_VISION` | `1` sends photos to DigitalOcean; `0` keeps them on the server | `0` |
| `SIB_TOOL_USE` | `injected` (the app calls `get_forecast` and hands Gemma the result) or `native`; overrides `gemma.toolUse` | `injected` |
| `SIB_DAILY_MODEL_CALLS` | Chat-completions requests per Madrid day, a positive whole number | `300` |
| `SIB_BIND_ADDRESS` | Address the app listens on, inside the container | `0.0.0.0` |
| `SIB_TRUSTED_PROXY` | The reverse proxy's IP address or CIDR block (comma-separated). `X-Forwarded-For` is believed only from a connection that comes from one of them; with none, the header is ignored and the connection's peer is the client for every rate limit | none |

`SIB_DATA_DIR` and `SIB_PORT` work as in home mode; `SIB_FAKE_MODEL=1` still wins over the inference
service (tests and demos), and `SIB_LAN_ADDRESS` is ignored. The settings are checked once at
start-up; a missing or invalid one refuses to start and names the variable, never its value.

## Feature flags

`config/flags.json` switches unfinished or optional features on. **Every flag is off by default**,
and a flag that is off shows no UI entry point and registers no route (REQ-029). Only the builder
turns a flag on, after merging and checking the feature. Unknown flag names are an error.

| Flag | Default | What it does when on |
|---|---|---|
| `finetunedBookmaker` | off | The bookmaker job uses the fine-tuned E4B at `models.e4b-ft` in `config/models.json` (the same key `sib backtest` uses); the listener, inspector, judge and the other jobs stay on the primary model. With no `e4b-ft` entry nothing changes and the start notice says so. Each decision and each bet records the model that priced it. The warm-up at start loads both models, one after the other, with `ollama.keepAlive`. Two E4B models may not both fit in 8 GB of VRAM; to keep both resident start Ollama with `OLLAMA_MAX_LOADED_MODELS=2` (or more) and keep `ollama.keepAlive` long, otherwise Ollama swaps them between jobs. TODO(builder): measure the 45 s job deadline with both loaded (a swap counts against it), and state here whether the adapter ships. A fine-tuned model that is not pulled shows as a warning under "Gemma is online" on Today (cards use rule odds) and as one log line |
| `safetyGuard` | off | Gemma safety guard on every card; an alert withdraws open bets on the card (the fixed heat/frost/storm backstop works without it) |
| `laundryTonight` | off | The "laundry tonight" chore, offered from one hour before sunset to two hours after |
| `score` | off | The Score screen: points, savings, judge overrule rate and Gemma-vs-rule calibration with N |
| `stampAnimation` | off | The PAID OUT stamp animation on wins (fades instead of moving with reduced motion) |
| `laundryPlanner` | off | Gemma plans laundry over the next days and you can bet on "Skip today" |
| `rescue` | off | Rescue alerts when the forecast changes, and cash-out of an open bet |
| `appeals` | off | Appeal a verdict with a photo |
| `onboarding` | off | Onboarding card and screen: your dryer, AC, heater and location |
| `ranks` | off | Ranks and achievements; shown on Score, so it needs `score` on |
| `heater` | off | The heater bet and the AC chore |
| `splitFlap` | off | The split-flap weather board on Today |
| `rainChores` | off | The city rain bets: rinse the car, rinse the bike, rinse the terrace, fill the rain barrel. The rain does the chore; settle by photo or tap, no before photo; kept out of the backtest and the Score calibration. Rule rows in `config/rules-rain.json` |
| `adviceCards` | off | Advice cards for cleaning the windows, sweeping the balcony, painting outdoors and feeding the lawn: Gemma's advisor job with `get_forecast` over 72 h, the rule advice beside it, no bet, no points. Thresholds in `config/advice-rules.json` |
| `voice` | off | Voice capture through Gemma 4 audio on llama.cpp: the "Say your chores" button on Today, shown only on HTTPS (see [voice capture](setup.md#optional-voice-capture-flag-voice)). TODO(builder): the llama.cpp wire format is unverified until a live voice note works |

## Presentation

For a rehearsal or the final demo, turn on every feature that is merged and checked with one command
(AC-029.3):

```bash
npm run sib -- flags                       # list the flags and their state
npm run sib -- flags preset presentation   # every flag on except voice and finetunedBookmaker
npm run sib -- flags on voice              # a single flag (also: off <flag>...)
```

The preset is the explicit list of flag names in `config/flags.presets.json`, which you edit. The
`presentation` list leaves out `voice` and `finetunedBookmaker`, so they stay as they are unless
you name them (`flags preset presentation voice`), because both need checks on the laptop first.
Unknown flag names (on the command line or in the presets file) are refused and nothing is
written. `sib demo` uses the same preset in memory. The file is replaced atomically and the
committed defaults stay off: do not commit your local `config/flags.json`. A running app reads the
flags at start, so **restart the app to apply** a change.

### Sample-data demo (`sib demo`)

For rehearsals and screenshots without touching your own data:

```bash
npm run build
npm run sib -- demo [--port 8788]   # prints a pairing link; Ctrl+C stops it
```

It makes a temporary data folder, fills it through the app's own code with about two weeks of
made-up bets (plants, line-dry, laundry tonight, AC and heater; photo, tap and automatic
settlements, wins and losses, a cash-out, appeals, achievements and a rank above Hyperactive
squirrel), and starts the app on it with the fake model, fake weather, a fixed date (Friday 23
October 2026, 10:00) and the `presentation` preset applied in memory. Every screen shows a
"Sample data — not real results" banner, Score is watermarked SAMPLE and labelled "Sample data ·
fake model", the rows carry `model_version = fake-demo` (Score counts them only in demo mode) and
`sib export` refuses its data folder. It never opens `~/.should-i-bother` or `SIB_DATA_DIR`,
`config/household.json` or `config/server.json`, and never writes `config/flags.json`; the
temporary folder is deleted on Ctrl+C or SIGTERM. Its numbers are never results.

Laptop checks before you turn on the two excluded flags:

- `voice` (T-028): a llama.cpp server with the Gemma 4 audio model and its projector runs on
  127.0.0.1 and answers (`llamaCpp.baseUrl` in `config/models.json`), and the phone opens the app
  from an `https://` origin ([Tailscale Serve](setup.md#optional-https-with-tailscale-serve)), because the
  microphone needs a secure page. Record one voice note end to end first; the wire format is
  unverified until one works.
- `finetunedBookmaker` (T-012, T-014): the QLoRA adapter is trained and loaded into Ollama, the
  `models.e4b-ft` entry in `config/models.json` names it and `ollama list` shows it, and the
  hold-out result on Sep-Oct is in hand (`sib backtest`, `sib eval bookmaker`). With the entry
  missing nothing changes and the start notice says so.

## Commands (`sib`)

`sib` is the built binary (`node dist/cli.js`, or `npm link` to get `sib` on your PATH). In
development run the same commands through npm: `npm run sib -- <command>`.

| Command | What it does |
|---|---|
| `sib start` | Start the server (what `npm start` runs) |
| `sib pair [--devices 1-3]` | Print a new pairing link and QR code. The link links 3 devices (hosted mode: 1 unless `--devices` says more) |
| `sib devices` | List the linked devices: when each was linked, the day it was last seen, a short summary ("iPhone · Safari") and when its session ends; never a token |
| `sib hosted-check` | Hosted mode: check the DigitalOcean API once (model listed, JSON valid, a tool call, an image seen). Uses the server's env file; see [Hosted mode](#hosted-mode-settings) |
| `sib forget-devices` | Sign out every device and cancel pending links |
| `sib export <dir>` | Write `export.json` (bets, decisions, verdicts, totals, onboarding profile, achievements) and the photos to a new, empty folder |
| `sib delete-photos [--all-data]` | Asks first; removes every photo and what Gemma read from it. With `--all-data` it also removes the database and its WAL files |
| `sib flags [list\|on\|off\|preset]` | List the feature flags, or turn them on or off in `config/flags.json`; `flags preset presentation` is described under [Presentation](#presentation) |
| `sib demo [--port N]` | Run the app on a temporary, seeded sample-data folder with the fake model and weather (see [Presentation](#presentation)); stops and deletes it on Ctrl+C |
| `sib backtest [options]` | Replays the weather snapshot with the rule, a fixed routine, E2B and E4B (and the fine-tuned model) and writes a report; resumable, `--help` lists the options |
| `sib snapshot [options]` | Downloads the Open-Meteo snapshot (Previous Runs, Historical Forecast, archive) for the backtest and the fine-tune into the data folder. Details below |
| `sib dataset [options]` | Builds `train.jsonl`, `holdout.jsonl` and `manifest.json` for the fine-tune from the snapshot, offline. Details below |
| `sib eval <job> [options]` | Runs the 20-case staged set of one Gemma job (`listener`, `bookmaker`, `inspector`, `judge`, `safety`, `laundry-planner`, `advisor`) through the real job on the configured model and reports valid JSON out of 20, tool use, model calls and latency (p50/p95/max) with the model digest and prompt version. Exit 0 when the target is met (19 of 20), 3 when missed, 2 when Gemma is unreachable. Details below |

### Evaluating Gemma (`sib eval`)

The sets are in `evals/<job>/cases.json`: synthetic text and synthetic weather, no household data.
The command checks the target of NFR-004: at least 19 of 20 schema-valid answers per job, the
bookmaker calling `get_forecast`, and the photo flow (the inspector, then the bookmaker when the inspector
saw enough; a question from the inspector ends it) valid and within 15 s in 19 of 20 cases. With `SIB_FAKE_MODEL=1` it runs on the fixtures, which only proves the
pipeline (the report says so).

```bash
npm run sib -- eval listener                 # also bookmaker, safety, laundry-planner, advisor and judge (taps)
npm run sib -- eval inspector --photos ~/eval-photos
npm run sib -- eval judge --cases evals/judge/photo-cases.json --photos ~/eval-photos
npm run sib -- eval bookmaker --out ~/sib-evals/bookmaker-1 --record-fixtures ~/sib-evals/fixtures
```

- It prints a table (valid, answer, tool use, model calls, retries, job time per case) and a summary,
  then writes `report.json` and `report.md` to `--out` (default `<data folder>/evals/<job>-<date>/`).
  A folder inside the repository is refused unless git ignores it, and an earlier report is never
  overwritten. Exit codes: 0 target met, 1 bad input, 2 Gemma unreachable, 3 target missed.
- The photo sets name the files to stage in the `--photos` folder; each case says what to photograph,
  and photos are never committed: `inspector-01-plants-dry-soil.jpg` to `inspector-20-sign-in-photo.jpg`,
  and `judge-NN-before-<what>.jpg` / `judge-NN-after-<what>.jpg` (see `evals/judge/photo-cases.json`).
  They go through the app's own photo pipeline first (at most 1024 px, no metadata).
- `--record-fixtures <dir>` also writes the model's raw answers as `<dir>/<job>/<case>.json`, in the
  format of `test/fixtures/gemma/` but under the fake's own model name. They are candidates: read each
  one, then copy the good ones into `test/fixtures/gemma/` yourself. The command never overwrites a
  file and never writes into that folder.

`export` and `delete-photos` refuse to run while the app is running (stop it first). They touch only
the files the app owns in the data folder (`sib.db` and its `-wal`/`-shm` files, and the photos);
`config/household.json` is never touched. `export` refuses a folder that is not empty, is a
symlink, or is inside a git working tree that git would not ignore.

### Building the fine-tune dataset (`sib snapshot`, `sib dataset`)
The fine-tune dataset (REQ-019) is built in two steps. The first needs the network (Open-Meteo);
the second runs offline on the saved snapshot.
```bash
npm run sib -- snapshot   # Open-Meteo -> ~/.should-i-bother/data-snapshots/gracia-barcelona_<start>_<end>/
npm run sib -- dataset    # snapshot -> ~/.should-i-bother/datasets/<same name>/{train.jsonl,holdout.jsonl,manifest.json}
```
- `snapshot` fetches 1 Apr 2026 to yesterday for Gràcia (`--start`, `--end`, `--out` change that);
  the end date in the folder name is the archive's last complete day, which is where the hold-out
  ends. Both commands refuse a folder inside a git working tree unless git ignores it.
- `dataset` builds with the prompt the app runs (`BOOKMAKER_PROMPT`, today `bookmaker.v1`). When
  T-010 freezes a later `prompts/bookmaker.vN.md`, run `sib dataset --prompt-version N` (or raise
  the version in `src/server/gemma/bookmaker.ts`); the manifest records the version and its hash.
- Habits: every row carries the fixed synthetic profile in `training/habits.synthetic.json`, while
  the live app sends `habits: {}` until onboarding feeds the bookmaker (the manifest says so under
  `habits`). T-014 also evaluates the fine-tuned model with habits `{}`. `--habits <file>` replaces
  the profile, but a file in the data folder or named `household.json` is refused.
- The build stops, and writes nothing, if a value from `config/household.json` appears in a row or
  the manifest (AC-019.8): strings as whole words, and decimal numbers as written or rounded to
  2-4 decimals (1 from 10 up), with `.` or `,`. The onboarding profile in the database is not
  checked: this command never opens the database. The same inputs give the same bytes.
- `sib backtest` now shows the same synthetic habits by default. A run started with the old
  default (no habits) refuses to resume; `--habits <file containing {}>` reproduces the old
  behaviour, `--restart` starts over.
- Each line of `train.jsonl` is `{id, split, chore, date, messages, tools, meta}`: `messages` is the
  conversation the live bookmaker has (system prompt, data message, the `get_forecast` call with
  `hours_ahead: 24`, which the trained model must emit, and its result) plus the answer as the last `assistant` message; `tools` is the tool definition; `meta`
  holds the rule band and the target (training only). `holdout.jsonl` has the same rows without the
  answer and the target, ending at the tool result, and `meta.outcome_delivered` is the label for
  the evaluation. Training rows never show an hour of 1 Sep or later; rows whose forecast needed a
  Historical Forecast or archive value, and days with a safety alert, are left out and counted in
  `manifest.json`. Training uses `messages` and `tools` only; `meta` is for audit and evaluation.
- Before `ollama stop` and T-012, check `manifest.json`: prompt version, rules hash, snapshot end
  date, rows per chore and band, skips.

The snapshot queries are written against the Open-Meteo documentation and have not been run
against the live API (`src/backtest/open-meteo.ts` lists what to verify): if `snapshot` fails, its
one-line error names the URL's status and reason.

## Weather data and attribution

Odds come from the Open-Meteo forecast for the coordinates in `config/household.json`. At the
settle time the app fetches the recorded weather of the bet's window, labelled "modelled recent
weather". The weather client calls only the five Open-Meteo hosts of its allowlist
(`api.open-meteo.com`, `previous-runs-api.open-meteo.com`, `historical-forecast-api.open-meteo.com`,
`archive-api.open-meteo.com`, and `geocoding-api.open-meteo.com` for the onboarding place search),
counts its calls (budget 1,000 a day) and refuses any other host.
The free Open-Meteo tier is for non-commercial use. The app shows this attribution in the footer of
Today:

> Weather data by Open-Meteo.com (https://open-meteo.com/), licensed CC BY 4.0.

## Your data

Home mode keeps everything in the data folder `~/.should-i-bother/` (`SIB_DATA_DIR` to change it), outside
the repository and owner-only (folder 0700, database 0600). The app refuses to start with a data folder that
git could commit, and `sib export` refuses such a target too. The rest of the privacy model is in
[architecture.md](architecture.md#12-privacy-boundaries).

- Photos are re-encoded without metadata (no EXIF or GPS) and resized to 1024 px at most.
- Logs go to the terminal; no log file is kept. Tokens, cookies and photo bytes are redacted.
- Export your data with `sib export <dir>` (keep that folder out of the repository), delete the photos
  with `sib delete-photos`, and delete everything with `sib delete-photos --all-data`. Deleting a photo or
  a bet in the app removes its files and every record derived from it.
- `config/household.json` and `config/server.json` are git-ignored. Never commit photos, the database or
  an export; gitleaks runs in pre-commit and CI.

## Testing

```bash
npm test                          # unit, integration and component tests (fake model, fake weather; no GPU, no network)
npm test -- --coverage            # with v8 coverage
npm run lint && npm run typecheck
npm run build && npm run test:e2e # Playwright journey at phone width: capture, bet, settle (builds the screens first)
npm audit --audit-level=high      # dependency vulnerabilities
(cd training && uv sync && uv run ruff check . && uv run pytest)   # the Python fine-tune tooling
```

Playwright needs a browser once: `npx playwright install chromium` (on WSL add
`--with-deps`). The e2e suite is not part of CI yet. Tests and CI never touch a real model,
the network or household data.

The fine-tune lives in `training/` (Python 3.12, uv, ruff, pytest) and runs on the builder's GPU
only. Stop Ollama (`ollama stop`) before training: one GPU user at a time. The scripts (config,
dataset loading, QLoRA training, merge and GGUF export, a hold-out smoke test) and the builder's
step-by-step list are in [training/README.md](../training/README.md); CI runs ruff and pytest there
with no GPU and no model.
