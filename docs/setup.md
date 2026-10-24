# Set up and run (home mode)

The full, step-by-step setup for the default mode: Gemma 4 on your own laptop through Ollama, the phone
on your home Wi-Fi. For a two-minute look without a GPU, use the sample-data demo in the
[README](../README.md#quick-start) instead. For the optional server version, see
[deploy-digitalocean.md](deploy-digitalocean.md). Settings and commands are listed in
[reference.md](reference.md); how the parts fit together is in [architecture.md](architecture.md).

Contents: [What you need](#what-you-need) · [Set up](#set-up) · [Phone access](#phone-access-over-wi-fi) ·
[Pair a phone](#pair-a-phone) · [Tailscale Serve](#optional-https-with-tailscale-serve) ·
[Voice](#optional-voice-capture-flag-voice) · [Run](#run)

## What you need

| | |
|---|---|
| Laptop | Windows 11 with WSL2 (Ubuntu), an NVIDIA GPU with 8 GB VRAM or more and the WSL CUDA driver, 16 GB RAM or more, about 20 GB free disk for the models |
| Software | Node.js 24 (pinned in `.nvmrc`), [Ollama](https://ollama.com), git. Python 3.12 and [uv](https://docs.astral.sh/uv/) are needed only for `training/` |
| Phone | Current iOS Safari or Android Chrome, on the same Wi-Fi as the laptop |

Target: a fresh clone to a running app in 30 minutes, not counting the model download (NFR-011).
Without a GPU you can still try the whole app on recorded fixtures, see [Run](#run).

## Set up

All commands run inside WSL2 (Ubuntu).

### 1. Clone, install, build

```bash
git clone https://github.com/adricasi/ShouldIBother.git
cd ShouldIBother
nvm install            # reads .nvmrc (Node 24); install nvm first if you have none, any Node 24 works
npm ci                 # install from the lockfile
npm run build          # compiles the server to dist/ and builds the app screens to dist/web
```

If `npm ci` fails while building `better-sqlite3` or `sharp` (they normally download prebuilt
binaries), install the build tools with `sudo apt install build-essential python3` and retry.

### 2. Install Ollama and pull Gemma 4

Check that WSL sees the GPU (`nvidia-smi`), then install Ollama in WSL following
<https://ollama.com/download> (on Linux this is the official install script, which starts the
`ollama` service; if your WSL has no systemd, run `ollama serve` in a second terminal).

**Leave `OLLAMA_HOST` unset.** Ollama then listens on 127.0.0.1:11434 only, which is what the app
requires; `config/models.json` rejects any other address.

Pull the two models the project uses:

```bash
ollama pull TODO(builder): exact E4B tag     # the model the app runs on (primary)
ollama pull TODO(builder): exact E2B tag     # the smaller model, used only for the backtest comparison
ollama list                                  # note the ID column: it starts with the model digest
```

| Model | Ollama tag | Quantization | Digest |
|---|---|---|---|
| Gemma 4 E4B | `TODO(builder): tag from T-010` | `TODO(builder)` | `TODO(builder): sha256 from T-010` |
| Gemma 4 E2B | `TODO(builder): tag from T-010` | `TODO(builder)` | `TODO(builder): sha256 from T-010` |

Tell the app which tag to use in `config/models.json`. The file is committed; `primary` names the
entry in `models` that the app runs on, and `sib start` refuses to start if that entry has no tag:

```json
{
  "primary": "e4b",
  "models": {
    "e4b": { "tag": "<tag from ollama list>", "quantization": "<q>", "digest": "<sha256>" },
    "e2b": { "tag": "<tag from ollama list>", "quantization": "<q>", "digest": "<sha256>" }
  }
}
```

The optional `models.e4b-ft` entry (same shape as `e4b`) names the fine-tuned bookmaker for the
`finetunedBookmaker` flag. The `ollama`, `llamaCpp` (voice only, below), `gemma.toolUse` and `gemma.answerMode` keys in the
same file already have working defaults. The digest is the reference for anyone comparing results; the backtest refuses to run if
the pulled model's digest differs from the configured one. There is no script that pulls or
verifies the models yet: compare `ollama list` with the table above by hand.

<!-- TODO(builder): after T-010 commit the real tags, quantizations and digests in
config/models.json so a stranger only has to run the two `ollama pull` commands, then fill the
table above and delete the placeholders. Say here whether the fine-tuned adapter (Q-11) is
published and where. -->

### 3. Optional config files

Both are git-ignored (they name your machine or your home); the committed `*.example.json` files
are the fallback, so the app starts without them.

```bash
cp config/server.example.json config/server.json       # ports, extra hosts and origins (below)
cp config/household.example.json config/household.json # your dryer, AC and heater, and the neighbourhood coordinates
```

`config/household.json` sets the baseline behind the savings figures and the location the weather
is fetched for. Coordinates are rounded to 2 decimals (about 1 km) before every request. The
example uses Gràcia, Barcelona: change `location` to yours.

`config/server.json`:

| Key | Meaning |
|---|---|
| `port` | Port of the app, default 8787. `SIB_PORT` overrides it, and `sib pair` reads the same value |
| `allowedHosts` | Extra `Host` header values the server accepts, for example the Windows LAN IP behind a `netsh` port proxy. Any other host gets 421 (this blocks DNS rebinding) |
| `publicOrigins` | HTTPS origins that reach the app, for example `https://<machine>.<tailnet>.ts.net` for Tailscale Serve. They are added to the Origin and Host checks |

The server already allows `localhost`, `127.0.0.1` and the addresses of the active network
interfaces, and prints its allowlist at start.

## Phone access over Wi-Fi

The app listens on 127.0.0.1 and on the laptop's private LAN address only (`SIB_LAN_ADDRESS`
overrides the address; it must be a private or loopback address). Ollama stays on 127.0.0.1 and is
never exposed. WSL2 sits behind NAT by default, so the phone cannot reach it until you do one of
the following. Mirrored networking is the simpler one.

### Option A: WSL mirrored networking (recommended)

1. In Windows, create or edit `%UserProfile%\.wslconfig`:

   ```ini
   [wsl2]
   networkingMode=mirrored
   ```

2. In PowerShell: `wsl --shutdown`, then open WSL again. WSL now shares the Windows network
   addresses, so the app is reachable on the laptop's Wi-Fi IP.
3. Allow the app port through the Windows firewall, **Private profile only**. In PowerShell as
   administrator (change 8787 if you changed the port):

   ```powershell
   New-NetFirewallRule -DisplayName "Should I Bother (app)" -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow -Profile Private
   ```

   Mirrored mode also has a Hyper-V firewall for WSL. If the phone still cannot connect, allow the
   port there too (Microsoft's documented WSL creator id):

   ```powershell
   New-NetFirewallHyperVRule -Name "SIB8787" -DisplayName "Should I Bother (app)" -Direction Inbound -VMCreatorId "{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}" -Protocol TCP -LocalPorts 8787
   ```

   <!-- TODO(builder): confirm the two firewall commands on your laptop and note which one was
   needed. Make sure your Wi-Fi network is set to the Private profile in Windows. -->

4. Do **not** add a rule for port 11434. Check from WSL that only the app is exposed:

   ```bash
   ss -ltnp | grep -E ':(8787|11434)\b'    # 11434 must show 127.0.0.1, never 0.0.0.0 or *
   ```

### Option B: `netsh` port proxy (no mirrored mode)

Forward the Windows LAN port to the WSL address and list the Windows IP in `allowedHosts`
(`config/server.json`), because the `Host` header is the Windows address. Run in PowerShell as
administrator:

```powershell
$wsl = (wsl hostname -I).Trim().Split(" ")[0]
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=8787 connectaddress=$wsl connectport=8787
New-NetFirewallRule -DisplayName "Should I Bother (app)" -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow -Profile Private
```

The WSL address changes at every WSL restart, so repeat the `portproxy` line then. Behind a port
proxy every client shares one address, see the rate-limit note below.

## Pair a phone

`npm start` (or `npm run dev`) prints the Host allowlist, a pairing link and a QR code to the
console (stderr). The link is valid for 10 minutes and for at most 3 devices. Scan the QR code with
the phone camera (or type the link): the app sets a 30-day cookie and opens the app. The pairing
token and the session ids are stored only as hashes and never logged.

```bash
npm run sib -- pair            # print a new link; older unused links stop working, devices stay signed in
npm run sib -- forget-devices  # sign every device out and cancel pending links
```

`npm start > app.log` is safe: the console output (allowlist, links, pairing lines) goes to stderr
and the JSON logs go to stdout.

### Security notes

- **Plain HTTP on the LAN has a known limit.** Someone already on your Wi-Fi can sniff the session
  cookie. Everyone else gets 401 on every route. For HTTPS use Tailscale Serve (next section,
  ADR-0007); sessions paired through an HTTPS origin get a `Secure`, `__Host-` cookie.
- Cookies are not isolated by port: another app on the same host name (for example another dev
  server on `localhost`) receives the session cookie. Do not run untrusted software on the laptop.
- The rate limit is per client address: more than 10 failed requests a minute blocks requests
  without a session for a minute. Behind Tailscale Serve or a `netsh` port proxy all clients share
  one address, so one bad client locks out everyone without a session. Paired devices are never
  affected. This is accepted for a one-household app.

## Optional: HTTPS with Tailscale Serve

Tailscale Serve gives the app an HTTPS address that only your tailnet can reach, with no
certificates to manage. Install Tailscale (on Windows or in WSL) and sign in, then, on the machine
where Tailscale runs, serve the app's port:

```bash
tailscale serve --bg 8787
tailscale serve status        # shows https://<machine>.<tailnet>.ts.net
```

Add that origin to `config/server.json` and restart the app:

```json
{ "port": 8787, "publicOrigins": ["https://<machine>.<tailnet>.ts.net"], "allowedHosts": [] }
```

Then pair the phone from a link that starts with that origin (`sib pair` prints one for every
origin). <!-- TODO(builder): confirm the `tailscale serve` syntax for your Tailscale version and
whether Serve in Windows reaches the WSL app on 127.0.0.1 in mirrored mode. -->

**Without Tailscale the app runs on plain HTTP**, and browsers expose only HTTP-safe features. The
photo buttons use the phone's own file picker and camera app, which work over HTTP. Features that
need a secure context do not: the microphone for voice capture (flag `voice`, off) is hidden over
plain HTTP, and the app uses neither geolocation nor a live in-browser camera. Location is typed
in `config/household.json` (or in onboarding) instead.

## Optional: voice capture (flag `voice`)

Say your chores instead of typing them (REQ-027). The phone records a short note (at most 20 s),
the laptop sends it to **Gemma 4 audio on a second local server, llama.cpp** (Ollama's Gemma
audio is unreliable on NVIDIA, ADR-0004), shows the transcript with the weather chores
highlighted, and makes the cards only when you tap "See odds for N chores". The audio goes only
to `127.0.0.1`, is held in memory for the request and is never written to disk, logged or put in
git. The decision log keeps the voice note's length, size and a hash, and not the transcript; the
listener that reads the transcript still stores the chore labels it finds, as it does for typed
capture. Set `NO_PROXY=127.0.0.1,localhost,::1` if you run Node with `NODE_USE_ENV_PROXY=1` and a
proxy: the app refuses to start its model clients otherwise, so nothing local goes through a proxy.

The flag is off by default; with it off there is no mic button, no route and no mention of voice
in the privacy line. It needs two things on top of the normal setup:

1. **A llama.cpp server on 127.0.0.1 with the Gemma 4 audio model.** Start it by hand next to the
   app (bind to loopback; never `--host 0.0.0.0`):

   ```bash
   # TODO(builder): exact model file, projector and flags are UNVERIFIED. Shape of the command:
   llama-server -m <gemma-4-e4b gguf> --mmproj <audio projector gguf> --host 127.0.0.1 --port 8080
   ```

   `config/models.json` `llamaCpp.baseUrl` (default `http://127.0.0.1:8080`) says where to find it;
   any host other than `127.0.0.1` or `[::1]` is an error at start. The server may start after the
   app: the mic then says "Voice is offline" until it answers. The request format the app speaks
   is **unverified** until you run it against your server: it is all in
   `src/server/model/llamacpp-wire.ts` (`TODO(builder): verify against llama.cpp server docs`).
   Memory: Ollama's E4B and llama.cpp's audio model are two copies on one GPU. To keep Ollama's
   models resident, start Ollama with `OLLAMA_MAX_LOADED_MODELS=2` (or more) and keep
   `ollama.keepAlive` long (default `24h`); llama.cpp keeps its model loaded while it runs. If
   the GPU runs out of VRAM, unload one (`ollama stop`) and expect the other to be reloaded on use.
   TODO(builder): measure a voice note end to end with both loaded; each of its two jobs has its
   own 45 s deadline from enqueue. Fallback stated in the post, not built: whisper.cpp for the
   transcript, with the same listener after it.
2. **HTTPS for the phone.** Browsers give the microphone only to secure pages, so over plain HTTP
   on the Wi-Fi the mic button is hidden and typed capture is all there is. Use
   [Tailscale Serve](#optional-https-with-tailscale-serve) and open the app from its `https://`
   origin.

## Run

```bash
npm start                    # node dist/cli.js start: serves the app and API, runs the 60 s scheduler
```

Run `npm run build` first. The app talks to Gemma through Ollama on 127.0.0.1. If Ollama is down
the app still starts: Today shows "Gemma offline" with rule odds and a Retry button, and
settlements wait until Gemma is back (the rule never settles a bet).

On the phone: tap the "Water plants" or "Line-dry today" chip (or type a sentence), read the odds,
tap "Bet: do nothing". At the settle time (the scheduler checks every 60 s) the bet appears under
"Settle now" with one-tap answers and an after-photo option.

### Development without a GPU

```bash
npm run dev                  # builds the screens, starts with SIB_FAKE_MODEL=1 and restarts on code changes
SIB_FAKE_WEATHER=1 npm run dev   # also no network: fake weather
```

| Variable | Effect |
|---|---|
| `SIB_FAKE_MODEL=1` | The recorded-fixture model (`test/fixtures/gemma/`) instead of Ollama. A banner says so and Today shows "(fake model)". Never use it for real bets. `npm run dev` sets it |
| `SIB_FAKE_WEATHER=1` | Fake weather, no Open-Meteo call. For development and tests |
| `SIB_DATA_DIR` | Data folder, default `~/.should-i-bother/` |
| `SIB_PORT` | Port, else `port` in `config/server.json`, else 8787 |
| `SIB_LAN_ADDRESS` | The LAN address to listen on (private or loopback only) |

After editing a screen, run `npm run build:web` and reload (or restart `npm run dev`; each restart
prints a new pairing link).
