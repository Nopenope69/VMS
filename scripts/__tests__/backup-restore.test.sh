#!/usr/bin/env bash
# vigilonectl backup create / restore against a REAL PostgreSQL database. Only the container wrapper is a
# stand-in: a fake `docker` on PATH runs `docker compose exec postgres pg_dump|psql ...` against TEST_DB_URL,
# records every other call, and can simulate a failing or truncated dump (FAKE_DUMP=fail|truncate).
#
#   TEST_DB_URL=postgresql://user:pw@localhost:5432/vigilone_backup_test bash scripts/__tests__/backup-restore.test.sh
#
# The database named in TEST_DB_URL is dropped and recreated: never point it at real data.
set -euo pipefail
: "${TEST_DB_URL:?set TEST_DB_URL to a scratch database (it is dropped and recreated)}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CTL="${ROOT}/deploy/packaging/vigilonectl"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
ADMIN_URL="${TEST_DB_URL%/*}/postgres"
DB_NAME="${TEST_DB_URL##*/}"; DB_NAME="${DB_NAME%%\?*}"
FAILED=0; TOTAL=0
ok() { TOTAL=$((TOTAL + 1)); echo "  ✓ $1"; }
bad() { TOTAL=$((TOTAL + 1)); FAILED=$((FAILED + 1)); echo "  ✗ $1"; }
q() { psql "$TEST_DB_URL" -Atq -c "$1"; }

# --- the fake docker -----------------------------------------------------------------------------------------
mkdir -p "$WORK/bin" "$WORK/install" "$WORK/config" "$WORK/data"
cat > "$WORK/bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_LOG"
[[ "$1" == compose ]] || exit 1
shift
case "$1" in
  stop|start) exit 0 ;;
  cp) exit 0 ;;
  exec)
    shift; [[ "$1" == -T ]] && shift
    svc="$1"; shift
    [[ "$svc" == backend ]] && exit 0
    cmd="$1"; shift
    args=(); skip=0
    for a in "$@"; do
      if (( skip )); then skip=0; continue; fi
      case "$a" in -U) skip=1 ;; -d) skip=1 ;; vigilone_db) ;; *) args+=("$a") ;; esac
    done
    if [[ "$cmd" == pg_dump ]]; then
      case "${FAKE_DUMP:-}" in
        fail) echo "pg_dump: error: connection refused" >&2; exit 1 ;;
        truncate) pg_dump "${args[@]}" "$TEST_DB_URL" | head -n 20; exit 0 ;;
      esac
      exec pg_dump "${args[@]}" "$TEST_DB_URL"
    fi
    exec "$cmd" "${args[@]}" -d "$TEST_DB_URL"
    ;;
esac
exit 1
EOF
chmod +x "$WORK/bin/docker"
export PATH="$WORK/bin:$PATH" FAKE_LOG="$WORK/docker.log" TEST_DB_URL
export VIGILONE_INSTALL_DIR="$WORK/install" VIGILONE_CONFIG_DIR="$WORK/config" VIGILONE_DATA_DIR="$WORK/data"
echo "appliance-key-material" > "$WORK/config/appliance.key"
printf 'JWT_SECRET=x\nCREDENTIAL_ENCRYPTION_KEY=key-A\n' > "$WORK/install/.env"

psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"$DB_NAME\"" -c "CREATE DATABASE \"$DB_NAME\""
q "CREATE TABLE cameras (id int primary key, name text); INSERT INTO cameras VALUES (1,'gate'),(2,'lobby'),(3,'dock');"

echo "vigilonectl backup"

# 1. round trip
"$CTL" backup create "$WORK/b1.tar.gz" > "$WORK/out1" 2>&1 && [[ -f "$WORK/b1.tar.gz" ]] && ok "create writes an archive" || { bad "create writes an archive"; cat "$WORK/out1"; }
tar -tzf "$WORK/b1.tar.gz" | grep -q '^./MANIFEST.sha256$' && ok "archive has a SHA-256 manifest" || bad "archive has a SHA-256 manifest"
tar -tzf "$WORK/b1.tar.gz" | grep -q '^./config/appliance.key$' && ok "archive has the appliance configuration" || bad "archive has the appliance configuration"
[[ "$(stat -c %a "$WORK/b1.tar.gz")" == 600 ]] && ok "archive is readable by its owner only" || bad "archive is readable by its owner only"
q "DELETE FROM cameras WHERE id = 1; INSERT INTO cameras VALUES (4,'intruder'); CREATE TABLE junk (x int);"
echo "changed-after-backup" > "$WORK/config/appliance.key"
"$CTL" backup restore "$WORK/b1.tar.gz" > "$WORK/out2" 2>&1 && ok "restore succeeds" || { bad "restore succeeds"; cat "$WORK/out2"; }
[[ "$(q "SELECT string_agg(id||':'||name, ',' ORDER BY id) FROM cameras")" == "1:gate,2:lobby,3:dock" ]] && ok "restore brings back exactly the backed-up rows" || bad "restore brings back exactly the backed-up rows ($(q "SELECT string_agg(id||':'||name, ',' ORDER BY id) FROM cameras"))"
[[ "$(q "SELECT count(*) FROM pg_tables WHERE tablename = 'junk'")" == 0 ]] && ok "tables created after the backup are gone" || bad "tables created after the backup are gone"
[[ "$(cat "$WORK/config/appliance.key")" == appliance-key-material ]] && ok "configuration restored" || bad "configuration restored"
tar -tzf "$WORK/b1.tar.gz" | grep -q '^./install/.env$' && ok "archive has the install secrets (.env)" || bad "archive has the install secrets (.env)"
! grep -q "different CREDENTIAL_ENCRYPTION_KEY" "$WORK/out2" && ok "no key warning when the key is the same" || bad "no key warning when the key is the same"
grep -q "compose stop backend" "$WORK/docker.log" && grep -q "compose start backend" "$WORK/docker.log" && ok "backend stopped during the restore and started after" || bad "backend stopped during the restore and started after"

