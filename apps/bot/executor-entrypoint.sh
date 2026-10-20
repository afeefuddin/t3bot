#!/bin/sh
set -eu
cd /workspace
if [ ! -d .git ]; then
  git init --initial-branch=main
  git -c user.name=t3bot -c user.email=t3bot@localhost commit --allow-empty -m 'Initialize bot workspace'
fi
exec node /opt/t3bot/apps/server/dist/bin.mjs start --no-browser --auto-bootstrap-project-from-cwd --base-dir /data/t3
