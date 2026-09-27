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

# Prints "kind key url sha256 filename archiveSha member" lines for the requested key(s): the
# model file (kind=model) and any extra files it needs (kind=extra, e.g. an OCR config).
# Keys are looked up in "models" and in "candidateModels" (fetchable for tests and evaluation;
# the product refuses to run a candidate unless model-license-exceptions.json approves it).
ENTRIES="$(node -e '
  const lock = require(process.argv[1]);
  const want = process.argv[2] || lock.default;
  const all = [...lock.models, ...(lock.candidateModels || [])];
  const list = want === "all" ? all : all.filter((m) => m.key === want);
  if (list.length === 0) { console.error("fetch-model: unknown model key: " + want); process.exit(1); }
  for (const m of list) {
    const a = m.archive;
    const file = a ? a.fileName : m.url.split("/").pop();
    console.log(["model", m.key, m.url, m.sha256, file, a ? a.sha256 : "-", a ? a.member : "-"].join(" "));
    for (const x of m.extraFiles || []) console.log(["extra", m.key, x.url, x.sha256, x.fileName, "-", "-"].join(" "));
  }
' "$LOCK" "$KEY")"

mkdir -p "$DEST"

extract_member() { # zip member -> stdout
  if command -v unzip >/dev/null; then unzip -p "$1" "$2"; else python3 -c 'import sys,zipfile; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))' "$1" "$2"; fi
}

while read -r kind key url sha file archsha member; do
  target="$DEST/$file"
  if [[ -f "$target" ]]; then
    have="$(sha256sum "$target" | cut -d' ' -f1)"
    if [[ "$have" == "$sha" ]]; then
      echo "fetch-model: $key ($file) already present and verified ($target)"
      continue
    fi
    echo "fetch-model: $key at $target has SHA-256 $have, expected $sha; deleting it" >&2
    rm -f "$target"
  fi

  tmp="$(mktemp "$DEST/.${file}.XXXXXX")"
  trap 'rm -f "$tmp" "${tmp}.archive"' EXIT
  echo "fetch-model: downloading $key ($file) from $url"
  dl="$tmp"
  [[ "$archsha" != "-" ]] && dl="${tmp}.archive"
  if ! curl -fsSL --retry 3 --retry-delay 2 -o "$dl" "$url"; then
    echo "fetch-model: download failed for $key ($url)" >&2
    exit 2
  fi
  if [[ "$archsha" != "-" ]]; then
    have="$(sha256sum "$dl" | cut -d' ' -f1)"
    if [[ "$have" != "$archsha" ]]; then
      echo "fetch-model: SHA-256 MISMATCH for the $key archive: got $have, expected $archsha. Refusing it." >&2
      exit 3
    fi
    if ! extract_member "$dl" "$member" > "$tmp"; then
      echo "fetch-model: $member not found in the $key archive" >&2
      exit 2
    fi
    rm -f "$dl"
  fi
  have="$(sha256sum "$tmp" | cut -d' ' -f1)"
  if [[ "$have" != "$sha" ]]; then
    echo "fetch-model: SHA-256 MISMATCH for $key ($file): got $have, expected $sha. Refusing the artefact." >&2
    exit 3
  fi
  chmod 0644 "$tmp"
  mv "$tmp" "$target"
  trap - EXIT
  echo "fetch-model: $key ($file) verified ($sha) -> $target"
done <<< "$ENTRIES"
