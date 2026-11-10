export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
for fleet_path_dir in "$HOME/.bun/bin" "$HOME/.local/bin"; do
  case ":$PATH:" in
    *":$fleet_path_dir:"*) ;;
    *) PATH="$fleet_path_dir:$PATH" ;;
  esac
done
unset fleet_path_dir
export PATH
