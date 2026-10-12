#!/usr/bin/env bash
# Fuehrt EINE Testsstufe gegen eine lokale, wiederhergestellte Datenbankkopie aus (nie Produktion).
# Startet dafuer die lokale Postgres-Instanz und den HERO-Ersatz, danach werden beide wieder gestoppt.
#   PGBIN=… PGDATA=… PGPORT=5434 TESTDB=t FIXTURE=… bash tests/sync/run_on_copy.sh <stufe>
set -uo pipefail
cd "$(dirname "$0")/../.."
: "${PGBIN:?}"; : "${PGDATA:?}"; : "${FIXTURE:?}"; PGPORT="${PGPORT:-5434}"; TESTDB="${TESTDB:-t}"
"$PGBIN/pg_ctl" -D "$PGDATA" -o "-p $PGPORT -c listen_addresses=127.0.0.1 -k $PGDATA" -l "$PGDATA/../log" -w start >/dev/null || exit 9
node tests/sync/mock-hero.mjs "$FIXTURE" 4599 > /tmp/mock-hero.log 2>&1 &
MP=$!
for i in $(seq 1 50); do curl -s -o /dev/null http://127.0.0.1:4599/__stats && break; sleep 0.1; done
DATABASE_URL="postgresql://postgres@127.0.0.1:$PGPORT/$TESTDB" MOCK=http://127.0.0.1:4599 node tests/sync/scenarios.mjs "$1"
rc=$?
kill $MP 2>/dev/null
"$PGBIN/pg_ctl" -D "$PGDATA" -m fast -w stop >/dev/null
exit $rc
