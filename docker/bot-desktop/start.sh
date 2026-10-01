#!/bin/bash
set -euo pipefail
umask 077
if [[ ! -r /run/secrets/desktop-password ]]; then
  echo 'Desktop password must be supplied through a read-only secret file.' >&2
  exit 1
fi
mkdir -p "$HOME/.vnc" "$HOME/Desktop" "$HOME/Downloads" "$HOME/workspace" "$HOME/chrome-profile"
# Desktop icons live in the per-bot volume, so a bot created before these existed
# would never get them from the image. Written on every start, never overwriting a
# file the bot or the person has since changed.
for launcher in "Chrome:Web Browser:/usr/local/bin/openhours-chrome:google-chrome" \
                "Files:File Manager:thunar /home/bot:system-file-manager" \
                "Terminal:Terminal:xfce4-terminal:utilities-terminal" \
                "Downloads:Downloads folder:thunar /home/bot/Downloads:folder-download"; do
  IFS=':' read -r name comment exec_line icon <<< "$launcher"
  file="$HOME/Desktop/$name.desktop"
  [[ -e "$file" ]] && continue
  printf '[Desktop Entry]\nVersion=1.0\nType=Application\nName=%s\nComment=%s\nExec=%s\nIcon=%s\nTerminal=false\nCategories=Utility;\n' \
    "$name" "$comment" "$exec_line" "$icon" > "$file"
  chmod 0755 "$file"
done
vncpasswd -f < /run/secrets/desktop-password > "$HOME/.vnc/passwd"
export XDG_RUNTIME_DIR=/tmp/openhours-runtime
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
cleanup() {
  trap - EXIT TERM INT
  # Keep X11 and the desktop alive until Chrome has flushed its profile and
  # released SingletonLock. Killing the display first can strand that lock.
  if [[ -n "${gateway_pid:-}" ]]; then
    kill -TERM "$gateway_pid" 2>/dev/null || true
    wait "$gateway_pid" 2>/dev/null || true
  fi
  [[ -z "${chrome_pid:-}" ]] || kill -TERM "$chrome_pid" 2>/dev/null || true
  [[ -z "${desktop_pid:-}" ]] || kill -TERM "$desktop_pid" 2>/dev/null || true
  [[ -z "${vnc_pid:-}" ]] || kill -TERM "$vnc_pid" 2>/dev/null || true
  [[ -z "${web_pid:-}" ]] || kill -TERM "$web_pid" 2>/dev/null || true
  [[ -z "${egress_pid:-}" ]] || kill -TERM "$egress_pid" 2>/dev/null || true
  wait || true
}
trap cleanup EXIT TERM INT
# A container starts with a fresh process table, so nothing can own display :1 yet. A lock
# or socket left by an unclean stop (Docker or WSL killed mid-run) survives `docker start`
# in /tmp, and Xtigervnc then refuses the display: the desktop exited within a second.
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
# VNC is internal only; only the password-protected web viewer is published.
Xtigervnc :1 -localhost yes -SecurityTypes VncAuth -PasswordFile "$HOME/.vnc/passwd" -geometry 1440x900 -depth 24 -rfbport 5901 -nolisten tcp &
vnc_pid=$!
for attempt in {1..100}; do
  xdpyinfo >/dev/null 2>&1 && break
  kill -0 "$vnc_pid"
  sleep .1
done
xdpyinfo >/dev/null
# A container has no sound card, so audio goes to a null sink whose monitor can be
# recorded. Without this Chrome finds no output device, media that needs one refuses to
# play, and a recording would be silent with nothing to say why.
pulseaudio --start --exit-idle-time=-1 --log-target=stderr >/dev/null 2>&1 || true
for attempt in {1..50}; do pactl info >/dev/null 2>&1 && break; sleep .1; done
if pactl info >/dev/null 2>&1; then
  pactl load-module module-null-sink sink_name=openhours sink_properties=device.description=OpenHours >/dev/null 2>&1 || true
  pactl set-default-sink openhours >/dev/null 2>&1 || true
else
  echo 'Sound is unavailable in this desktop; recordings will have no audio track.' >&2
fi
dbus-run-session -- startxfce4 &
desktop_pid=$!
# Use ordinary installed Chrome, with its sandbox enabled and a bot-only
# persistent profile. No --no-sandbox, automation hiding, or test binary.
# The daemon supplies its existing public-internet-only proxy implementation.
node /run/secrets/egress.mjs &
egress_pid=$!
# The authenticated gateway owns Chrome so human sign-in can run with no
# remote-debugging port or automation client, preserving the same bot profile.
websockify --web=/usr/share/novnc/ 127.0.0.1:6080 localhost:5901 &
web_pid=$!
node /opt/openhours/gateway.mjs &
gateway_pid=$!
set +e
wait -n -p stopped_pid "$desktop_pid" "$vnc_pid" "$web_pid" "$gateway_pid" "$egress_pid"
result=$?
echo "Desktop child ${stopped_pid:-unknown} exited with status $result (desktop=$desktop_pid vnc=$vnc_pid viewer=$web_pid)." >&2
exit "$result"
