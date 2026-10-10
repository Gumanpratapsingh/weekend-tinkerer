#!/bin/bash
# One-time link to create the owner account (works only while no owner exists, expires in 24 h).
# Open it on your iPhone in Safari, choose a username and password there; nothing secret passes through here.
HOST=${1:-s20phone}
ssh "$HOST" 'cd ~/cupboard/server && node --no-warnings -e "
import(\"./db.mjs\").then(({ run, owner }) => {
  if (owner()) { console.log(\"An owner already exists.\"); return; }
  const t = require(\"crypto\").randomBytes(16).toString(\"hex\");
  run(\"INSERT INTO invites(token, role, expires) VALUES(?, \x27owner\x27, ?)\", t, Date.now() + 86400e3);
  console.log(\"https://cupboard.gumanpratap.workers.dev/invite/\" + t);
})"'
