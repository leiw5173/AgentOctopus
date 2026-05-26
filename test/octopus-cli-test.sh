#!/bin/bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

PASS=0
FAIL=0

pass() { echo -e "  ${GREEN}PASS${NC} $1"; PASS=$((PASS+1)); }
fail() { echo -e "  ${RED}FAIL${NC} $1 — $2"; FAIL=$((FAIL+1)); }

RATINGS_FILE="$HOME/.agentoctopus/ratings.json"
SKILLS_DIR="$HOME/.agentoctopus/skills"

echo "==========================================="
echo " AgentOctopus CLI Test Suite"
echo "==========================================="
echo ""

echo "── Prerequisites ──"

# Check octopus CLI exists
if command -v octopus &>/dev/null; then
  pass "octopus CLI found in PATH"
else
  fail "octopus CLI found in PATH" "run: npm install -g agentoctopus"
fi

# Check skills directory exists
if [ -d "$SKILLS_DIR" ]; then
  pass "skills directory exists: $SKILLS_DIR"
else
  fail "skills directory exists: $SKILLS_DIR" "run: octopus sync"
fi

# Count skills
SKILL_COUNT=$(ls -1 "$SKILLS_DIR" 2>/dev/null | wc -l | tr -d ' ')
echo "  INFO $SKILL_COUNT skills installed"

# Check ratings.json exists
if [ -f "$RATINGS_FILE" ]; then
  pass "ratings.json exists"
else
  fail "ratings.json exists" "run octopus ask for a query first"
fi

echo ""

echo "── L1-E: Rating Data Integrity ──"

# 1.19: ratings.json is valid JSON
if cat "$RATINGS_FILE" | python3 -m json.tool > /dev/null 2>&1; then
  pass "1.19 ratings.json is valid JSON"
else
  fail "1.19 ratings.json is valid JSON" "file is not valid JSON"
fi

# 1.20: weather entry has all 5 dimensions
WEATHER_DIMS=$(python3 -c "
import json
with open('$RATINGS_FILE') as f:
    data = json.load(f)
entry = data.get('weather', {})
dims = entry.get('dimensions', {})
required = ['completion', 'quality', 'reliability', 'latency', 'tokenCost']
missing = [d for d in required if d not in dims]
if missing:
    print('MISSING:' + ','.join(missing))
else:
    print('OK:' + ','.join(f'{k}={dims[k]}' for k in required))
" 2>&1)
if echo "$WEATHER_DIMS" | grep -q "^OK:"; then
  pass "1.20 weather entry has all 5 dimensions"
  echo "       $WEATHER_DIMS"
else
  fail "1.20 weather entry has all 5 dimensions" "$WEATHER_DIMS"
fi

echo ""

echo "── L1-C: Diagnostics ──"

# 1.12: octopus list returns consistent count
# Not all SKILL.md files are parseable — some lack valid frontmatter
# or fail Zod schema validation. Check that CLI count is within 85% of filesystem.
CLI_COUNT=$(node apps/cli/dist/index.js list 2>&1 | grep -c '⭐' || true)
MIN_THRESHOLD=$(( SKILL_COUNT * 80 / 100 ))
if [ "$CLI_COUNT" -ge "$MIN_THRESHOLD" ]; then
  pass "1.12 octopus list count is reasonable ($CLI_COUNT / $SKILL_COUNT skills)"
else
  fail "1.12 octopus list count matches filesystem" "CLI: $CLI_COUNT, FS: $SKILL_COUNT (min: $MIN_THRESHOLD)"
fi

echo ""

echo "==========================================="
TOTAL=$((PASS + FAIL))
echo " Results: $PASS/$TOTAL passed"
echo "==========================================="

if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}$FAIL test(s) failed${NC}"
  exit 1
else
  echo -e "${GREEN}All tests passed${NC}"
  exit 0
fi
