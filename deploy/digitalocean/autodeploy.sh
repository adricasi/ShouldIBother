#!/usr/bin/env bash
# Automatic deploy for the hosted app (T-042): pulls the release channel tag (default `prod`) from
# the DigitalOcean Container Registry and, when its image differs from the one running, backs up,
# switches the app to it, waits until it is healthy, and rolls back to the previous image if it is
# not. Run by sib-autodeploy.timer every few minutes; safe to run by hand.
#
# The Droplet only pulls: it never builds. Images are built and pushed from the laptop (guide 14).
# Settings come from /etc/sib/autodeploy.env (see autodeploy.env.example). The registry login is a
# read-only token, stored by `docker login` in /root/.docker/config.json (mode 0600).
set -euo pipefail
umask 077

readonly SETTINGS="${SIB_AUTODEPLOY_ENV:-/etc/sib/autodeploy.env}"
readonly COMPOSE_DIR="${SIB_COMPOSE_DIR:-/opt/sib}"
readonly STATE_DIR="${SIB_AUTODEPLOY_STATE:-/srv/sib/autodeploy}"
readonly HEALTH_TIMEOUT="${SIB_HEALTH_TIMEOUT:-180}"
readonly KEEP_IMAGES=3

log() {
  printf 'sib-autodeploy: %s\n' "$*"
}

fail() {
  log "ERROR: $*"
  date -u +%FT%TZ > "$STATE_DIR/LAST_FAILURE"
  exit 1
}

[[ "$(id -u)" -eq 0 ]] || { log "run as root"; exit 1; }
[[ -f "$SETTINGS" ]] || { log "no $SETTINGS (copy autodeploy.env.example there)"; exit 1; }
# shellcheck disable=SC1090
. "$SETTINGS"
readonly REPOSITORY="${SIB_REGISTRY_REPOSITORY:?set SIB_REGISTRY_REPOSITORY in $SETTINGS}"
readonly CHANNEL="${SIB_RELEASE_CHANNEL:-prod}"
[[ "$REPOSITORY" =~ ^registry\.digitalocean\.com/[a-z0-9-]+/[a-z0-9._-]+$ ]] \
  || { log "SIB_REGISTRY_REPOSITORY must look like registry.digitalocean.com/<registry>/<repository>"; exit 1; }
[[ "$CHANNEL" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || { log "SIB_RELEASE_CHANNEL is not a valid tag"; exit 1; }

install -d -m 0700 "$STATE_DIR"
# One run at a time: a slow pull or health wait must not overlap the next timer tick.
exec 9> "$STATE_DIR/lock"
flock -n 9 || { log "another run is in progress"; exit 0; }

compose() {
  docker compose --project-directory "$COMPOSE_DIR" -f "$COMPOSE_DIR/compose.yaml" "$@"
}

current_tag="$(sed -n 's/^SIB_IMAGE_TAG=//p' "$COMPOSE_DIR/.env" | tail -n 1)"
[[ -n "$current_tag" ]] || fail "no SIB_IMAGE_TAG in $COMPOSE_DIR/.env"

docker pull --quiet "$REPOSITORY:$CHANNEL" > /dev/null || fail "pull of $REPOSITORY:$CHANNEL failed (registry login, network or tag)"
new_id="$(docker image inspect --format '{{.Id}}' "$REPOSITORY:$CHANNEL")"
current_id="$(docker image inspect --format '{{.Id}}' "sib:$current_tag" 2> /dev/null || true)"

if [[ "$new_id" == "$current_id" ]]; then
  exit 0
fi
# An image that failed its health check once is not tried again; push a new one to retry.
if grep -qxF "$new_id" "$STATE_DIR/failed-images" 2> /dev/null; then
  exit 0
fi

new_tag="auto-${new_id#sha256:}"
new_tag="${new_tag:0:17}"
log "new image on $CHANNEL: $new_id, deploying as sib:$new_tag (current sib:$current_tag)"
docker tag "$REPOSITORY:$CHANNEL" "sib:$new_tag"

# A new version may migrate the database forward, and switching the image back cannot undo
# that: take a copy first, in its own folder so the nightly backups are untouched.
# The very first deploy has no database yet, so there is nothing to copy.
if [[ -f /srv/sib/data/sib.db ]]; then
  SIB_BACKUP_DIR=/srv/sib/backups/pre-deploy SIB_BACKUP_KEEP=3 "$COMPOSE_DIR/backup.sh" \
    || fail "pre-deploy backup failed; nothing changed"
fi

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

set_tag "$new_tag"
if compose up -d && wait_healthy; then
  log "sib:$new_tag is healthy and live"
  rm -f "$STATE_DIR/LAST_FAILURE"
  # Keep the newest few auto-deployed images for a manual rollback; never touch hand-built tags.
  mapfile -t old < <(docker image ls sib --format '{{.Tag}} {{.CreatedAt}}' \
    | awk '$1 ~ /^auto-/' | sort -k2 -r | awk '{ print $1 }' | tail -n "+$((KEEP_IMAGES + 1))")
  for tag in "${old[@]}"; do
    [[ "$tag" == "$new_tag" ]] || docker rmi "sib:$tag" > /dev/null 2>&1 || true
  done
  exit 0
fi

log "sib:$new_tag did not become healthy within ${HEALTH_TIMEOUT}s; rolling back to sib:$current_tag"
compose logs --tail 40 app 2>&1 | sed 's/^/  app: /' || true
echo "$new_id" >> "$STATE_DIR/failed-images"
set_tag "$current_tag"
compose up -d || true
if wait_healthy; then
  fail "rolled back to sib:$current_tag (healthy). If the new version migrated the database, restore /srv/sib/backups/pre-deploy (guide 10.4)"
fi
fail "rolled back to sib:$current_tag but it is not healthy either: restore from /srv/sib/backups/pre-deploy (guide 10.4)"
