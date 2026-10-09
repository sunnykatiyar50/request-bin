#!/usr/bin/env sh
# Smoke test for a built image: starts it, waits for the health check, creates a bin, sends a
# request into it and reads it back through the API. Used by .github/workflows/docker.yml.
#
#   .github/smoke-test.sh <image> [host port]
set -eu

IMAGE="$1"
PORT="${2:-30002}"
TOKEN="smoke-admin-token-0123456789"
BASE="http://127.0.0.1:$PORT"

CID=$(docker run -d --label rb-smoke-test=1 -p "127.0.0.1:$PORT:30002" \
    -e ADMIN_PASSWORD=smoke-test-password \
    -e SESSION_SECRET=smoke-test-session-secret-0123456789abcdef \
    -e ADMIN_TOKEN="$TOKEN" \
    "$IMAGE")

cleanup() {
    status=$?
    if [ "$status" -ne 0 ]; then
        echo "--- container logs ---"
        docker logs "$CID" || true
    fi
    docker rm -f "$CID" > /dev/null
    exit "$status"
}
trap cleanup EXIT

echo "Waiting for $IMAGE to report healthy..."
i=0
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$CID")" = "healthy" ]; do
    i=$((i + 1))
    if [ "$i" -gt 30 ] || [ "$(docker inspect -f '{{.State.Running}}' "$CID")" != "true" ]; then
        echo "The container did not become healthy"
        exit 1
    fi
    sleep 2
done

BIN=$(curl -fsS -X POST "$BASE/api/bins" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d '{"name":"smoke","responseTemplate":true,"responseBody":"{\"got\":\"{{body.ping}}\"}"}' \
    | sed -n 's/.*"id":"\([0-9a-f]\{16\}\)".*/\1/p')
[ -n "$BIN" ] || { echo "Could not create a bin"; exit 1; }

REPLY=$(curl -fsS -X POST "$BASE/b/$BIN/hook" -H "Content-Type: application/json" -d '{"ping":"pong"}')
[ "$REPLY" = '{"got":"pong"}' ] || { echo "Unexpected bin response: $REPLY"; exit 1; }

curl -fsS "$BASE/api/requests/latest?bin=$BIN" -H "Authorization: Bearer $TOKEN" | grep -q '"path":"/hook"' \
    || { echo "The captured request was not stored"; exit 1; }

echo "Smoke test passed"
