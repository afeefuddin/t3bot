#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
cd -- "$1"
release=$2
operation=$3
mkdir -p .updates
exec 9>.updates/update.lock
flock -n 9 || { echo "Another bot update is running." >&2; exit 1; }

compose() { docker compose -f compose.yaml "$@"; }
container=$(compose ps --all -q bot)
[[ -n "$container" && "$container" != *$'\n'* ]] || { echo "Expected one existing Compose bot service." >&2; exit 1; }
old_image=$(docker inspect --format '{{.Image}}' "$container")
image_ref=$(docker inspect --format '{{.Config.Image}}' "$container")
[[ "$image_ref" != *@* ]] || { echo "Use a tagged image in Compose before updating." >&2; exit 1; }
[[ $(docker inspect --format '{{if .Config.Healthcheck}}yes{{end}}' "$container") == yes ]] || { echo "The bot needs a Compose healthcheck." >&2; exit 1; }

if [[ "$operation" == rollback ]]; then
  [[ -s .updates/previous ]] || { echo "No previous successful release is recorded." >&2; exit 1; }
  read -r next_image < .updates/previous
  previous_schema=$(sed -n '2p' .updates/previous)
  [[ "$previous_schema" =~ ^[0-9]+$ ]] || { echo "Previous release has no compatible schema record." >&2; exit 1; }
  release=$(docker image inspect --format '{{index .Config.Labels "io.t3bot.release"}}' "$next_image")
else
  [[ "$release" =~ ^[a-f0-9]{20}$ ]] || { echo "Invalid release ID." >&2; exit 1; }
  echo "Building bot release $release..."
  docker build --build-arg "T3BOT_RELEASE=$release" -t "t3bot:release-$release" ".updates/$release"
  next_image=$(docker image inspect --format '{{.Id}}' "t3bot:release-$release")
fi
[[ "$next_image" != "$old_image" ]] || { echo "This bot is already running that release."; exit 0; }

