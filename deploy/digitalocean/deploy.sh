#!/usr/bin/env bash
# Droplet side of a release (T-042). Called over SSH by release.sh on the laptop:
#
#   doctl registry docker-config --expiry-seconds 600 | ssh root@<droplet> /opt/sib/deploy.sh <repository> <tag>
#
# It reads a short-lived, read-only registry credential from stdin, pulls <repository>:<tag>,
# deletes the credential, and then switches the app to the new image: backup first, wait until the
# app is healthy, and roll back to the previous image if it is not. No registry credential is kept
# on the Droplet.
set -euo pipefail
umask 077

readonly COMPOSE_DIR="${SIB_COMPOSE_DIR:-/opt/sib}"
readonly DATA_DIR="${SIB_DATA_HOST_DIR:-/srv/sib/data}"
readonly HEALTH_TIMEOUT="${SIB_HEALTH_TIMEOUT:-180}"
readonly KEEP_IMAGES=3

log() {
  printf 'deploy: %s\n' "$*"
}

die() {
  log "ERROR: $*"
  exit 1
}

[[ "$(id -u)" -eq 0 ]] || die "run as root"
[[ $# -eq 2 ]] || die "usage: deploy.sh <registry.digitalocean.com/<registry>/<repository>> <tag>"
readonly REPOSITORY="$1" TAG="$2"
[[ "$REPOSITORY" =~ ^registry\.digitalocean\.com/[a-z0-9-]+/[a-z0-9._-]+$ ]] || die "not a DigitalOcean registry repository: $REPOSITORY"
[[ "$TAG" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || die "not a valid tag: $TAG"
[[ -f "$COMPOSE_DIR/.env" && -f /etc/sib/sib.env ]] || die "settings missing: create /etc/sib/sib.env and $COMPOSE_DIR/.env first (guide 7)"

# Pull with the credential from stdin, kept in a private temporary folder for the pull only.
creds="$(mktemp -d)"
trap 'rm -rf "$creds"' EXIT
cat > "$creds/config.json"
[[ -s "$creds/config.json" ]] || die "no registry credential on stdin (release.sh sends one)"
log "pulling $REPOSITORY:$TAG"
docker --config "$creds" pull --quiet "$REPOSITORY:$TAG" > /dev/null || die "pull failed (tag pushed? credential expired?)"
rm -rf "$creds"
docker tag "$REPOSITORY:$TAG" "sib:$TAG"
docker rmi "$REPOSITORY:$TAG" > /dev/null

compose() {
  docker compose --project-directory "$COMPOSE_DIR" -f "$COMPOSE_DIR/compose.yaml" "$@"
}

set_tag() {
  sed -i "s/^SIB_IMAGE_TAG=.*/SIB_IMAGE_TAG=$1/" "$COMPOSE_DIR/.env"
}

wait_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT)) container status
  while ((SECONDS < deadline)); do
    container="$(compose ps -q app)"
    if [[ -n "$container" ]]; then
      status="$(docker inspect --format '{{.State.Health.Status}}' "$container" 2> /dev/null || true)"
      [[ "$status" == "healthy" ]] && return 0
    fi
    sleep 5
  done
  return 1
}

previous="$(sed -n 's/^SIB_IMAGE_TAG=//p' "$COMPOSE_DIR/.env" | tail -n 1)"
if [[ "$previous" == "$TAG" ]] && [[ -n "$(compose ps -q app)" ]]; then
  log "sib:$TAG is already the running version; restarting it with the current kit"
fi

# A new version may migrate the database forward, which switching back cannot undo: copy it
# first (not on the very first deploy, when there is no database yet).
if [[ -f "$DATA_DIR/sib.db" ]] && [[ -n "$(compose ps -aq app)" ]]; then
  log "backing up before the switch"
  SIB_BACKUP_DIR=/srv/sib/backups/pre-deploy SIB_BACKUP_KEEP=3 "$COMPOSE_DIR/backup.sh" \
    || die "pre-deploy backup failed; nothing was changed"
fi

log "starting sib:$TAG (was sib:${previous:-none})"
set_tag "$TAG"
if compose up -d --remove-orphans && wait_healthy; then
  log "sib:$TAG is healthy and live"
  # Keep the newest few images for a manual rollback (guide 10.3).
  mapfile -t old < <(docker image ls sib --format '{{.CreatedAt}}\t{{.Tag}}' | sort -r \
    | cut -f2 | tail -n "+$((KEEP_IMAGES + 1))")
  for tag in "${old[@]}"; do
    [[ "$tag" == "$TAG" || "$tag" == "$previous" ]] || docker rmi "sib:$tag" > /dev/null 2>&1 || true
  done
  exit 0
fi

log "sib:$TAG did not become healthy within ${HEALTH_TIMEOUT}s"
compose logs --tail 40 app 2>&1 | sed 's/^/  app: /' || true
if [[ -z "$previous" || "$previous" == "$TAG" ]]; then
  die "no previous version to roll back to; fix the problem above and release again"
fi
log "rolling back to sib:$previous"
set_tag "$previous"
compose up -d --remove-orphans || true
if wait_healthy; then
  die "rolled back to sib:$previous, which is healthy. If the new version migrated the database, restore /srv/sib/backups/pre-deploy (guide 10.4)"
fi
die "rolled back to sib:$previous, but it is not healthy either: restore /srv/sib/backups/pre-deploy (guide 10.4)"
