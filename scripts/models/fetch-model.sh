#!/usr/bin/env bash
# Downloads a pinned model artefact listed in scripts/models/models.lock.json and verifies its
# SHA-256. Weights are never committed to the repository.
#
#   scripts/models/fetch-model.sh [model-key|all] [--dest DIR]
#
# model-key defaults to the lock file's "default" entry (yolox-tiny). DEST defaults to
# $VIGILONE_MODELS_DIR, else <repo>/.cache/models. An existing file with the right hash is kept; a
# file with the wrong hash is reported, deleted and downloaded again. A download whose hash does not
# match the lock file is discarded and the script fails.
# Exit codes: 0 ok, 1 usage/config error, 2 download failed, 3 SHA-256 mismatch.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOCK="$REPO_ROOT/scripts/models/models.lock.json"
DEST="${VIGILONE_MODELS_DIR:-$REPO_ROOT/.cache/models}"
KEY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dest) DEST="$2"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) KEY="$1"; shift ;;
  esac
done

command -v node >/dev/null || { echo "fetch-model: node is required to read $LOCK" >&2; exit 1; }
command -v curl >/dev/null || { echo "fetch-model: curl is required" >&2; exit 1; }
command -v sha256sum >/dev/null || { echo "fetch-model: sha256sum is required" >&2; exit 1; }

# Prints "key url sha256 filename" lines for the requested key(s).
ENTRIES="$(node -e '
  const lock = require(process.argv[1]);
  const want = process.argv[2] || lock.default;
  const list = want === "all" ? lock.models : lock.models.filter((m) => m.key === want);
  if (list.length === 0) { console.error("fetch-model: unknown model key: " + want); process.exit(1); }
  for (const m of list) console.log([m.key, m.url, m.sha256, m.url.split("/").pop()].join(" "));
' "$LOCK" "$KEY")"

mkdir -p "$DEST"

while read -r key url sha file; do
  target="$DEST/$file"
  if [[ -f "$target" ]]; then
    have="$(sha256sum "$target" | cut -d' ' -f1)"
    if [[ "$have" == "$sha" ]]; then
      echo "fetch-model: $key already present and verified ($target)"
      continue
    fi
    echo "fetch-model: $key at $target has SHA-256 $have, expected $sha; deleting it" >&2
    rm -f "$target"
  fi

  tmp="$(mktemp "$DEST/.${file}.XXXXXX")"
  trap 'rm -f "$tmp"' EXIT
  echo "fetch-model: downloading $key from $url"
  if ! curl -fsSL --retry 3 --retry-delay 2 -o "$tmp" "$url"; then
    echo "fetch-model: download failed for $key ($url)" >&2
    exit 2
  fi
  have="$(sha256sum "$tmp" | cut -d' ' -f1)"
  if [[ "$have" != "$sha" ]]; then
    echo "fetch-model: SHA-256 MISMATCH for $key: got $have, expected $sha. Refusing the artefact." >&2
    exit 3
  fi
  chmod 0644 "$tmp"
  mv "$tmp" "$target"
  trap - EXIT
  echo "fetch-model: $key verified ($sha) -> $target"
done <<< "$ENTRIES"
