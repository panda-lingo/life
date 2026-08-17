#!/usr/bin/env bash
set -euo pipefail

# Start a redroid Android container for Playwright-driven mobile e2e tests.
# Adapted from panda-lingo/speak/scripts/ci-start-redroid.sh — same contract:
#   * redroid container at 127.0.0.1:5555 (loopback only)
#   * Cromite (Chromium) browser installed if no Chrome/Chromium present
#   * REDROID_BROWSER_PACKAGE exported to GITHUB_ENV for the Playwright step

REDROID_CONTAINER="${REDROID_CONTAINER:-lifespeak-redroid}"
REDROID_IMAGE="${REDROID_IMAGE:-redroid/redroid:12.0.0-latest}"
REDROID_ADB_HOST="${REDROID_ADB_HOST:-127.0.0.1}"
REDROID_ADB_PORT="${REDROID_ADB_PORT:-5555}"
REDROID_SERIAL="${REDROID_SERIAL:-${REDROID_ADB_HOST}:${REDROID_ADB_PORT}}"

run_sudo() {
  if command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    "$@"
  fi
}

install_host_tools() {
  local missing=()
  for tool in adb jq curl; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      missing+=("$tool")
    fi
  done
  if [[ "${#missing[@]}" == "0" ]]; then
    return
  fi

  run_sudo apt-get update
  run_sudo apt-get install -y android-tools-adb jq curl
}

redroid_adb_binding_is_loopback_only() {
  local bindings
  bindings="$(
    docker inspect --format '{{json (index .HostConfig.PortBindings "5555/tcp")}}' \
      "$REDROID_CONTAINER" 2>/dev/null || true
  )"
  jq -e --arg port "$REDROID_ADB_PORT" \
    'type == "array" and length == 1 and .[0].HostIp == "127.0.0.1" and .[0].HostPort == $port' \
    <<< "$bindings" >/dev/null 2>&1
}

start_redroid_container() {
  if ! run_sudo modprobe binder_linux devices=binder,hwbinder,vndbinder 2>/dev/null; then
    run_sudo apt-get update || true
    run_sudo apt-get install -y "linux-modules-extra-$(uname -r)" || true
    run_sudo modprobe binder_linux devices=binder,hwbinder,vndbinder 2>/dev/null || true
  fi
  run_sudo modprobe ashmem_linux 2>/dev/null || true

  if docker ps --format '{{.Names}}' | grep -qx "$REDROID_CONTAINER"; then
    if redroid_adb_binding_is_loopback_only; then
      return
    fi
    echo "Recreating redroid container because its ADB port is not loopback-only" >&2
  fi
  if docker ps -a --format '{{.Names}}' | grep -qx "$REDROID_CONTAINER"; then
    docker rm -f "$REDROID_CONTAINER" >/dev/null
  fi

  docker run -d --privileged \
    --name "$REDROID_CONTAINER" \
    --add-host host.docker.internal:host-gateway \
    -p "127.0.0.1:${REDROID_ADB_PORT}:5555" \
    "$REDROID_IMAGE" \
    androidboot.redroid_width=1152 \
    androidboot.redroid_height=2216 \
    androidboot.redroid_dpi=420 >/dev/null
}

wait_for_redroid_boot() {
  adb start-server >/dev/null
  for ((attempt = 1; attempt <= 90; attempt += 1)); do
    adb connect "$REDROID_SERIAL" >/dev/null 2>&1 || true
    if adb -s "$REDROID_SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' | grep -qx "1"; then
      return
    fi
    sleep 2
  done

  adb devices >&2 || true
  docker logs --tail=200 "$REDROID_CONTAINER" >&2 || true
  echo "Timed out waiting for redroid boot completion" >&2
  return 1
}

ensure_root_adb() {
  local root_output=""
  local root_requested=0
  for ((attempt = 1; attempt <= 15; attempt += 1)); do
    adb connect "$REDROID_SERIAL" >/dev/null 2>&1 || true
    if root_output="$(adb -s "$REDROID_SERIAL" root 2>&1)"; then
      if [[ -n "$root_output" ]]; then
        echo "$root_output"
      fi
      root_requested=1
      break
    fi
    echo "Redroid ADB root attempt ${attempt}/15 failed: ${root_output:-no output}" >&2
    sleep 1
  done

  if [[ "$root_requested" != "1" ]]; then
    adb devices >&2 || true
    docker logs --tail=200 "$REDROID_CONTAINER" >&2 || true
    echo "Redroid ADB must support root access for app-private browser profile setup" >&2
    return 1
  fi

  local uid=""
  for ((attempt = 1; attempt <= 30; attempt += 1)); do
    adb connect "$REDROID_SERIAL" >/dev/null 2>&1 || true
    uid="$(adb -s "$REDROID_SERIAL" shell id -u 2>/dev/null | tr -d '\r' || true)"
    if [[ "$uid" == "0" ]]; then
      echo "Redroid ADB shell is running as uid 0"
      return 0
    fi
    sleep 1
  done

  adb devices >&2 || true
  echo "Redroid ADB shell must run as uid 0; observed uid: ${uid:-unavailable}" >&2
  return 1
}