# 1b. restoring onto a machine with another credential key warns loudly
printf 'JWT_SECRET=x\nCREDENTIAL_ENCRYPTION_KEY=key-B\n' > "$WORK/install/.env"
"$CTL" backup restore "$WORK/b1.tar.gz" > "$WORK/out2b" 2>&1 || true
grep -q "different CREDENTIAL_ENCRYPTION_KEY" "$WORK/out2b" && ok "restoring with another credential key warns that secrets will not decrypt" || bad "restoring with another credential key warns that secrets will not decrypt"
grep -q "CREDENTIAL_ENCRYPTION_KEY=key-B" "$WORK/install/.env" && ok "the machine's own .env is kept" || bad "the machine's own .env is kept"

# 2. a failing dump never produces a backup
if FAKE_DUMP=fail "$CTL" backup create "$WORK/b2.tar.gz" > "$WORK/out3" 2>&1; then bad "failing pg_dump makes create fail"; else ok "failing pg_dump makes create fail"; fi
[[ ! -e "$WORK/b2.tar.gz" && ! -e "$WORK/b2.tar.gz.partial" ]] && ok "no archive left behind after a failed dump" || bad "no archive left behind after a failed dump"
grep -q "NO backup was written" "$WORK/out3" && ok "the failure says no backup was written" || bad "the failure says no backup was written"

# 3. a truncated dump is refused
if FAKE_DUMP=truncate "$CTL" backup create "$WORK/b3.tar.gz" > "$WORK/out4" 2>&1; then bad "truncated dump refused"; else ok "truncated dump refused"; fi
[[ ! -e "$WORK/b3.tar.gz" ]] && ok "no archive for a truncated dump" || bad "no archive for a truncated dump"

# 4. an altered archive is refused before anything changes
mkdir "$WORK/t" && tar -xzf "$WORK/b1.tar.gz" -C "$WORK/t"
sed -i "s/lobby/LOBBY-ALTERED/" "$WORK/t/database.sql"
tar -czf "$WORK/tampered.tar.gz" -C "$WORK/t" .
q "INSERT INTO cameras VALUES (5,'after-restore')"
if "$CTL" backup restore "$WORK/tampered.tar.gz" > "$WORK/out5" 2>&1; then bad "altered archive refused"; else ok "altered archive refused"; fi
grep -q "checksum mismatch" "$WORK/out5" && ok "the refusal names the checksum mismatch" || bad "the refusal names the checksum mismatch"
[[ "$(q "SELECT count(*) FROM cameras WHERE id = 5")" == 1 ]] && ok "database untouched after refusing the altered archive" || bad "database untouched after refusing the altered archive"

# 5. a restore that fails half-way leaves the database as it was (one transaction)
sed -i "s/LOBBY-ALTERED/lobby/" "$WORK/t/database.sql"
printf '\nTHIS IS NOT SQL;\n' >> "$WORK/t/database.sql"
(cd "$WORK/t" && find . -type f ! -name MANIFEST.sha256 -print0 | sort -z | xargs -0 sha256sum > MANIFEST.sha256)
tar -czf "$WORK/badsql.tar.gz" -C "$WORK/t" .
if "$CTL" backup restore "$WORK/badsql.tar.gz" > "$WORK/out6" 2>&1; then bad "restore with a SQL error fails"; else ok "restore with a SQL error fails"; fi
grep -q "rolled back" "$WORK/out6" && ok "the failure says it was rolled back" || bad "the failure says it was rolled back"
[[ "$(q "SELECT count(*) FROM cameras WHERE id = 5")" == 1 && "$(q "SELECT count(*) FROM cameras")" == 4 ]] && ok "database unchanged after the failed restore" || bad "database unchanged after the failed restore"

# 6. an archive without a manifest (older vigilonectl) is refused
rm "$WORK/t/MANIFEST.sha256" && tar -czf "$WORK/nomanifest.tar.gz" -C "$WORK/t" .
if "$CTL" backup restore "$WORK/nomanifest.tar.gz" > "$WORK/out7" 2>&1; then bad "archive without manifest refused"; else ok "archive without manifest refused"; fi

psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"$DB_NAME\""
echo
echo "backup-restore: $((TOTAL - FAILED))/${TOTAL} passed"
[[ "$FAILED" -eq 0 ]]
