#!/data/data/com.termux/files/usr/bin/sh
# Starts/stops the job agent on the phone: the agent (Termux Node) + the browser worker (Debian proot, Xvfb).
# "start" is idempotent (used by ~/start.sh at boot). "restart" kills and starts both.
# Other people: one agent each for every people/<name>/ that has a "port" file (JA_PERSON=<name>, JA_PORT=<port>).
# They share the one browser worker.
# On the laptop (Ubuntu, not Termux) the same commands drive systemd units instead: see linux/.
[ -d /data/data/com.termux ] || exec sh "$(dirname "$0")/../linux/run.sh" "$@"
J=$HOME/jobagent
RUN=$PREFIX/var/run
# Standby: while the agents run on the laptop, the phone keeps a synced copy and must not start it
# (not even at boot). linux/failover.sh removes the flag when the phone takes over.
if [ -f $J/STANDBY ] && [ "$1" != stop ]; then echo "standby: the agents run on the laptop (rm ~/jobagent/STANDBY to take over)"; exit 0; fi
mkdir -p $J/data
start_worker() {
  kill -0 "$(cat $RUN/jobworker.pid 2>/dev/null)" 2>/dev/null && return
  nohup proot-distro login --isolated --bind "$J:$J" debian -- /usr/bin/env -i HOME=/root \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    xvfb-run -a -s "-screen 0 1366x900x24" node "$J/browser/worker.mjs" >> $J/data/worker.log 2>&1 &
  echo $! > $RUN/jobworker.pid
}
start_agent() {
  kill -0 "$(cat $RUN/jobagent.pid 2>/dev/null)" 2>/dev/null && return
  nohup node "$J/src/agent.mjs" >> $J/data/agent.out 2>&1 &
  echo $! > $RUN/jobagent.pid
}
start_people() {
  for d in $J/people/*/; do
    [ -f "$d/port" ] || continue
    n=$(basename "$d"); mkdir -p "$d/data"
    kill -0 "$(cat $RUN/jobagent-$n.pid 2>/dev/null)" 2>/dev/null && continue
    JA_PERSON=$n JA_PORT=$(cat "$d/port") nohup node "$J/src/agent.mjs" >> "$d/data/agent.out" 2>&1 &
    echo $! > $RUN/jobagent-$n.pid
  done
}
stop_people() { for f in $RUN/jobagent-*.pid; do [ -f "$f" ] && { kill "$(cat "$f")" 2>/dev/null; rm -f "$f"; }; done; true; }
stop() {
  stop_people
  for p in jobagent jobworker; do kill "$(cat $RUN/$p.pid 2>/dev/null)" 2>/dev/null; rm -f $RUN/$p.pid; done
  pkill -f "browser/worker.mjs" 2>/dev/null; pkill -f "chrome.*--no-sandbox" 2>/dev/null; pkill -f Xvfb 2>/dev/null
  sleep 1; true
}
stop_worker() {
  kill "$(cat $RUN/jobworker.pid 2>/dev/null)" 2>/dev/null; rm -f $RUN/jobworker.pid
  pkill -f "browser/worker.mjs" 2>/dev/null; pkill -f "chrome.*--no-sandbox" 2>/dev/null; pkill -f Xvfb 2>/dev/null
  sleep 2; true
}
case "$1" in
  stop) stop ;;
  worker) stop_worker; start_worker ;;                  # used by the agent's watchdog
  restart) stop; start_worker; [ -f $J/src/agent.mjs ] && { start_agent; start_people; } ;;
  people) stop_people; start_people ;;                   # (re)start everyone else's agent, leaving the owner's running
  *) start_worker; [ -f $J/src/agent.mjs ] && { start_agent; start_people; } ;;
esac
