#!/bin/sh
# The container's entry point: refreshes the DSH profile from the image on every start, then runs the command.
#
# DSH keeps its profile (generated configuration and the plugin link) next to its sessions in $DSH_HOME, which is a volume so the
# sessions survive restarts. A volume is seeded from the image only when it is empty, so without this a new image would keep
# starting the old profile. The profile holds no state: it is replaced from the image's copy each time, and the operator's own
# profile file, mounted at $WORKBENCH_PROFILE (default /etc/workflow-agent/profile.cordis.patch.yml), is laid over it when present.
set -eu
profile_name=workflow-agent
pristine=/opt/workflow-agent/dsh-profile
target="$DSH_HOME/profiles/$profile_name"
operator="${WORKBENCH_PROFILE:-/etc/workflow-agent/profile.cordis.patch.yml}"

if [ -d "$pristine" ]; then
  mkdir -p "$DSH_HOME/profiles"
  rm -rf "$target"
  cp -a "$pristine" "$target"
  if [ -f "$operator" ]; then cp "$operator" "$target/cordis.patch.yml"; fi
fi
exec "$@"
