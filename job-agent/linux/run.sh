#!/bin/sh
# Laptop (Ubuntu) side of scripts/run.sh: the agents are systemd units installed by linux/install.sh.
#   jobworker        the shared headed Chromium under Xvfb (127.0.0.1:8084)
#   jobagent         the owner's agent (:8083)
#   jobagent@<name>  everyone in people/<name>/ with a "port" file
#   phone-link       ssh to the S20: Cupboard's internal API here (:8086), the agents' ports there
J=$HOME/jobagent
people() { for d in "$J"/people/*/; do [ -f "$d/port" ] && echo "jobagent@$(basename "$d")"; done; }
case "$1" in
  stop) sudo systemctl stop jobagent $(people) jobworker ;;
  worker) sudo systemctl restart jobworker ;;                   # the owner agent's watchdog
  people) sudo systemctl restart $(people) ;;
  restart) sudo systemctl restart phone-link jobworker jobagent $(people) ;;
  *) sudo systemctl start phone-link jobworker jobagent $(people) ;;
esac
