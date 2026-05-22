#!/bin/bash
# Fetch real Claude usage from Anthropic's /api/oauth/usage endpoint.
# On HTTP 429 (rate limited): exit code 42 and emit JSON {"rateLimited": true}.
# On other errors: exit code 1 and emit JSON {"error": "..."}.

CREDS="$HOME/.claude/.credentials.json"
URL="https://api.anthropic.com/api/oauth/usage"

if [ ! -f "$CREDS" ]; then
    echo '{"error":"credentials file missing"}' >&2
    exit 1
fi

TOKEN=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["claudeAiOauth"]["accessToken"])' "$CREDS" 2>/dev/null) || {
    echo '{"error":"failed to read token"}' >&2
    exit 1
}

BODY_FILE=$(mktemp)
trap "rm -f '$BODY_FILE'" EXIT

HTTP_CODE=$(curl -sS --max-time 8 -o "$BODY_FILE" -w "%{http_code}" \
    -H "Authorization: Bearer $TOKEN" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: oauth-2025-04-20" \
    -H "Accept: application/json" \
    "$URL")

case "$HTTP_CODE" in
    200)
        cat "$BODY_FILE"
        exit 0
        ;;
    429)
        echo '{"rateLimited":true,"httpCode":429}'
        exit 42
        ;;
    *)
        # Normalise to a base-10 integer so a connection failure (curl emits
        # "000") doesn't yield invalid JSON — "httpCode":000 has leading zeros,
        # which JSON.parse rejects at column 33.
        HTTP_NUM=$((10#${HTTP_CODE:-0}))
        echo "{\"error\":\"HTTP $HTTP_NUM\",\"httpCode\":$HTTP_NUM,\"body\":$(python3 -c 'import json,sys; print(json.dumps(open(sys.argv[1]).read()[:200]))' "$BODY_FILE" 2>/dev/null || echo '""')}"
        exit 1
        ;;
esac