android_package_exists() {
  local package_name="$1"
  adb -s "$REDROID_SERIAL" shell pm path "$package_name" >/dev/null 2>&1
}

list_android_packages() {
  adb -s "$REDROID_SERIAL" shell pm list packages 2>/dev/null | tr -d '\r' | sed 's/^package://' | sort
}

detect_browser_package() {
  # Playwright Android browser control expects a browser package; WebView shell can hang at launch.
  for package_name in com.android.chrome org.chromium.chrome org.cromite.cromite; do
    if android_package_exists "$package_name"; then
      printf "%s" "$package_name"
      return 0
    fi
  done
  return 1
}

cromite_asset_for_device() {
  local abi
  abi="$(adb -s "$REDROID_SERIAL" shell getprop ro.product.cpu.abi | tr -d '\r')"
  case "$abi" in
    x86_64*)
      printf "%s" "x64_ChromePublic.apk"
      ;;
    arm64*)
      printf "%s" "arm64_ChromePublic.apk"
      ;;
    armeabi*|arm*)
      printf "%s" "arm_ChromePublic.apk"
      ;;
    *)
      echo "Unsupported redroid ABI for browser install: $abi" >&2
      return 1
      ;;
  esac
}

install_cromite_browser() {
  local asset
  asset="$(cromite_asset_for_device)"

  local before_packages after_packages
  before_packages="$(mktemp)"
  after_packages="$(mktemp)"
  list_android_packages > "$before_packages"

  local release_json apk_url apk_path
  release_json="$(mktemp)"
  apk_path="$(mktemp --suffix=.apk)"
  curl -fsSL "https://api.github.com/repos/uazo/cromite/releases/latest" -o "$release_json"
  apk_url="$(jq -r --arg asset "$asset" '.assets[] | select(.name == $asset) | .browser_download_url' "$release_json" | head -n 1)"
  if [[ -z "$apk_url" || "$apk_url" == "null" ]]; then
    echo "Could not find Cromite APK asset $asset" >&2
    return 1
  fi

  curl -fL "$apk_url" -o "$apk_path"
  adb -s "$REDROID_SERIAL" install -r "$apk_path" >&2
  list_android_packages > "$after_packages"

  local installed_package
  installed_package="$(comm -13 "$before_packages" "$after_packages" | grep -E '(chrome|chromium|cromite)' | head -n 1 || true)"
  rm -f "$release_json" "$apk_path" "$before_packages" "$after_packages"

  if [[ -z "$installed_package" ]]; then
    echo "Cromite installed, but no Chromium-family package was added" >&2
    return 1
  fi

  printf "%s" "$installed_package"
}

publish_browser_package() {
  local package_name="$1"
  if [[ -n "${GITHUB_ENV:-}" ]]; then
    echo "REDROID_BROWSER_PACKAGE=$package_name" >> "$GITHUB_ENV"
  fi
  echo "Using Android browser package: $package_name"
}

install_host_tools
start_redroid_container
wait_for_redroid_boot
ensure_root_adb

adb -s "$REDROID_SERIAL" shell settings put global window_animation_scale 0 >/dev/null || true
adb -s "$REDROID_SERIAL" shell settings put global transition_animation_scale 0 >/dev/null || true
adb -s "$REDROID_SERIAL" shell settings put global animator_duration_scale 0 >/dev/null || true
adb -s "$REDROID_SERIAL" shell input keyevent 82 >/dev/null || true

if browser_package="$(detect_browser_package)"; then
  publish_browser_package "$browser_package"
  exit 0
fi

if browser_package="$(install_cromite_browser)"; then
  publish_browser_package "$browser_package"
  exit 0
fi

if browser_package="$(detect_browser_package)"; then
  publish_browser_package "$browser_package"
  exit 0
fi

echo "No supported Chromium-family browser package is available on redroid" >&2
exit 1
