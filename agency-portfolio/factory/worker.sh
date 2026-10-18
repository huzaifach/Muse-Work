#!/bin/bash
# Mr.Blues Tech — autonomous factory worker
# ---------------------------------------------------------------
# Pure VM-side. No agent, no wake-ups, no tokens.
# Queue:  ~/workspace/agency-portfolio/queue/*.txt   (filename = job name, file = prompt)
# Output: ~/workspace/your_files/agency-portfolio/<job>/output.md
# Runs from systemd timer every 15 min. Idempotent: done jobs leave the queue.
# Generation: vault-backed Gemini helper (key lives in Secure Vault, never on disk).
set -u
BASE="$HOME/workspace/agency-portfolio"
QUEUE="$BASE/queue"; DONE="$BASE/done"; OUT="$HOME/workspace/your_files/agency-portfolio"
GEN="$HOME/workspace/custom-connectors/custom.google-ai-studio/bin/generate.py"
LOG="$BASE/factory/worker.log"

log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }
# Notifications: NONE — Huzaifa declined Telegram (2026-10-18 ~19:50 PKT) and
# ntfy.sh is blocked from this VM. He checks your_files himself ("me check kr lunga").
notify() {
  echo "[$(date '+%F %T')] notify(skipped): $1" >> "$LOG"
}

mkdir -p "$QUEUE" "$DONE" "$OUT"

[ -x "$GEN" ] || chmod +x "$GEN" 2>/dev/null
[ -f "$GEN" ] || { log "FATAL: generate helper missing"; exit 1; }
command -v python3 >/dev/null 2>&1 || { log "FATAL: python3 missing"; exit 1; }

# process queue
shopt -s nullglob
done_count=0; fail_count=0
for f in "$QUEUE"/*.txt; do
  name="$(basename "$f" .txt)"
  case "$name" in .*|*~) continue;; esac
  dest="$OUT/$name"; mkdir -p "$dest"
  log "START $name"
  if timeout 900 python3 "$GEN" --prompt-file "$f" --out "$dest/output.md" > "$dest/.stdout" 2> "$dest/.err"; then
    if [ -s "$dest/output.md" ]; then
      mv "$f" "$DONE/$name.txt"
      done_count=$((done_count+1)); log "DONE $name ($(wc -c < "$dest/output.md") bytes)"
      notify "Mr.Blues Factory: '$name' complete → your_files/agency-portfolio/$name/output.md"
    else
      fail_count=$((fail_count+1)); log "EMPTY $name"
    fi
  else
    fail_count=$((fail_count+1)); log "FAIL $name (kept in queue for retry)"
  fi
  sleep 10  # gentle on the free-tier rate limit
done

if [ "$done_count" -gt 0 ] || [ "$fail_count" -gt 0 ]; then
  notify "Factory run finished: $done_count done, $fail_count failed/retried"
  log "RUN finished: $done_count done, $fail_count failed"
fi