# The running image may only have a mutable local tag. Pin it before retagging.
docker tag "$old_image" "t3bot:retained-${old_image#sha256:}"
backup_id=$(date -u +%Y%m%dT%H%M%SZ)-${next_image#sha256:}
echo "Backing up bot state..."
compose exec -T bot node --input-type=module - "$backup_id" <<'NODE'
import { DatabaseSync, backup } from 'node:sqlite';
import fs from 'node:fs/promises';
import path from 'node:path';
const home = process.env.T3BOT_HOME || '/data/bot';
const db = new DatabaseSync(path.join(home, 'bot.sqlite'), {readOnly:true});
const busy = db.prepare("SELECT count(*) AS n FROM jobs WHERE state='running'").get().n
  + db.prepare("SELECT count(*) AS n FROM records WHERE kind='process' AND json_extract(data,'$.status')='running'").get().n
  + db.prepare("SELECT count(*) AS n FROM connector_deliveries WHERE state='running'").get().n;
if (busy) throw new Error('The bot is processing work. Retry the update when it is idle.');
const destination = path.join(home, '.updates', process.argv[2]);
await fs.mkdir(path.join(destination, 'check'), {recursive:true, mode:0o700});
await backup(db, path.join(destination, 'bot.sqlite'));
db.close();
await fs.copyFile(path.join(destination, 'bot.sqlite'), path.join(destination, 'check', 'bot.sqlite'));
await fs.copyFile(path.join(home, 'owner-token'), path.join(destination, 'check', 'owner-token')).catch(e => {if(e.code!=='ENOENT') throw e;});
console.log('SQLite backup saved in ' + destination);
NODE
check_home=$(compose exec -T bot node -e 'console.log(require("node:path").join(process.env.T3BOT_HOME || "/data/bot", ".updates", process.argv[1], "check"))' "$backup_id")
schema=$(compose exec -T bot node -e 'const db=new (require("node:sqlite").DatabaseSync)(require("node:path").join(process.env.T3BOT_HOME || "/data/bot","bot.sqlite"),{readOnly:true}); console.log(db.prepare("SELECT max(version) AS v FROM bot_schema").get().v); db.close()')
if [[ "$operation" == rollback && "$schema" != "$previous_schema" ]]; then
  echo "Database schema changed since that release; use a planned migration instead of rollback." >&2
  exit 1
fi

restarted=0
restore() {
  result=${1:-$?}
  trap - ERR HUP INT TERM
  echo "Update failed; restoring the previous image..." >&2
  docker tag "$old_image" "$image_ref"
  if [[ "$restarted" == 1 ]]; then
    compose up -d --no-deps --pull never --force-recreate --wait --wait-timeout 90 bot || {
      echo "Rollback did not become healthy. State and the pre-update backup have been retained." >&2
      exit 1
    }
  fi
  exit "$result"
}
trap restore ERR
trap 'restore 130' HUP INT TERM
docker tag "$next_image" "$image_ref"

# Validate on a cloned database, before any worker can touch the real state.
if [[ "$operation" != rollback ]]; then
  compose run --rm -T --no-deps -e "T3BOT_HOME=$check_home" bot node /opt/t3bot/main.mjs check
fi
compose exec -T bot node --input-type=module - "$check_home" <<'NODE'
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import path from 'node:path';
const home = process.env.T3BOT_HOME || '/data/bot';
const version = filename => {
  const db = new DatabaseSync(filename, {readOnly:true});
  try { return db.prepare('SELECT max(version) AS v FROM bot_schema').get().v; }
  finally { db.close(); }
};
if(version(path.join(home,'bot.sqlite')) !== version(path.join(process.argv[2],'bot.sqlite')))
  throw new Error('Database schema changed; use a planned migration instead of an automatic update.');
await fs.rm(process.argv[2], {recursive:true});
NODE

echo "Restarting the bot; project executors stay running..."
restarted=1
compose stop --timeout 30 bot
# Once stopped, no new work can race the idle check or the final backup.
compose run --rm -T --no-deps bot node --input-type=module - "$backup_id" <<'NODE'
import { DatabaseSync, backup } from 'node:sqlite';
import path from 'node:path';
const home = process.env.T3BOT_HOME || '/data/bot';
const db = new DatabaseSync(path.join(home, 'bot.sqlite'), {readOnly:true});
const busy = db.prepare("SELECT count(*) AS n FROM jobs WHERE state='running'").get().n
  + db.prepare("SELECT count(*) AS n FROM records WHERE kind='process' AND json_extract(data,'$.status')='running'").get().n
  + db.prepare("SELECT count(*) AS n FROM connector_deliveries WHERE state='running'").get().n;
if(busy) throw new Error('Work started during the update. Restoring the old bot; retry when idle.');
await backup(db, path.join(home, '.updates', process.argv[2], 'bot.sqlite'));
db.close();
NODE
compose up -d --no-deps --pull never --force-recreate --wait --wait-timeout 90 bot
container=$(compose ps -q bot)
[[ $(docker inspect --format '{{.Image}}' "$container") == "$next_image" ]]
[[ $(docker inspect --format '{{.State.Health.Status}}' "$container") == healthy ]]
compose exec -T bot node --input-type=module - "$release" <<'NODE'
const response = await fetch(`http://127.0.0.1:${process.env.T3BOT_PORT || 3780}/health`, {signal:AbortSignal.timeout(5000)});
const health = await response.json();
if(!response.ok || health.status !== 'ready') throw new Error('Bot health verification failed');
const expected = process.argv[2];
if(expected && expected !== '<no value>' && health.release !== expected) throw new Error('The running release does not match');
console.log('Verified healthy bot release ' + (health.release || 'legacy'));
NODE
printf '%s\n%s\n' "$old_image" "$schema" > .updates/previous.next
mv .updates/previous.next .updates/previous
printf '%s\n' "$backup_id" > .updates/last-backup
trap - ERR HUP INT TERM
echo "Bot updated successfully. Roll back with: vp run bot:rollback <ssh-host>"
