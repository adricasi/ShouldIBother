#!/usr/bin/env bash
# One-command release from the laptop (T-042): build the image, push it to the DigitalOcean
# Container Registry, and deploy it on the Droplet (backup, health check, automatic rollback).
#
#   deploy/digitalocean/release.sh           # release the current commit
#   deploy/digitalocean/release.sh --setup   # first time only: prepare a fresh Droplet, then release
#
# Needs on the laptop: git, docker, ssh and doctl, signed in once with `doctl auth init`.
# Settings: ~/.config/sib/release.env (copy release.env.example). Registry credentials are made
# by doctl for this run only and expire on their own: 30 min to push, 10 min (read-only) to pull.
set -euo pipefail

readonly SETTINGS="${SIB_RELEASE_ENV:-$HOME/.config/sib/release.env}"
KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$KIT_DIR/../.." && pwd)"
readonly KIT_DIR REPO_ROOT

log() {
  printf '\n== %s\n' "$*"
}

die() {
  printf 'release: %s\n' "$*" >&2
  exit 1
}

setup=false
case "${1:-}" in
  "") ;;
  --setup) setup=true ;;
  *) die "usage: release.sh [--setup]" ;;
esac

for tool in git docker ssh scp doctl; do
  command -v "$tool" > /dev/null 2>&1 || die "$tool is not installed (guide 14.1)"
done
[[ -f "$SETTINGS" ]] || die "no $SETTINGS: copy deploy/digitalocean/release.env.example there and fill it in"
# shellcheck disable=SC1090
. "$SETTINGS"
readonly DROPLET="${SIB_DROPLET:?set SIB_DROPLET (root@<reserved IP>) in $SETTINGS}"
readonly REGISTRY="${SIB_REGISTRY:?set SIB_REGISTRY (your registry name) in $SETTINGS}"
readonly REPOSITORY="registry.digitalocean.com/$REGISTRY/sib"
[[ "$REGISTRY" =~ ^[a-z0-9-]+$ ]] || die "SIB_REGISTRY must be the registry name only, e.g. sib-registry"
[[ "$DROPLET" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9.:-]+$ ]] || die "SIB_DROPLET must look like root@203.0.113.10"

cd "$REPO_ROOT"
[[ -z "$(git status --porcelain)" ]] || die "uncommitted changes: commit or stash them, so the release is exactly a commit"
git fetch -q origin main || die "cannot reach GitHub to check the version"
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  printf 'release: HEAD is not origin/main (%s vs %s).\n' "$(git rev-parse --short HEAD)" "$(git rev-parse --short origin/main)" >&2
  read -r -p "Release this commit anyway? [y/N] " answer
  [[ "$answer" == "y" || "$answer" == "Y" ]] || die "stopped; run git switch main && git pull first"
fi
TAG="$(git rev-parse --short=12 HEAD)"
readonly TAG

log "Checking access (doctl, registry, Droplet)"
doctl registry get "$REGISTRY" > /dev/null || die "doctl cannot see registry $REGISTRY (doctl auth init? right name?)"
ssh -o BatchMode=yes -o ConnectTimeout=10 "$DROPLET" true || die "cannot SSH to $DROPLET (key, firewall rule for your IP?)"

if [[ "$setup" == true ]]; then
  log "First-time setup of the Droplet"
  ssh "$DROPLET" 'install -d -m 0750 /opt/sib'
  scp -q "$KIT_DIR"/* "$DROPLET:/opt/sib/"
  ssh "$DROPLET" 'bash /opt/sib/setup-droplet.sh'
  cat <<NEXT

The Droplet is ready. Before the first release, create its two settings files (guide 7):
  ssh $DROPLET
  install -m 0600 /opt/sib/env.example /etc/sib/sib.env && nano /etc/sib/sib.env
  cd /opt/sib && cp compose.env.example .env && chmod 0600 .env && nano .env
Then run deploy/digitalocean/release.sh (without --setup).
NEXT
  exit 0
fi

log "Building sib:$TAG"
docker build --platform linux/amd64 -t "$REPOSITORY:$TAG" .

log "Pushing to $REPOSITORY:$TAG"
push_config="$(mktemp -d)"
trap 'rm -rf "$push_config"' EXIT
doctl registry docker-config --read-write --expiry-seconds 1800 > "$push_config/config.json"
docker --config "$push_config" push "$REPOSITORY:$TAG"
rm -rf "$push_config"

log "Updating the deploy kit on the Droplet"
# The kit only: the settings (/etc/sib/sib.env, /opt/sib/.env) stay as they are.
scp -q "$KIT_DIR"/compose.yaml "$KIT_DIR"/Caddyfile "$KIT_DIR"/backup.sh "$KIT_DIR"/deploy.sh "$DROPLET:/opt/sib/"
ssh "$DROPLET" 'chmod 0755 /opt/sib/backup.sh /opt/sib/deploy.sh'

log "Deploying on the Droplet"
# The repository and tag are checked above and again by deploy.sh; they expand here on purpose.
# shellcheck disable=SC2029
doctl registry docker-config --expiry-seconds 600 \
  | ssh "$DROPLET" /opt/sib/deploy.sh "$REPOSITORY" "$TAG"

host="$(ssh "$DROPLET" "sed -n 's/^SIB_HOST=//p' /opt/sib/.env")"
log "Released sib:$TAG: https://$host"
docker image rm "$REPOSITORY:$TAG" > /dev/null 2>&1 || true
