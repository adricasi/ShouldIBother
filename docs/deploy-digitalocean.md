# Deploy Should I Bother? on DigitalOcean (hosted mode)

This guide puts the app on one small DigitalOcean server so that you can use it away from home,
without a GPU. You follow it by hand, in the DigitalOcean control panel and over SSH. Nothing in
the repository creates, changes or deploys cloud resources for you (REQ-032, NFR-013, ADR-0011).

Home mode, the default, is not affected: Gemma runs on your laptop and "Your photos never leave
it". Hosted mode is optional and changes where Gemma runs.

**Marks used in this guide**

- **[S]** a fact taken from a search-engine extract of a DigitalOcean page on 2026-10-24
  (ADR-0011). It was not read on the page itself. Re-check it before you rely on it.
- **[verify]** something the builder must confirm in the control panel or with a command. It is
  either unverified, or a screen name that may have changed.
- **[TODO]** a value the builder must look up or fill in.

Contents: [1 What hosted mode is](#1-what-hosted-mode-is-and-what-it-costs-you-in-privacy) ·
[2 Prerequisites](#2-prerequisites) · [3 Costs](#3-costs) ·
[4 Create the DigitalOcean resources](#4-create-the-digitalocean-resources-control-panel) ·
[5 Prepare the Droplet](#5-prepare-the-droplet) · [6 Build and ship the image](#6-build-the-image-on-your-laptop-and-ship-it) ·
[7 Configure and start](#7-configure-and-start) · [8 Check Gemma](#8-check-the-inference-service) ·
[9 Link your phone](#9-link-your-phone) · [10 Operations](#10-operations) ·
[11 Security checklist](#11-security-checklist) · [12 Troubleshooting](#12-troubleshooting) ·
[13 Tear down](#13-tear-down) ·
[14 Release with one command (recommended)](#14-release-with-one-command-recommended)

## 1. What hosted mode is, and what it costs you in privacy

One Droplet (a small virtual server) runs two containers with Docker Compose: **Caddy**, which
gets a Let's Encrypt certificate and terminates HTTPS, and the **app**, the same code as home mode
with `SIB_MODE=hosted`. The app stores its SQLite database and photos on the Droplet's disk. Gemma
is not on the server: the app calls DigitalOcean's Serverless Inference API, which runs a Gemma 4
model for you and charges per token.

```
phone ──HTTPS──> Caddy (80/443) ──> app (no published port) ──> DigitalOcean inference API
                                         └──> Open-Meteo (weather)      /srv/sib/data on the Droplet
```

**The trade-off.** In home mode nothing about your household leaves the laptop. In hosted mode the
app tells you where Gemma runs (AC-032.6). The status line reads "Gemma 4 · DigitalOcean · <model
ID>", and the privacy line reads:

> Gemma runs on DigitalOcean's inference service. Your chores, habits, answers and area forecast
> are sent there. Photos are off.

With `SIB_DO_VISION=1` it reads "Gemma runs on DigitalOcean's inference service. Your chores,
habits, answers, area forecast and the photos you add are sent there."

ADR-0011 adds what is known about DigitalOcean's side:

- Sent to the inference service: chore text, habits, answers to Gemma's questions, inspector
  observations, and the area forecast built from coordinates rounded to 2 decimals. Photos only
  with `SIB_DO_VISION=1`; the default is off, so photos stay on the server.
- DigitalOcean states that it does not store this data or train on it, and does not share it with
  the model's creator **[S]**. The processing region is not documented; it is likely the US
  (**unverified**).
- Your database and photos live on a cloud server and in its backups. Whether DigitalOcean encrypts
  Droplet disks and backups at rest is **unverified**: check it before you store household data
  there (step 4.2).
- The hosted Gemma is a larger model than the laptop's E4B and never the fine-tune. Hosted bets
  are kept apart from home bets in calibration and comparisons.

If that is not acceptable, stay in home mode, or use Tailscale Serve for HTTPS to the laptop (see
the README).

## 2. Prerequisites

| You need | Notes |
|---|---|
| A domain, or a subdomain, you control | For example `sib.example.com`. You add one A record. Not included in the costs. |
| A DigitalOcean account with a payment method | **[verify]** the account is verified and can create Droplets. |
| Prepaid balance for Gemma | Serverless Inference needs a prepaid balance, required since 29 Jun 2026 **[S]**. Start with a small amount (10 US$). |
| A model access key, inference only, with a monthly budget | Created in step 4.6. Never use an account API token for the app. |
| An SSH key pair on your laptop | `ssh-keygen -t ed25519 -C "sib-droplet"`. Protect it with a passphrase. |
| Docker on the laptop (Docker Engine or Docker Desktop with WSL integration) | You build the image there. The 1 GiB Droplet does not build. |
| This repository, checked out at the commit you deploy | Tagged or at least clean (`git status`). |
| Your public IP address | For the SSH firewall rule. Look it up with a "what is my IP" service. |

Keep a password manager entry for: the inference key, the Droplet's IP, the domain registrar login
and the DigitalOcean login (with two-factor authentication on).

## 3. Costs

All prices in US$ per month, before tax. Re-check the **[S]** values on DigitalOcean's pricing
pages (Droplets, Backups, Reserved IPs, Serverless Inference, Billing) before you commit; ADR-0011
records no deep links because the facts came from search extracts.

| Item | Price | Status |
|---|---|---|
| Droplet, Basic, 1 GiB RAM / 1 vCPU / 25 GiB disk | 6.00 | [S] |
| Backups, daily | 30 % of the Droplet price = 1.80 (weekly: 20 % = 1.20) | [S]; daily is offered in NYC1, NYC3, SFO3, AMS3, SGP1 |
| Reserved IP | free while assigned to a Droplet; 5.00 if left unassigned | [S] |
| Monitoring and alerts | free with the metrics agent | [S] |
| Cloud Firewall | free | **unverified** (marketing page) |
| Gemma inference | 0.18 per 1M input tokens, 0.50 per 1M output tokens, 0.036 per 1M cache reads | [S] |
| Domain | not included | |

Monthly estimate (ADR-0011; 4.33 weeks a month, about 6 calls per bet of 2-5k input and 300 output
tokens; no tax, no image tokens):

| Scale | Gemma | Hosting | Total |
|---|---|---|---|
| Low: 25 bets/week, 4 calls, 2k input | about 0.22 | 7.20 (weekly backups) | about 7.40 |
| Typical: 100 bets/week, 6 calls, 3.5k input | about 2.03 | 7.80 (daily backups) | about 9.80 |
| High: 100 bets/week, 10 calls, 5k input | about 4.55 | 7.80 | about 12.40 |

NFR-006 expects about 7-13 US$ a month and holds it below 20 with three brakes: the app's daily
call cap (`SIB_DAILY_MODEL_CALLS`, default 300), the model access key's monthly budget, and an
account spend alert (step 4.6). When the prepaid balance or the budget runs out, Gemma is "offline":
odds fall back to the rule and settlements wait (AC-008.8). Nothing else is billed per use.

## 4. Create the DigitalOcean resources (control panel)

You create everything by hand. Screen names below are from memory and may differ **[verify]**. Use
the same labels everywhere so you can find the resources again: tags `env:prod`,
`app:should-i-bother`, `owner:<your name>`, `managed-by:hand`.

### 4.1 Add your SSH key

Settings > Security > SSH keys > Add SSH Key. Paste the **public** key (`~/.ssh/id_ed25519.pub`)
and name it `sib-laptop`. Never paste or upload the private key.

### 4.2 Create the Droplet

Create > Droplets, then:

| Setting | Value |
|---|---|
| Region | Amsterdam, **AMS3** (closest region with daily backups **[S]**) |
| Image | Ubuntu 24.04 (LTS) x64 |
| Size | Basic, Regular, **1 GiB / 1 vCPU / 25 GiB** (6 US$ **[S]**). `setup-droplet.sh` adds a 1 GiB swap file |
| Authentication | SSH key: select `sib-laptop`. No password |
| Backups | **Enable, frequency daily** (1.80 US$ **[S]**) **[verify]** that the daily option is offered |
| Monitoring | **Enable** (installs the metrics agent; needed for the memory and disk alerts) |
| IPv6 | optional; the guide uses IPv4 only |
| Hostname | `sib-prod` |
| Tags | `env:prod`, `app:should-i-bother`, `owner:<your name>`, `managed-by:hand` |
| Project | create a project `should-i-bother` and put the Droplet in it |

**[verify] Encryption at rest.** Before you store household data on the Droplet, find out from
DigitalOcean's documentation or support whether Droplet volumes and backups are encrypted at rest,
and write the answer in ADR-0011 (Facts table: "Encryption at rest"). If it is "no", decide whether
the household data on this disk is acceptable to you.

### 4.3 Reserve an IP

Networking > Reserved IPs > Reserve to the Droplet in AMS3. Reserved IPs are free while assigned
**[S]**; release it when you tear down, or it costs 5 US$ a month. Use this IP for the DNS record
and for SSH from now on, so you can rebuild the Droplet without changing DNS.

### 4.4 Create the Cloud Firewall

Networking > Firewalls > Create Firewall `sib-prod`. The Cloud Firewall is the first layer (it sits
outside the Droplet); `ufw` on the Droplet is the second.

Inbound rules:

| Type | Protocol | Port | Sources |
|---|---|---|---|
| SSH | TCP | 22 | **your public IP only** (`x.x.x.x/32`) |
| HTTP | TCP | 80 | All IPv4 (and All IPv6 if you enabled IPv6) |
| HTTPS | TCP | 443 | All IPv4 (and All IPv6 if you enabled IPv6) |
| Custom | UDP | 443 | All IPv4 (HTTP/3; optional, browsers fall back to TCP) |

Outbound rules: the default allows everything, which is simplest for the first deploy. To restrict
them later, allow TCP 53, 80, 443, UDP 53 and 123, and ICMP; apt, Docker, Let's Encrypt, the
inference API, Open-Meteo and the metrics agent need only those.

Apply it to the Droplet by name or by tag `app:should-i-bother`. If your home IP changes, edit the
SSH rule; the Droplet console in the panel always works as a way in (step 12).

### 4.5 Create monitoring alerts

Monitoring > Create alert policy (or Droplet > Alerts), one policy each, scope: the Droplet, notify
by email (and Slack if you use it):

| Metric | Condition |
|---|---|
| CPU | above 80 % for 10 minutes |
| Memory | above 85 % for 10 minutes |
| Disk utilization | above 80 % for 10 minutes |

Also add an uptime check on `https://<host>/` after the first deploy if the panel offers one for
free **[verify]**; it expects a 401 or a redirect, not 200, because the app needs a session.

### 4.6 Inference: balance, model access key, budget, spend alert

1. Billing: add the prepaid balance for inference **[S]** (start small).
2. Create a **model access key** for Serverless Inference (GenAI / Inference section of the panel
   **[verify]**). Give it a name such as `sib-prod`. It must be an inference-only model access key,
   not a personal access token. Copy it once into your password manager. You will paste it into
   `/etc/sib/sib.env` on the Droplet (step 7); it must never be in git, a chat or a screenshot.
3. Set the key's **monthly budget** to 10 US$ (alert as it nears; it pauses at 100 %). Per-key budgets
   are in preview **[S]**: **[verify]** that it exists, and that "pause at 100 %" is what happens.
4. Billing > Alerts: create an **account spend alert** (for example at 15 US$) **[S]**.

### 4.7 DNS

At your DNS provider, create an **A record** for the host (for example `sib`) pointing to the
reserved IP, TTL 300. Do not add an AAAA record unless you reserved and routed an IPv6 address.
Check it from the laptop before the first start, because Caddy needs it to get its certificate:

```bash
dig +short sib.example.com   # prints the reserved IP
```

## 5. Prepare the Droplet

The repository's `deploy/digitalocean/` folder goes to `/opt/sib` on the Droplet. Use the reserved
IP below (`$IP`). The first connection asks you to confirm the host key: compare the fingerprint
with the one in the Droplet console, if you can.

```bash
export IP=203.0.113.10        # your reserved IP
ssh root@$IP 'install -d -m 0750 /opt/sib'
scp deploy/digitalocean/* root@$IP:/opt/sib/
ssh root@$IP 'bash /opt/sib/setup-droplet.sh'
```

What `setup-droplet.sh` does (it can be run again; read it first, it is short):

- `apt upgrade`, unattended security updates (reboots at 04:30 UTC when a kernel needs it), a 1 GiB
  swap file;
- Docker Engine and the Compose plugin from Docker's apt repository, after checking the repository
  key's fingerprint against the one in the script. **[verify]** the fingerprint
  (`9DC858229FC7DD38854AE2D88D81803C0EBFCD88`) against https://docs.docker.com/engine/install/ubuntu/;
- `/srv/sib/data` (owner uid 10001, mode 0700), `/srv/sib/backups` and `/etc/sib` (root, 0700);
- `ufw`: deny incoming, allow 80, 443, SSH rate limited;
- SSH: password login off, root only with a key (`/etc/ssh/sshd_config.d/00-sib-hardening.conf`);
- the nightly backup timer (`sib-backup.timer`).

It refuses to run if root has no `authorized_keys`, so it cannot lock you out. **Before closing the
session, open a second terminal and log in again** (`ssh root@$IP`). Also check that the metrics agent
runs: `ssh root@$IP systemctl is-active do-agent`.

Docker's repository is not covered by unattended upgrades. Update Docker with
`apt-get update && apt-get upgrade` from time to time (monthly).

## 6. Build the image on your laptop and ship it

> **Easier: use the release script (section 14).** It does this section and the image part of 10.2
> in one command, through DigitalOcean's Container Registry, with short-lived credentials and an
> automatic rollback. This section is the manual way, without a registry.

There is no registry and no registry credential: you copy the image over SSH.

```bash
git switch <branch-or-tag-you-deploy>
TAG="$(git rev-parse --short HEAD)"
docker build --platform linux/amd64 -t "sib:$TAG" .
```

What the build does: compiles the server and the SPA (`npm ci` + `npm run build`), installs
production dependencies only in a second stage, copies `dist`, `config`, `prompts` and
`node_modules` into a Node 24 slim image that runs as user 10001, and fails if `better-sqlite3` or
`sharp` cannot load. `config/household.json`, `config/server.json`, `data/` and `.env*` are excluded
by `.dockerignore`.

**[TODO] Image digests.** The `Dockerfile` pins `node:24.22.1-trixie-slim`, and `compose.yaml` pins
`caddy:2.11.7`, by digest. The digests were looked up on 2026-10-24. Look them up again, and update
both files if a patched image has replaced them:

```bash
docker buildx imagetools inspect node:24.22.1-trixie-slim   # "Digest:" line, goes after "@" in the Dockerfile
docker buildx imagetools inspect caddy:2.11.7                # same, in deploy/digitalocean/compose.yaml
```

**Smoke test locally** before you ship (a throwaway volume, a fake key, nothing leaves your laptop
except the app's Open-Meteo call):

```bash
docker run -d --name sib-smoke --read-only --tmpfs /tmp --cap-drop ALL \
  --security-opt no-new-privileges:true -v sib-smoke-data:/data \
  -e SIB_MODE=hosted -e SIB_PUBLIC_ORIGIN=https://sib.example.com \
  -e SIB_DO_MODEL=gemma-4-31B-it -e SIB_DO_INFERENCE_KEY=not-a-real-key \
  -e SIB_BIND_ADDRESS=0.0.0.0 "sib:$TAG"
sleep 50; docker inspect --format '{{.State.Health.Status}}' sib-smoke   # healthy
docker logs sib-smoke | head -n 20                                        # no key, no pairing link
docker rm -f sib-smoke && docker volume rm sib-smoke-data
```

Then ship it (the image is a few hundred MB; compress it):

```bash
docker save "sib:$TAG" | gzip | ssh root@$IP 'gunzip | docker load'
ssh root@$IP docker image ls sib
```

Keep the previous tag on the Droplet: that is your rollback (step 10.3).

## 7. Configure and start

Two small files on the Droplet. The first has the secret and stays out of git; the second is not
secret.

```bash
# On your laptop: copy the example, then edit the real values on the Droplet.
scp deploy/digitalocean/env.example root@$IP:/tmp/sib.env.new
ssh root@$IP
```

On the Droplet:

```bash
install -m 0600 -o root -g root /tmp/sib.env.new /etc/sib/sib.env && rm /tmp/sib.env.new
nano /etc/sib/sib.env        # set SIB_PUBLIC_ORIGIN, SIB_DO_MODEL, paste SIB_DO_INFERENCE_KEY
ls -l /etc/sib/sib.env       # -rw------- 1 root root

cd /opt/sib
cp compose.env.example .env
nano .env                    # SIB_HOST=<your host>, SIB_IMAGE_TAG=<the TAG you built>
chmod 0600 .env

docker compose config -q && echo "compose file valid"
docker compose up -d
docker compose ps            # app: healthy, caddy: running
```

Settings in `/etc/sib/sib.env` (all documented in `env.example`):

| Variable | Meaning |
|---|---|
| `SIB_MODE=hosted` | Hosted mode. Any value other than `home` or `hosted` stops the app. |
| `SIB_PUBLIC_ORIGIN` | `https://<host>`. Must be https. The only Host and Origin the app accepts. |
| `SIB_DO_MODEL` | Gemma 4 model ID. ADR-0011 lists `gemma-4-31B-it` (**unverified**: step 8 shows what your account offers). |
| `SIB_DO_INFERENCE_KEY` | The model access key. Read from the environment only; never logged. |
| `SIB_DO_VISION` | `0` (default) photos never go to the model, bets settle by tap at x0.5; `1` photos are sent to DigitalOcean. |
| `SIB_TOOL_USE` | `injected` (default) or `native`, per step 8. |
| `SIB_DAILY_MODEL_CALLS` | Daily cap, default 300 per Madrid day. |
| `SIB_PORT` | Keep `8787` (the Caddyfile points at it). |

Compose sets `SIB_DATA_DIR=/data` and `SIB_BIND_ADDRESS=0.0.0.0` itself.

What `compose.yaml` enforces on both containers: non-root app user (uid 10001), read-only root
filesystem with a tmpfs `/tmp`, all capabilities dropped (Caddy keeps only `NET_BIND_SERVICE`),
no-new-privileges, memory limits, rotated logs (10 MB x 3), `restart: unless-stopped`. The app has
**no published port**; only Caddy publishes 80, 443 and 443/udp. Caddy writes no access log.

Check HTTPS from your laptop (the first request may take a few seconds while Caddy gets the
certificate):

```bash
curl -sI https://sib.example.com/ | head -n 8          # HTTP/2 401 or a page; HSTS and Referrer-Policy present
curl -s -o /dev/null -w '%{http_code}\n' https://sib.example.com/healthz   # 404 from outside
```

## 8. Check the inference service

`sib hosted-check` (AC-032.8) calls the inference API a few times, without household data, and
reports: the model is listed by `/v1/models`, a JSON answer validates, a tool call comes back (else
"use injected tool use"), and an image is accepted (else "keep SIB_DO_VISION off").

```bash
cd /opt/sib && docker compose exec app sib hosted-check
```

Then act on the answers:

- Model not listed: pick an ID from the list in `SIB_DO_MODEL` (it must be a Gemma 4 ID the app
  accepts; if the right one is not accepted, that is a change to ADR-0011 and the app, not a
  workaround).
- Tool call fails: keep `SIB_TOOL_USE=injected`. Tool call works: you may set `native`.
- Image refused: keep `SIB_DO_VISION=0`. Image accepted: you may set `1`, knowing photos then go to
  DigitalOcean (the privacy line changes).
- After any change to `/etc/sib/sib.env`: `docker compose up -d --force-recreate app`.

**Record the results in ADR-0011** (Facts table: model ID, vision, tool calls, processing region if
you found it) and commit that from your laptop.

## 9. Link your phone

There is no login screen and no password. A phone is linked once and then **remembered**.

1. On the Droplet (over SSH):

   ```bash
   cd /opt/sib && docker compose exec app sib pair
   ```

   It prints a link (and a QR code) `https://<host>/pair#t=...`, valid for 10 minutes, for **one**
   device. For a second phone, run it again, or use `sib pair --devices 2` (at most 3). The link
   is shown in the terminal only and never goes to the server log.
2. Open the link on the phone (scan the QR code, or type it), and tap **Pair this phone**. The
   token is in the part of the address after `#`, which browsers never send to the server, and the
   button posts it, so link-preview bots and logs never see or spend it.
3. The device stays remembered for 30 days, renewed whenever it is used (at most once a day)
(a `__Host-` cookie: `Secure`, `HttpOnly`, `SameSite=Strict`).

Rules:

- Do not paste the link into a group chat, and never post it publicly. Anyone who opens it within 10
  minutes can take its slot.
- `docker compose exec app sib devices` lists the linked devices (when linked, last seen, a short
  summary such as "iPhone · Safari"). If you see one you don't know, or you are unsure, run
  `sib forget-devices` and pair again.
- To unlink every phone at once: `docker compose exec app sib forget-devices`. Do it when a phone
  is lost.
- A stranger who finds the URL gets nothing: every screen and API call needs a remembered device, and
  without one nobody can spend your Gemma credit. Failed attempts are rate limited per client address.

## 10. Operations

All commands run on the Droplet in `/opt/sib` unless noted.

### 10.1 Logs and status

```bash
docker compose ps
docker compose logs --tail 100 app          # structured JSON; no keys, no pairing links, no content
docker compose logs --tail 50 caddy         # errors only: Caddy has no access log
journalctl -u sib-backup.service --since yesterday
ls /srv/sib/backups/LAST_FAILURE 2>/dev/null && echo 'a backup failed: see 10.4'
df -h /srv/sib; free -h; swapon --show
```

The app's status line in the UI also shows the model ID, and Gemma "offline" when the balance, the
key budget or the daily cap is used up.

### 10.2 Update

Always take a backup first: a new version may migrate the database forward, and a migration cannot be
undone by switching the image back.

```bash
# on the laptop
TAG="$(git rev-parse --short HEAD)"
docker build --platform linux/amd64 -t "sib:$TAG" . && docker save "sib:$TAG" | gzip | ssh root@$IP 'gunzip | docker load'
echo "$TAG"                                     # note it: the Droplet's shell does not know it

# on the Droplet (replace NEW_TAG with the tag printed above)
systemctl start sib-backup.service && ls /srv/sib/backups
sed -i "s/^SIB_IMAGE_TAG=.*/SIB_IMAGE_TAG=NEW_TAG/" /opt/sib/.env
docker compose up -d
docker compose ps && docker compose logs --tail 30 app
```

### 10.3 Roll back

Set `SIB_IMAGE_TAG` in `/opt/sib/.env` to the previous tag (`docker image ls sib` lists them) and run
`docker compose up -d`. If the new version had migrated the database and the old one cannot read it,
restore the pre-update backup too (step 10.4). Remove old images only when you are sure:
`docker rmi sib:<old-tag>`.

### 10.4 Backups and the restore drill

Two layers:

- **DigitalOcean Droplet backups**, daily, kept by DigitalOcean (how many are kept, and how to
  restore one, **[verify]** in the Droplet's Backups tab). They are whole-disk copies, so they hold the
  database, the photos and `/etc/sib/sib.env`.
- **The nightly copy** (`sib-backup.timer`, 03:30 UTC, `backup.sh`): `VACUUM INTO` of the live database
  (checked with `integrity_check`) plus `photos.tar.gz`, in `/srv/sib/backups/<date>/`, owner-only,
  newest 7 kept. It does not include `/etc/sib/sib.env`. Both hold household data: handle the copies
  like the database.

Copy it off the Droplet now and then (to an encrypted disk, not a cloud drive you do not trust):

```bash
scp -r root@$IP:/srv/sib/backups/$(date -u +%F) ./sib-backup-$(date -u +%F)
```

**Restore drill** (do it once after the first deploy, then every few months). It restores into a
scratch folder and leaves the live app alone:

```bash
latest="$(find /srv/sib/backups -mindepth 1 -maxdepth 1 -type d -name '20*' | sort | tail -n 1)"
rm -rf /srv/sib/restore-test && install -d -m 0700 /srv/sib/restore-test
cp "$latest/sib.db" /srv/sib/restore-test/
tar -xzf "$latest/photos.tar.gz" -C /srv/sib/restore-test
sqlite3 /srv/sib/restore-test/sib.db 'PRAGMA integrity_check;'     # ok
sqlite3 /srv/sib/restore-test/sib.db '.tables'
ls /srv/sib/restore-test/photos | head
rm -rf /srv/sib/restore-test
```

**A real restore** (after data loss; the app is down while you do it). Replace `BACKUP_DATE` with
the folder you restore, from `ls /srv/sib/backups`:

```bash
latest=/srv/sib/backups/BACKUP_DATE
cd /opt/sib && docker compose stop app
mv /srv/sib/data /srv/sib/data.broken-$(date -u +%F)
install -d -m 0700 -o 10001 -g 10001 /srv/sib/data
cp "$latest/sib.db" /srv/sib/data/sib.db
tar -xzf "$latest/photos.tar.gz" -C /srv/sib/data
chown -R 10001:10001 /srv/sib/data && chmod 0700 /srv/sib/data
docker compose up -d app
```

Delete `data.broken-*` when you no longer need it (it holds household data). Pair the phones again
only if you also lost the database; sessions live in it.

### 10.5 Rotate the inference key

1. Create a new model access key (step 4.6) with the same budget.
2. Edit `SIB_DO_INFERENCE_KEY` in `/etc/sib/sib.env` (keep mode 0600).
3. `docker compose up -d --force-recreate app`, then `docker compose exec app sib hosted-check`.
4. Delete the old key in the panel. Do this at once if the key may have leaked, and look at the key's
   usage and the balance for strangers' spend.

### 10.6 Forget devices

`docker compose exec app sib forget-devices` ends every session; pair the phones again (step 9).

### 10.7 Spend

Spend has four brakes: the app's daily cap, the key's monthly budget, the account spend alert and
the prepaid balance. Look at the balance monthly. The app logs the cap and the count per day, never
content. If Gemma runs out, the app keeps working with rule odds and settlements wait; add balance
or raise the budget and they run first after the reset.

### 10.8 Export

`docker compose exec app sib export /data/export-<date>` writes a JSON export and the photos into the
data folder; copy it with `scp` and delete it. The nightly copy is usually enough.

## 11. Security checklist

Tick each item after the first deploy (NFR-013). Items marked **[verify]** need a command or a panel
check.

- [ ] The domain's A record points to the reserved IP; HTTPS works with a valid certificate (`curl -sI`).
- [ ] The Cloud Firewall allows SSH from your IP only, and 80/443 from anywhere; nothing else inbound
      **[verify]** in the panel.
- [ ] From outside, only 80 and 443 answer: `nmap -Pn -p 22,80,443,8787 $IP` from a host that is not
      your admin IP shows 22 and 8787 filtered/closed.
- [ ] `ssh -o PubkeyAuthentication=no root@$IP` is refused; `sshd -T | grep -E 'passwordauthentication|maxauthtries'`
      says `no` and `3`. Root logs in with a key only, and only from your IP (Cloud Firewall): an accepted
      trade-off for one household (ADR-0011); a named admin user with sudo is a later hardening step.
- [ ] `ls -ld /srv/sib/data /srv/sib/backups /etc/sib` shows `drwx------`; `/etc/sib/sib.env` is
      `-rw-------` root:root.
- [ ] `docker compose ps` shows the app healthy; `docker port sib-app-1` prints nothing (no published
      port).
- [ ] `docker inspect sib-app-1 --format '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}}
      {{.HostConfig.SecurityOpt}} {{.Config.User}}'` shows `true [ALL] [no-new-privileges:true] 10001:10001`.
- [ ] `curl -s -o /dev/null -w '%{http_code}' https://<host>/healthz` is `404`.
- [ ] A response header check shows `Strict-Transport-Security` and `Referrer-Policy: no-referrer`.
- [ ] Caddy has no access log: `docker compose logs caddy` shows startup lines and errors, no requests.
- [ ] The key: inference-only access key with a monthly budget; the account spend alert is on; the key
      is not in git, shell history, a chat or a backup (`grep -r DO_INFERENCE /srv/sib` finds nothing).
- [ ] Two-factor authentication is on for DigitalOcean and the domain registrar.
- [ ] Droplet backups are on (daily), monitoring is on and an alert email arrives (trigger a test).
- [ ] `sib-backup.timer` is active (`systemctl list-timers sib-backup.timer`); a restore drill worked.
- [ ] Pairing: the link was shown in the terminal only; `sib devices` lists only your phones; `forget-devices` works.
- [ ] Encryption at rest of Droplet disks and backups is documented in ADR-0011 **[verify]**.
- [ ] The privacy line in the app reads as in section 1.
- [ ] `sib hosted-check` results are recorded in ADR-0011.

## 12. Troubleshooting

| Symptom | Check |
|---|---|
| The browser says the certificate is invalid or the site is unreachable | DNS first (`dig +short <host>` shows the reserved IP), then the Cloud Firewall and `ufw status` (80 and 443), then `docker compose logs caddy`. Let's Encrypt limits repeated failed or duplicate requests (about 5 duplicate certificates a week **[verify]**): fix DNS before you retry. |
| 502 from Caddy | `docker compose ps`: the app is starting, unhealthy or restarting. `docker compose logs app`. |
| The app exits at start with a message about `SIB_...` | The environment is validated at start: `SIB_PUBLIC_ORIGIN` must be `https://`, the model ID must be on the list, the key must be set. Fix `/etc/sib/sib.env`, then `docker compose up -d --force-recreate app`. |
| `EACCES` or "permission denied" on `/data` | `/srv/sib/data` must be owned by uid 10001 and mode 0700: `chown 10001:10001 /srv/sib/data && chmod 0700 /srv/sib/data`. |
| Container "unhealthy" | `docker inspect sib-app-1 --format '{{json .State.Health}}'`. The check calls `http://127.0.0.1:8787/healthz` from inside; it must answer 2xx (204). |
| "Gemma offline" in the app | Prepaid balance, key budget (paused at 100 %), the daily cap (`SIB_DAILY_MODEL_CALLS`), or a wrong model ID: run `sib hosted-check` and read the log line for the status code. |
| Photo upload refused (409) | Expected with `SIB_DO_VISION=0`. |
| Photo upload fails with 413 | Caddy allows 11 MB; the app allows 10 MiB. |
| The out-of-memory killer, or the server is slow | `free -h`, `swapon --show`, `docker stats --no-stream`. The 1 GiB Droplet is tight: do not build images on it; resize it in the panel if it persists. |
| You cannot SSH in | Your IP changed: edit the firewall's SSH rule. Or use Droplet > Access > Launch Droplet Console in the panel **[verify]**. |
| The disk is filling | `du -sh /srv/sib/* /var/lib/docker`; `docker image prune` removes unused images (not the tags you keep for rollback); backups are limited to 7. |
| The backup service failed | `cat /srv/sib/backups/LAST_FAILURE` (the time of the last failure), `journalctl -u sib-backup.service`; run `/opt/sib/backup.sh` by hand. It needs the app container to exist. Delete `LAST_FAILURE` once a backup works again. |
| Metrics alerts do not arrive | `systemctl status do-agent`. The agent is installed when Monitoring is ticked at creation **[verify]**. |

## 13. Tear down

When you stop using hosted mode:

1. **Copy the data off first.** Droplet backups are deleted with the Droplet **[verify]**. Run the
   nightly copy once more and `scp -r` the newest folder to an encrypted disk of yours, or delete the
   data on purpose (it is household data).
2. In the panel, in this order: destroy the Droplet (its backups go with it **[verify]**); release the
   Reserved IP (it costs 5 US$ a month unassigned **[S]**); delete the Cloud Firewall, the monitoring
   alert policies and the project.
3. Delete the DNS A record.
4. Delete the model access key (and keep or remove the prepaid balance as you wish; check whether it
   expires or is refundable **[verify]**). Remove the account spend alert if you no longer need it.
5. Delete `sib-laptop` from Settings > Security if you do not use the SSH key elsewhere.
6. Delete any Droplet snapshots you made (Images > Snapshots), and the backup copies on your
   laptop once you no longer need them (they hold household data).
7. On the laptop: `docker rmi` the `sib:*` images if you want the space, and remove the Droplet's
   host key: `ssh-keygen -R <reserved IP>`.
8. Home mode keeps working without any of this.

## 14. Release with one command (recommended)

One command on the laptop builds the image, pushes it to your DigitalOcean Container Registry and
deploys it on the Droplet:

```bash
deploy/digitalocean/release.sh
```

What it does, in order:

1. Checks that the working tree is clean and is `origin/main` (asks before releasing anything else).
   The image tag is the commit (`git rev-parse --short=12 HEAD`), so every release is traceable.
2. Builds the image (`linux/amd64`).
3. Pushes it with a **push credential that doctl creates for 30 minutes** (`doctl registry
   docker-config --read-write --expiry-seconds 1800`), kept in a temporary folder and deleted after.
4. Copies the deploy kit (`compose.yaml`, `Caddyfile`, `backup.sh`, `deploy.sh`) to `/opt/sib`. Your
   settings (`/etc/sib/sib.env`, `/opt/sib/.env`) are never touched.
5. Runs `deploy.sh` on the Droplet with a **read-only pull credential valid for 10 minutes**, sent over
   SSH and deleted right after the pull. No registry credential is ever stored on the Droplet.
6. `deploy.sh` backs up the database (`/srv/sib/backups/pre-deploy`, newest 3), switches to the new
   image, waits until the app is healthy (3 minutes at most) and **rolls back to the previous version
   by itself** if it is not.

### 14.1 One-time setup on the laptop

1. **Create the registry:** Container Registry > Create, name for example `sib-registry`, region AMS3,
   the free Starter plan if it is offered **[verify]** (one repository is enough).
2. **Install doctl**, DigitalOcean's CLI: https://docs.digitalocean.com/reference/doctl/how-to/install/
   (in WSL: the Linux tarball from its GitHub releases, then `sudo mv doctl /usr/local/bin`).
3. **Sign in once:** API > Generate New Token (a custom scope with registry read and write is enough
   **[verify]** the scope names), then `doctl auth init` and paste it. doctl keeps it in
   `~/.config/doctl/config.yaml` (your user only). Check with `doctl registry get sib-registry`.
4. **Settings:** `mkdir -p ~/.config/sib && cp deploy/digitalocean/release.env.example ~/.config/sib/release.env`,
   then set `SIB_DROPLET=root@<reserved IP>` and `SIB_REGISTRY=<registry name>`.
5. Docker running on the laptop (Docker Desktop with WSL integration, or Docker Engine in WSL).
6. If your SSH key has a passphrase: `eval "$(ssh-agent)" && ssh-add` once per terminal.

### 14.2 First release on a new Droplet

```bash
deploy/digitalocean/release.sh --setup   # copies the kit and runs setup-droplet.sh (step 5)
```

Then create the two settings files on the Droplet (step 7: `/etc/sib/sib.env` with your domain and
Gemma key, `/opt/sib/.env` with `SIB_HOST`; `SIB_IMAGE_TAG` is set by the release), and release:

```bash
deploy/digitalocean/release.sh
ssh root@<reserved IP> 'cd /opt/sib && docker compose exec app sib hosted-check'   # step 8
ssh -t root@<reserved IP> 'cd /opt/sib && docker compose exec app sib pair'        # step 9
```

### 14.3 Every release after that

```bash
git switch main && git pull
deploy/digitalocean/release.sh
```

If the release says it rolled back, the old version is running and nothing is lost; read the app
lines it printed, fix the problem and release again. To go back to an earlier version by hand, see
10.3 (the last three images are kept on the Droplet).
