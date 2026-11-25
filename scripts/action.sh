#!/usr/bin/env bash
# Body of the modelshift GitHub Action (action.yml). Kept as a script so it can be tested locally:
#   MS_VERSION=source GITHUB_ACTION_PATH=. MS_PATH=test/fixtures/sample-repo bash scripts/action.sh
set -uo pipefail

: "${MS_COMMAND:=scan}" "${MS_PATH:=.}" "${MS_LIVE:=false}" "${MS_PROBE:=false}" "${MS_PROVIDERS:=}"
: "${MS_FAIL_ON:=retiring}" "${MS_FROM:=}" "${MS_TO:=}" "${MS_SAMPLES:=modelshift-samples.jsonl}" "${MS_REPEATS:=3}"
: "${MS_JUDGE:=}" "${MS_FAIL:=true}" "${MS_COMMENT:=false}" "${MS_VERSION:=latest}" "${MS_PR:=}"
: "${GITHUB_ACTION_PATH:=$(cd "$(dirname "$0")/.." && pwd)}"
: "${GITHUB_OUTPUT:=/dev/null}" "${GITHUB_STEP_SUMMARY:=/dev/null}"

if [ "$MS_VERSION" = "source" ]; then
  (cd "$GITHUB_ACTION_PATH" && { [ -d node_modules ] || npm ci --no-audit --no-fund >/dev/null; } && npm run build >/dev/null) || { echo "::error::could not build modelshift from source"; exit 1; }
  MS=(node "$GITHUB_ACTION_PATH/dist/src/bin.js")
else
  MS=(npx --yes "modelshift@$MS_VERSION")
fi

OUT_DIR="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/modelshift"
mkdir -p "$OUT_DIR"
MD="$OUT_DIR/summary.md"
ERR="$(dirname "$OUT_DIR")/modelshift-stderr.log"
status=ok
code=0

case "$MS_COMMAND" in
  scan)
    args=(scan "$MS_PATH" --markdown --fail-on "$MS_FAIL_ON")
    [ "$MS_LIVE" = "true" ] && args+=(--live)
    [ "$MS_PROBE" = "true" ] && args+=(--probe)
    [ -n "$MS_PROVIDERS" ] && args+=(--providers "$MS_PROVIDERS")
    "${MS[@]}" "${args[@]}" > "$MD" 2> "$ERR"
    code=$?
    cat "$ERR" >&2
    [ "$code" = "1" ] && status=flagged
    ;;
  run)
    if [ -z "$MS_FROM" ] || [ -z "$MS_TO" ]; then echo "::error::run needs 'from' and 'to'"; exit 1; fi
    REPORT="$OUT_DIR/modelshift-report.html"
    RESULTS="$OUT_DIR/modelshift-results.json"
    # --yes: the workflow author configured this run explicitly; the call count is printed in the log.
    args=(run --from "$MS_FROM" --to "$MS_TO" --samples "$MS_SAMPLES" --repeats "$MS_REPEATS" --markdown --html "$REPORT" -o "$RESULTS" --yes --fail-on-unsafe)
    [ -n "$MS_JUDGE" ] && args+=(--judge "$MS_JUDGE")
    "${MS[@]}" "${args[@]}" > "$MD" 2> "$ERR"
    code=$?
    cat "$ERR" >&2
    [ "$code" = "1" ] && status=flagged
    echo "report=$REPORT" >> "$GITHUB_OUTPUT"
    ;;
  *)
    echo "::error::unknown command '$MS_COMMAND' (use scan or run)"; exit 1 ;;
esac

# A crash (no summary written) is an error regardless of the 'fail' input.
if [ ! -s "$MD" ]; then
  why=$(grep -v '^\s*$' "$ERR" 2>/dev/null | grep -vi 'warning' | tail -n 3)
  echo "::error::modelshift produced no output (exit $code)${why:+: ${why//$'\n'/ }}"
  { echo "### modelshift could not run"; echo; echo '```'; echo "${why:-exit code $code, no error message}"; echo '```'; } >> "$GITHUB_STEP_SUMMARY"
  echo "exit=${code/#0/1}" >> "$GITHUB_OUTPUT"
  exit 0
fi

cat "$MD"
cat "$MD" >> "$GITHUB_STEP_SUMMARY"
{ echo "status=$status"; echo "markdown=$MD"; } >> "$GITHUB_OUTPUT"

if [ "$MS_COMMENT" = "true" ] && [ -n "$MS_PR" ]; then
  gh pr comment "$MS_PR" --edit-last --create-if-none --body-file "$MD" || echo "::warning::could not comment on PR #$MS_PR (needs pull-requests: write)"
fi

if [ "$status" = "flagged" ] && [ "$MS_FAIL" = "true" ]; then
  echo "::error::modelshift flagged this $MS_COMMAND (see the job summary)"
  echo "exit=1" >> "$GITHUB_OUTPUT"
fi
exit 0
