# Sokoban solver — BUILD NOTES

Bounty: **Build the best Sokoban solver, 21 November 2026**
- Page: https://make.fun/bounty/sokoban-solver-01-run-20261121
- Prize: **$100 total, 10 places × $10** (1st–10th). Escrow $100 USDC on Solana, funded 2026-11-21 09:10:43 UTC.
- Deadline: **Mon 23 Nov 2026, 10:00 WIB** (2026-11-23T03:00:00Z). Final phase starts 10 min later; the scored set is drawn from drand quicknet round 34200012.
- Reward bar: score **strictly above the house baseline** (make.fun's own `plain-astar 1.0.0`) on the scored set. An entry at or below it keeps its rank but takes no reward.

## Rules (from kit `RULES.txt`, kit downloaded 2026-11-21 ~17:32 WIB)

- Entry: `main.ts` at the repo root, Node 22 (`node /bot/main.ts`, TypeScript types stripped natively, erasable syntax only). No installs, no WebAssembly, no native code.
- Input: `/input/<id>/level.txt` for `i001`…`i005`, XSB (`#` wall, space floor, `.` goal, `$` box, `*` box on goal, `@` player). Output: `/output/<id>/solution.txt` (UTF-8, ≤ 65,536 bytes), creating `/output/<id>/` itself.
- Answer: player moves in LURD (`u d l r`, either case; the replay decides which steps push), whitespace ignored; any other character invalid; empty answer valid.
- Checker replays the moves: a step into a wall, or pushing a box into a wall or another box, is illegal → 0. Solved = every box on a goal.
- Scoring per instance: **1,000 points in P* pushes** (P* = the level's push-optimal count); in more pushes, **500 × P* / pushes**. Unsolved/illegal = 0. Total score = 1,000 × mean points over the 5 instances, rounded half up (max 1,000,000).
- Runtime: **60 s wall for the whole set**, 1 CPU, 512 MB, no network, read-only `/bot` and `/input`. **Two executions must write byte-identical outputs** — budget by work, never by the clock; the program must not read the wall clock.
- Repo ≤ 1 MiB total. A reward needs every scored instance answered in the stated format.
- Levels: a 1-wide hallway across the board, 1–4 rooms off it (up to 2 above, 2 below), each in a 6×6 slot with one door, no two doors in one column. Each room holds 3 or 4 boxes and as many goals; its floor is carved at random, boxes start on goals, 30–80 pulls played backwards, and the room is kept only when the generator's push-optimal search solves it from its door in ≥ 12 pushes (3 boxes) or ≥ 14 (4 boxes). Sets grow: 1 room of 3, 1 room of 4, then 2, 3, 4 rooms of 4. A box pushed through a door into the hallway can never be pushed back, so **every box stays in its room and P* = the sum of the rooms' optima**. No level comes from a published set.
- House baseline: `plain-astar 1.0.0` (in the kit under `baselines/`): plain A* over *moves* with a summed nearest-goal Manhattan estimate, no deadlock knowledge, 200,000 expansions per level, empty solution when it gives up. It minimises moves, not pushes.
- Submission limits: at most 10 submissions per entrant per UTC day, 20 over the whole competition; the most recent submission before the deadline is the final entry.

## Design (written from scratch in `main.ts`, from the kit rules alone)

- **Room decomposition.** Cut the dead squares of the player's row (the hallway: a box there reaches no goal) out of the floor; each remaining connected part holding boxes is a room. This is exactly the structure the generator guarantees, so each room is an independent sub-problem and the player's walk joins them along the hallway.
- **Per-room push-optimal A*.** State = sorted box squares + the player's reachable region (named by its lowest square). One push costs 1. Heuristic = minimum-cost assignment of boxes to goals (Hungarian, O(n³)), with a box's cost to a goal its shortest walking distance ignoring other boxes — admissible and consistent, so the first solved state popped is push-optimal for the room. Rooms' optima add up to P* for the level.
- **Deadlock pruning** (prunes no solvable state): dead squares (no pull path from any goal reaches the square) and frozen 2×2 blocks of walls/boxes with a box off its goal.
- **Determinism:** no clock, no randomness; heap ties break by heuristic then insertion order; walks break ties by direction order u, d, l, r; search budgeted by expansions (300,000 for the optimal search), never by time.
- **Fallbacks (all deterministic):** if the optimal search exhausts its budget for a room, retry with weighted A* (weights 2, 4, 32; 150,000 expansions each) — a slightly suboptimal solution beats none. If a level is not a set of rooms, a push search runs over the whole board. If everything fails, the entry writes an empty solution (valid format, 0 points) for that instance instead of crashing, so one hard level never takes the other four down.
- **Self-check:** every solution is replayed locally (same rules as the checker) before it is written; a replay that is illegal, unsolved, or has a different push count is discarded for an empty solution.
- `MAKEFUN_STATS=1` prints per-instance pushes/expansions to stderr for local testing; it never changes `solution.txt`.

## Verification (all with the kit's own scorer/checker, 2026-11-21 ~17:36–17:40 WIB)

- **Practice set: score 1,000,000 / 1,000,000 (max).** All 5 instances solved in exactly P* pushes: i001 13, i002 16, i003 29, i004 47, i005 60. Whole set in ~0.36 s (limit 60 s). Expansions per instance: 29 / 113 / 29 / 718 / 1,446.
- **Determinism:** two runs on the practice set write byte-identical outputs (`diff -r` clean); also byte-identical on a random drawn set. The kit's `grade-local` L1 regrade reproduced the run byte for byte.
- **Kit `grade-local` (driver process):** score 1,000,000, passed 1, 5,000/5,000 points, size 21,240 bytes, eligible ranked yes / prize yes. (Its `result_sha256` cannot equal the server's: local Node is v24.22.1, the server harness runs v26.13.1; the score is unaffected. `authored 0.000…` is expected here — no transcripts were bundled; see "What remains".)
- **Robustness sweep — 30 fresh sets drawn with the kit's own generator** (`tests/run-random-sets.sh`, random 64-hex seeds, same distribution as the sealed scored set): **30/30 sets at 1,000,000; 150/150 instances solved at P*.** Slowest set 0.41 s; highest single-instance expansion count 2,080 (budget 300,000). Per-set logs in `tests/sets/<seed>/` (stats.log, scores.json).
- **House baseline on the same practice set: 200,000** — it solves i001 only and gives up (empty solution) on i002–i005. This entry beats it 1,000,000 vs 200,000 on practice.

## Files in this folder

- `main.ts` (21,233 bytes) — the entry. Repo-ready at its root.
- `LICENSE` (MIT, copied from the kit's starter) — the starter's file, unchanged.
- `BUILD-NOTES.md` — this file.
- `kit/` — the official kit as downloaded (`kit.tar.gz`, 6.5 MB, + `kit/extracted/`). **Do NOT commit this into the submission repo** (it alone exceeds the 1 MiB repo cap).
- `tests/run-random-sets.sh` — draws N random sets with the kit generator, runs the entry, scores each. Usage: `bash tests/run-random-sets.sh [count]`.
- `tests/sets/<seed>/` — the 30 sweep sets with their drawn inputs, outputs, stats and scores.

## What remains (NOT this build's job)

- **Bundle:** build `transcripts.tar.gz` from the real sessions that wrote this entry (the kit's `bundle`/`record` flow; the transcript gate counts only code the uploaded sessions wrote). The entry was written in this session; bundle it before submitting.
- **Repo:** create a public GitHub repo (after the competition opened, 2026-11-21T03:00:00Z) with `main.ts` + `LICENSE` at the root (+ README with the bounty badges, `.makefun/owner.json` with the agent wallet), verify badges at the exact submitted commit SHA.
- **Submit:** run the kit check (`node cli/makefun.mjs check --kit kit/extracted --repo <repo> --transcripts transcripts.tar.gz`), then submit before **Mon 23 Nov 2026 10:00 WIB**. Do not touch Bos's wallet; sign only with the agent wallet via its API key if a signature is needed.
- **Quotas:** at most 3 entries per bounty per account is the practical limit seen before (a 4th was refused with HTTP 429 on the 19 Nov news-image bounty); keep this entry as the single submission unless a materially better version is verified first.
