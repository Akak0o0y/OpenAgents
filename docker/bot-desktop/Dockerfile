# A bot-owned Linux desktop. No Playwright browser binaries or host profile.
FROM node:22-bookworm-slim AS node
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
# xfce4 supplies the session, panel and Thunar. The rest is what makes it a
# usable computer rather than a Chrome kiosk: something to open an image, a text
# file or an archive with, and the clipboard and window tools the bot drives.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg dbus-x11 xfce4 xfce4-terminal \
    tigervnc-standalone-server tigervnc-tools novnc websockify \
    fonts-liberation xauth x11-utils procps xdotool scrot \
    fonts-noto-core fonts-noto-color-emoji fonts-noto-cjk tzdata \
    xdg-utils xdg-user-dirs gvfs xfce4-notifyd xfce4-screenshooter \
    ristretto mousepad xarchiver \
    xclip wmctrl \
    nano less unzip zip file \
    python3-pip python3-venv \
    ffmpeg \
    pulseaudio pulseaudio-utils \
    x11-xserver-utils \
    && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main' > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
    && google-chrome-stable --version > /etc/openhours-chrome-version \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 1000 --shell /bin/bash bot \
    && mkdir -p /home/bot/Downloads /home/bot/Desktop /home/bot/workspace /home/bot/.vnc \
    && chown -R bot:bot /home/bot
COPY start.sh /usr/local/bin/openhours-desktop
COPY openhours-chrome /usr/local/bin/openhours-chrome
COPY mimeapps.list /etc/xdg/mimeapps.list
COPY --from=node /usr/local/bin/node /usr/local/bin/node
# npm comes with node so the bot can install what a task needs. Its own package tree is
# copied rather than apt's, which would pull a second Node runtime.
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
COPY gateway.mjs /opt/openhours/gateway.mjs
COPY computer.mjs /opt/openhours/computer.mjs
COPY observe.mjs /opt/openhours/observe.mjs
COPY exec.mjs /opt/openhours/exec.mjs
COPY files.mjs /opt/openhours/files.mjs
COPY recorder.mjs /opt/openhours/recorder.mjs
COPY jobs.mjs /opt/openhours/jobs.mjs
COPY display.mjs /opt/openhours/display.mjs
# /usr/local/bin precedes /usr/bin, so the menu, xdg-open and any shell all
# reach the wrapper; only the wrapper calls the real binary in /usr/bin. A bare
# google-chrome-stable would otherwise open a second profile with no proxy.
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && npm --version > /etc/openhours-npm-version \
    && python3 -m pip --version > /etc/openhours-pip-version
# Also tolerate older source archives checked out with Windows line endings.
RUN sed -i 's/\r$//' /usr/local/bin/openhours-desktop /usr/local/bin/openhours-chrome /etc/xdg/mimeapps.list \
    && chmod 0755 /usr/local/bin/openhours-desktop /usr/local/bin/openhours-chrome \
    && ln -sf /usr/local/bin/openhours-chrome /usr/local/bin/google-chrome-stable \
    && ln -sf /usr/local/bin/openhours-chrome /usr/local/bin/google-chrome \
    && sed -i 's|/usr/bin/google-chrome-stable|/usr/local/bin/openhours-chrome|g' \
         /usr/share/applications/google-chrome.desktop /usr/share/applications/com.google.Chrome.desktop \
    && update-desktop-database /usr/share/applications
# An association pointing at an absent .desktop file fails silently at runtime,
# which is exactly how the stock Nautilus mapping hid itself. Fail the build.
RUN set -eu; missing=''; \
    while IFS='=' read -r mime app; do \
      [ -n "$app" ] || continue; \
      case "$mime" in \#*) continue;; esac; \
      [ -f "/usr/share/applications/$app" ] || missing="$missing $app"; \
    done < /etc/xdg/mimeapps.list; \
    if [ -n "$missing" ]; then echo "mimeapps.list references missing .desktop files:$missing" >&2; exit 1; fi; \
    echo 'every mime default resolves to an installed application'
USER bot
# Without a UTF-8 locale xdotool refuses every multi-byte character: typing Arabic, or any
# non-Latin text, failed with "Invalid multi-byte sequence encountered". It is set for the
# whole image so the keyboard, the shell, Chrome and the desktop all agree.
ENV HOME=/home/bot DISPLAY=:1 LANG=C.UTF-8 LC_ALL=C.UTF-8
WORKDIR /home/bot
# The runtime mounts a unique Docker volume here for each profile + bot.
VOLUME ["/home/bot"]
EXPOSE 6080
ENTRYPOINT ["/usr/local/bin/openhours-desktop"]
