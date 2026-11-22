[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/exc-ana/sokoban-solver-01/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/exc-ana/sokoban-solver-01/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

# Sokoban solver — make.fun entry

Push-optimal Sokoban solver in TypeScript (Node 22, stdlib only, no dependencies).

- **Design:** room decomposition (the hallway cuts dead squares out of the floor), then per-room push-optimal A* with a Hungarian-assignment heuristic, deadlock pruning, and deterministic weighted-A* fallbacks.
- **Practice set:** 1,000,000 / 1,000,000 — all 5 instances solved in exactly P* pushes (13/16/29/47/60), deterministic across two runs.
- **Robustness sweep:** 30 fresh sets drawn with the kit's own generator, 30/30 at 1,000,000 (150/150 instances at P*).
- **House baseline** (plain-astar 1.0.0) scores 200,000 on the same practice set.

Entry: `main.ts` at the repo root. Run with `MAKEFUN_INPUT_DIR=<input> MAKEFUN_OUTPUT_DIR=<output> node main.ts`. See `BUILD-NOTES.md` for rules, design, and verification.
