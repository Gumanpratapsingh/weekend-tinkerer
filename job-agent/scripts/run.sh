#!/data/data/com.termux/files/usr/bin/sh
# Starts/stops the job agent on the phone: the agent (Termux Node) + the browser worker (Debian proot, Xvfb).
# "start" is idempotent (used by ~/start.sh at boot). "restart" kills and starts both.
J=$HOME/jobagent
RUN=$PREFIX/var/run
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
stop() {
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
  restart) stop; start_worker; [ -f $J/src/agent.mjs ] && start_agent ;;
  *) start_worker; [ -f $J/src/agent.mjs ] && start_agent ;;
esac
