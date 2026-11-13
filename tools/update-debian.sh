#!/usr/bin/env bash
set -Eeuo pipefail

root="${OVERHAUL_DIR:-$HOME/project-overhaul}"
repo=https://github.com/slavadech91/resources-project-tank
check_only=false
if [[ "${1:-}" == --check ]]; then
  check_only=true
  shift
fi
tag="${1:-}"
[[ $# -le 1 && ( -z "$tag" || "$tag" =~ ^debian-[0-9a-f]{40}$ ) ]] || {
  echo "Usage: $0 [--check] [debian-<commit-sha>]" >&2
  exit 2
}
if [[ -z "$tag" ]]; then
  latest=$(curl -fsSL --retry 2 --max-time 20 -o /dev/null -w '%{url_effective}' "$repo/releases/latest")
  tag=${latest##*/}
  [[ "$tag" =~ ^debian-[0-9a-f]{40}$ ]] || {
    echo 'No Debian update has been published yet.' >&2
    exit 1
  }
fi

cd "$root"
exec 9>.overhaul-update.lock
flock -n 9 || { echo 'An update is already running.' >&2; exit 1; }
if ! "$check_only" && [[ -f .overhaul-revision && $(<.overhaul-revision) == "${tag#debian-}" ]]; then
  echo "Already installed: $tag"
  exit 0
fi

units=(tanki-overhaul-server2.service tanki-overhaul-web.service)
paths=(html5/dist html5/server server2/dist server2/data)
for path in "${paths[@]}"; do
  [[ -d "$path" && ! -L "$path" ]] || { echo "Missing installation directory: $path" >&2; exit 1; }
done
for unit in "${units[@]}"; do
  sudo -n systemctl is-active --quiet "$unit"
done
stage=$(mktemp -d "$PWD/.overhaul-update.XXXXXXXX")
previous="$stage/previous"
swapped=()
services_touched=false

check_services() {
  local attempt url asset
  for attempt in {1..30}; do
    if systemctl is-active --quiet "${units[0]}" &&
       systemctl is-active --quiet "${units[1]}" &&
       curl -fsS --max-time 2 http://127.0.0.1:5291/health >/dev/null &&
       curl -fsS --max-time 2 http://127.0.0.1:5190/ -o "$stage/served-index.html" &&
       cmp -s "$stage/served-index.html" html5/dist/index.html; then
      asset=$(sed -nE 's@.*src="\./(assets/[^"]+\.js)".*@\1@p' "$stage/served-index.html")
      url="http://127.0.0.1:5190/$asset"
      if [[ -n "$asset" ]] && curl -fsSI --max-time 2 "$url" >/dev/null; then
        return 0
      fi
    fi
    sleep 1
  done
  return 1
}

finish() {
  local status=$? path failed=false
  trap - EXIT
  set +e
  if ((status != 0)) && "$services_touched"; then
    echo 'Update failed. Restoring the previous build.' >&2
    sudo -n systemctl stop "${units[@]}" || failed=true
    for path in "${swapped[@]}"; do
      if [[ -d "$previous/$path" ]]; then
        if [[ -e "$path" ]]; then
          mv -T -- "$path" "$stage/rejected/${path//\//_}" || { failed=true; continue; }
        fi
        mv -T -- "$previous/$path" "$path" || failed=true
      fi
    done
    sudo -n systemctl start "${units[@]}" || failed=true
    check_services || failed=true
    if [[ -d "$stage/older" && ! -e .overhaul-previous ]]; then
      mv -T -- "$stage/older" .overhaul-previous || failed=true
    fi
    if "$failed"; then
      echo "Automatic rollback needs attention. Recovery files: $stage" >&2
      exit "$status"
    fi
  fi
  rm -rf -- "$stage"
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$stage/new" "$stage/previous/"{html5,server2} "$stage/rejected"
download="$repo/releases/download/$tag"
for file in overhaul-debian.tar.gz.sha256 overhaul-debian.tar.gz; do
  curl -fsSL --retry 2 --max-time 180 "$download/$file" -o "$stage/$file"
done
(
  cd "$stage"
  expected=$(awk '$2 == "overhaul-debian.tar.gz" { print $1 }' overhaul-debian.tar.gz.sha256)
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]]
  printf '%s  overhaul-debian.tar.gz\n' "$expected" | sha256sum --check --status
  tar -xzf overhaul-debian.tar.gz --no-same-owner -C new
)
new="$stage/new"
[[ $(<"$new/REVISION") == "${tag#debian-}" ]]
[[ -s "$new/html5/dist/index.html" && -d "$new/html5/dist/assets" ]]
[[ -s "$new/server2/data/bot-navigation.json" ]]
node --check "$new/server2/dist/server2.mjs"
node --check "$new/html5/server/public-server.mjs"

# Carry over the installation's game resources using hard links to save space.
for path in html5/dist/*; do
  case "${path##*/}" in index.html|assets) continue ;; esac
  [[ ! -e "$new/$path" ]]
  cp -al -- "$path" "$new/html5/dist/"
done

if "$check_only"; then
  echo "Ready to install: $tag"
  exit 0
fi

services_touched=true
sudo -n systemctl stop "${units[@]}"
for path in "${paths[@]}"; do
  swapped+=("$path")
  mv -T -- "$path" "$stage/previous/$path"
  mv -T -- "$new/$path" "$path"
done
sudo -n systemctl start "${units[@]}"
check_services

# Keep one complete rollback copy. The first update may reclaim old Vite chunks
# on the second successful update, when this original backup is replaced.
if [[ -d .overhaul-previous ]]; then
  mv -T -- .overhaul-previous "$stage/older"
fi
mv -T -- "$stage/previous" .overhaul-previous
previous=.overhaul-previous
printf '%s\n' "${tag#debian-}" > "$stage/revision"
mv -T -- "$stage/revision" .overhaul-revision
services_touched=false
echo "Installed: $tag"
