#!/usr/bin/env bash
# Nightly backup of the hosted app (NFR-013): an online, consistent copy of the SQLite database
# (VACUUM INTO) plus a tar of the photos, in /srv/sib/backups/<date>/. The newest 7 are kept.
#
# The database copy is made by a one-shot container from the image that is running, with the
# same better-sqlite3 as the app: no sqlite3 package on the host, no root-owned -wal/-shm files,
# and the app stays up. The copy leaves the container on stdout, so the container has no
# writable mount.
#
# The backups hold household data (photos, chores, habits): owner-only, never to a public place.
# Not included: /etc/sib/sib.env (it holds the inference key; keep it in your password manager).
set -euo pipefail
umask 077

readonly COMPOSE_DIR="${SIB_COMPOSE_DIR:-/opt/sib}"
readonly DATA_DIR="${SIB_DATA_HOST_DIR:-/srv/sib/data}"
readonly BACKUP_ROOT="${SIB_BACKUP_DIR:-/srv/sib/backups}"
readonly KEEP="${SIB_BACKUP_KEEP:-7}"
readonly RUN_UID=10001

stamp="$(date -u +%F)"
final="$BACKUP_ROOT/$stamp"
work="$BACKUP_ROOT/.partial-$stamp.$$"

cleanup() {
  rm -rf "$work"
}
trap cleanup EXIT

log() {
  printf 'sib-backup: %s\n' "$*"
}

[[ -f "$DATA_DIR/sib.db" ]] || { log "no database at $DATA_DIR/sib.db"; exit 1; }
[[ "$KEEP" =~ ^[0-9]+$ && "$KEEP" -ge 1 ]] || { log "SIB_BACKUP_KEEP must be a number >= 1"; exit 1; }

# The image of the app container (running or stopped), so the copy is made by the same code.
container="$(docker compose --project-directory "$COMPOSE_DIR" -f "$COMPOSE_DIR/compose.yaml" ps -aq app)"
[[ -n "$container" ]] || { log "no app container; run docker compose up -d first"; exit 1; }
image="$(docker inspect --format '{{.Image}}' "$container")"

install -d -m 0700 "$BACKUP_ROOT" "$work"

# VACUUM INTO writes a consistent, defragmented copy while the app keeps running (WAL mode).
# The copy is checked, then streamed out.
snapshot_js='
const Database = require("better-sqlite3");
const fs = require("node:fs");
const target = "/tmp/snapshot.db";
const source = new Database("/data/sib.db", { fileMustExist: true });
source.pragma("busy_timeout = 10000");
source.exec("VACUUM INTO '" + target + "'");
source.close();
const copy = new Database(target, { readonly: true });
const verdict = copy.pragma("integrity_check", { simple: true });
copy.close();
if (verdict !== "ok") {
  console.error("integrity_check: " + verdict);
  process.exit(1);
}
fs.createReadStream(target).pipe(process.stdout);
'
docker run --rm \
  --network none \
  --user "$RUN_UID:$RUN_UID" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --memory 256m \
  -v "$DATA_DIR:/data" \
  --entrypoint node \
  "$image" -e "$snapshot_js" > "$work/sib.db"

[[ -s "$work/sib.db" ]] || { log "the database copy is empty"; exit 1; }

# Photos are written once and not changed; a file added during the tar is picked up tomorrow.
if [[ -d "$DATA_DIR/photos" ]]; then
  tar -C "$DATA_DIR" -czf "$work/photos.tar.gz" photos
else
  log "no photos folder yet"
fi

# Replace today's backup only after the new one is complete.
rm -rf "$final"
mv "$work" "$final"
log "wrote $final ($(du -sh "$final" | cut -f1))"

# Keep the newest $KEEP dated folders (names sort by date); never touch anything else.
mapfile -t old < <(
  find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]' -printf '%f\n' \
    | sort -r | tail -n "+$((KEEP + 1))"
)
for name in "${old[@]}"; do
  rm -rf -- "${BACKUP_ROOT:?}/$name"
  log "removed $name"
done
