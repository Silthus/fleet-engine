export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
export AGENT_BROWSER_NO_VERSION_CHECK="${AGENT_BROWSER_NO_VERSION_CHECK:-1}"
for fleet_path_dir in "$HOME/.bun/bin" "$HOME/.local/bin"; do
  case ":$PATH:" in
    *":$fleet_path_dir:"*) ;;
    *) PATH="$fleet_path_dir:$PATH" ;;
  esac
done
unset fleet_path_dir
export PATH
