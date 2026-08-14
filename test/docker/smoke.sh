#!/usr/bin/env bash
# From-zero smoke test: does the published package install and compose on a
# machine that has never seen this project?
#
# Runs against the npm registry, not the working tree, so it tests what a user
# actually gets. Needs no wallet and no API key: every step here is free.
set -euo pipefail

PLUGIN="${PLUGIN_SPEC:-dsh-clawrouter}"
DSH="${DSH_SPEC:-@deepseek-ai/dsh@0.1.0-rc.6}"
export DSH_HOME=/work/home
mkdir -p /work/home /work/ws
cd /work/ws

echo "== node =="
node --version

echo
echo "== install $PLUGIN into a fresh profile =="
# The install prints `missing peer` for harness packages the runtime supplies.
# Documented behaviour, so it must not fail the run — but the profile has to
# compose afterwards, which is what the next step proves.
npx -y "$DSH" plugin --profile smoke add "$PLUGIN" 2>&1 | tail -25

echo
echo "== compose the profile =="
CONFIG="$(npx -y "$DSH" --profile smoke --dump-config 2>&1)"
echo "$CONFIG" | grep -A4 'blockrun-llm' || true
echo "$CONFIG" | grep -A4 'blockrun-review' || true

echo
echo "== assertions =="
fail=0
check() {
  if echo "$CONFIG" | grep -q "$1"; then
    echo "  ok    $2"
  else
    echo "  FAIL  $2"
    fail=1
  fi
}
check 'id: blockrun-llm'        'the provider route is composed'
check 'name: dsh-clawrouter$'   'it resolves to the published package'
check 'id: blockrun-review'     'the review gate is composed'
check 'enabled: false'          'the gate ships disarmed'
check 'reviewerModel: anthropic/claude-opus-5' 'the default reviewer is set'

# The published tarball must carry built output: a git install runs no build,
# and the profile loads `lib/`, never `src/`.
echo
echo "== published artifact =="
PKG=/work/home/profiles/smoke/node_modules/dsh-clawrouter
for f in lib/index.js lib/review.js cordis.patch.yml README.md; do
  if [ -f "$PKG/$f" ]; then echo "  ok    $f is published"; else echo "  FAIL  $f missing from the package"; fail=1; fi
done

# `src/` in the tarball would mean the published package ships sources the
# runtime never loads, doubling its size for nothing.
if [ -d "$PKG/src" ]; then echo "  FAIL  src/ was published"; fail=1; else echo "  ok    src/ is not published"; fi

# The count npm renders on the package page must match what the READMEs claim;
# it lived in package.json for eleven releases while every README said otherwise.
COUNT_PKG="$(node -p "require('$PKG/package.json').description.match(/plus (\\d+) models/)[1]")"
COUNT_DOC="$(grep -o 'chatVisible -->[0-9]*' "$PKG/README.md" | head -1 | grep -o '[0-9]*')"
if [ "$COUNT_PKG" = "$COUNT_DOC" ]; then
  echo "  ok    npm description and README agree on $COUNT_PKG models"
else
  echo "  FAIL  npm says $COUNT_PKG models, README says $COUNT_DOC"; fail=1
fi

echo
[ "$fail" -eq 0 ] && echo "SMOKE PASS" || { echo "SMOKE FAIL"; exit 1; }
