#!/bin/sh
set -eu

# The volume is the whole app: settings, ledger, crash log and the daily backups
# it writes for itself. Losing it loses the ledger, which is why the docs say to
# keep carrying exports out.
mkdir -p /data /run/wageroute

# x11vnc only ever listens on loopback inside this container; the browser reaches
# it through noVNC. Whoever watches the window types the password below, so an
# unset one is generated rather than left blank.
if [ -z "${WAGEROUTE_VNC_PASSWORD:-}" ]; then
  WAGEROUTE_VNC_PASSWORD=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 12)
  echo "wageroute: no WAGEROUTE_VNC_PASSWORD was given, so this session's password is ${WAGEROUTE_VNC_PASSWORD}"
fi
x11vnc -storepasswd "${WAGEROUTE_VNC_PASSWORD}" /run/wageroute/vnc.pass >/dev/null

echo "wageroute: the desktop window is on http://localhost:6080/vnc.html?autoconnect=true"
exec supervisord -n -c /etc/supervisor/supervisord.conf
