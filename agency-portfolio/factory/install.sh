#!/bin/bash
# One-time factory install. Re-run after any VM restart/replacement
# (systemd units live in /etc, which is ephemeral).
set -e
BASE="$HOME/workspace/agency-portfolio"
chmod +x "$BASE/factory/worker.sh"
# opencode PATH fix (binary survives in ~, /usr/local/bin is ephemeral)
[ -x "$HOME/.opencode/bin/opencode" ] && sudo ln -sf "$HOME/.opencode/bin/opencode" /usr/local/bin/opencode || true
# systemd timer (needs sudo; user bus is unavailable in this environment)
sudo tee /etc/systemd/system/mrblues-factory.service > /dev/null << EOF
[Unit]
Description=Mr.Blues Tech autonomous factory worker
[Service]
Type=oneshot
User=hatch
ExecStart=$BASE/factory/worker.sh
EOF
sudo tee /etc/systemd/system/mrblues-factory.timer > /dev/null << EOF
[Unit]
Description=Run Mr.Blues factory every 15 minutes
[Timer]
OnBootSec=2min
OnUnitActiveSec=15min
[Install]
WantedBy=timers.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable mrblues-factory.timer >/dev/null
sudo systemctl start mrblues-factory.timer
echo "Factory installed."
sudo systemctl list-timers --all 2>/dev/null | grep mrblues || true
echo "Queue: $BASE/queue | Output: $HOME/workspace/your_files/agency-portfolio"
echo "Key:   $BASE/factory/.key (Google AI Studio key — create it to start production)"
echo "ntfy:  $(cat $BASE/factory/.ntfy 2>/dev/null)"
