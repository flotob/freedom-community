#!/bin/bash
# Doorbell keeper: a workaround, not a fix.
# Ant's GSOC subscriptions stop delivering some time after antd starts (see "Ant lurker" in
# the project roadmap). The steward rings its own doorbell every few minutes and reports
# missed canaries on its status port. When the canary keeps missing and antd has been up a
# while, this stops antd; Docker's restart policy (unless-stopped) starts it again in the same
# container, with the same address, which clears the stuck state.
#
# Run it as a Coolify scheduled task on the Ant app, e.g. every 10 minutes:  ant-keeper
set -u
STATUS=${KEEPER_STATUS:-davinci-steward:8080}   # host:port of the steward's status endpoint
MIN_MISSES=${KEEPER_MIN_MISSES:-2}              # consecutive canary misses before acting
MIN_UPTIME=${KEEPER_MIN_UPTIME_S:-900}          # never restart a node younger than this
LOG=${KEEPER_LOG:-/home/ant/.antd/keeper.log}

host=${STATUS%:*} port=${STATUS#*:}
up=$(( $(cut -d. -f1 /proc/uptime) - $(awk '{print $22}' /proc/1/stat) / $(getconf CLK_TCK) ))
body=$(timeout 10 bash -c "exec 3<>/dev/tcp/$host/$port && printf 'GET / HTTP/1.0\r\nHost: %s\r\n\r\n' '$host' >&3 && cat <&3" 2>/dev/null | tr -d '\r' | sed '1,/^$/d')
misses=$(grep -o '"canaryMisses":[0-9]*' <<<"$body" | cut -d: -f2)

say() { echo "$(date -u +%FT%TZ) up=${up}s misses=${misses:-?} $*" | tee -a "$LOG"; }

if [ -z "$misses" ]; then say "steward status unavailable; doing nothing"; exit 0; fi
if [ "$misses" -ge "$MIN_MISSES" ] && [ "$up" -ge "$MIN_UPTIME" ]; then
  say "doorbell canary keeps missing: restarting antd"
  kill -TERM 1
else
  say ok
fi
