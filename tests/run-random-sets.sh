#!/bin/bash
# Draw random sets with the kit's own generator, run the entry on each, and score each with the kit's scorer.
# Usage: tests/run-random-sets.sh [count]  (default 10)
# Each set is drawn from a random 64-hex seed via the kit's program/generator/draw.ts, exactly as the
# competition draws its sets from a drand round's seed, so these sets have the same distribution as the
# sealed scored set. Results land in tests/sets/<seed>/.
set -u
cd "$(dirname "$0")/.."
KIT="kit/extracted"
COUNT="${1:-10}"
mkdir -p tests/sets
total=0
solved_sets=0
for n in $(seq 1 "$COUNT"); do
  seed=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")
  dir="tests/sets/$seed"
  mkdir -p "$dir/seed-in"
  printf '{"schema":"agent-fun/instance-seed/v1","seed":"%s"}' "$seed" > "$dir/seed-in/seed.json"
  if ! MAKEFUN_INPUT_DIR="$dir/seed-in" MAKEFUN_OUTPUT_DIR="$dir/drawn" node "$KIT/program/generator/draw.ts" > "$dir/draw.log" 2>&1; then
    echo "seed $seed: GENERATOR FAILED (see $dir/draw.log)"
    continue
  fi
  start=$(date +%s%N)
  if ! MAKEFUN_INPUT_DIR="$dir/drawn/input" MAKEFUN_OUTPUT_DIR="$dir/out" MAKEFUN_STATS=1 node main.ts > "$dir/run.log" 2> "$dir/stats.log"; then
    echo "seed $seed: ENTRY FAILED (see $dir/run.log)"
    continue
  fi
  end=$(date +%s%N)
  ms=$(( (end - start) / 1000000 ))
  MAKEFUN_OUTPUT_DIR="$dir/out" MAKEFUN_REFERENCE_DIR="$dir/drawn/reference" MAKEFUN_SCORES_DIR="$dir/scores" node "$KIT/program/scorer/score.ts" > /dev/null 2>&1
  score=$(node -e "console.log(JSON.parse(require('node:fs').readFileSync('$dir/scores/scores.json','utf8')).score)")
  per=$(node -e "const s=JSON.parse(require('node:fs').readFileSync('$dir/scores/scores.json','utf8')); console.log(['i001','i002','i003','i004','i005'].map(k=>s[k]).join(','))")
  total=$((total + score))
  if [ "$score" = "1000000" ]; then solved_sets=$((solved_sets + 1)); fi
  echo "seed ${seed:0:12}…: score $score (per-instance x1000: $per) in ${ms}ms"
  grep -h . "$dir/stats.log" | sed 's/^/    /'
done
echo "---"
echo "sets at perfect 1,000,000: $solved_sets / $COUNT; mean score: $(( total / COUNT ))"
