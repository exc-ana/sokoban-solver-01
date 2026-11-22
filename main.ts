// Sokoban solver entry for make.fun "Build the best Sokoban solver, 21 November 2026".
//
// Design (from the kit's RULES.txt and the level structure it describes, written from scratch here):
//   - A level is one hallway with one to four rooms off it, each room holding 3 or 4 boxes and as many goals.
//     A box pushed through a door into the hallway can never be pushed back, so every box stays in its room and
//     the level's push-optimal count P* is the sum of its rooms' optima. The rooms are therefore independent
//     problems, joined only by the player's walk along the hallway.
//   - Each room is solved on its own with an A* search over pushes (one push costs 1), so the first solved state
//     the search pops is push-optimal for that room, and the rooms' optima add up to P* for the level.
//   - The search state is the boxes' squares plus the player's reachable region (named by its lowest square:
//     two player squares in one region allow exactly the same pushes). It prunes two deadlocks a box can never
//     leave: a dead square (no pull path from any goal reaches it) and a frozen 2 x 2 block of walls and boxes
//     with a box off its goal. Neither prunes a solvable state.
//   - The heuristic is the minimum-cost assignment of boxes to goals (Hungarian), where a box's cost to a goal
//     is its shortest walking distance ignoring other boxes. One push moves one box one square, so the assignment
//     cost is a lower bound on the pushes still needed: admissible, and consistent (a push changes it by at most
//     one), so A* with a closed set is push-optimal.
//   - Determinism: no clock, no randomness, no environment-dependent branching. Ties in the heap break by
//     heuristic, then by insertion order; walks break ties by direction order u, d, l, r. The search is budgeted
//     by expansions, never by time, so two runs write the same bytes.
//   - Fallbacks, all deterministic: if the optimal search exhausts its expansion budget for a room, the room is
//     retried with weighted A* (weights 2, 4, 32), which trades optimality for a solution rather than none. If
//     every attempt fails, or a level is not a set of rooms, the whole level falls back to a push search over the
//     full board; if that fails too the entry writes an empty solution (valid format, 0 points) instead of
//     crashing, so one hard level never takes the other four down.
//   - Every solution is replayed locally before it is written: a move that walks into a wall or pushes a box
//     into a wall or another box, or a replay that leaves a box off a goal, is discarded for an empty solution.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
// (the grader runs: node /bot/main.ts, reading /input/<id>/level.txt, writing /output/<id>/solution.txt).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
/** Print per-instance stats (pushes, expansions) to stderr when set; never changes solution.txt. */
const STATS = process.env.MAKEFUN_STATS === '1';

/** The four directions in fixed order: [dx, dy, walk letter, push letter]. */
const DIRS: readonly (readonly [number, number, string, string])[] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

/** Expansion budgets (work, never the clock): optimal search, then weighted retries. */
const OPTIMAL_BUDGET = 300_000;
const WEIGHTED_BUDGET = 150_000;
const WEIGHTS = [1, 2, 4, 32];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** A level in XSB text (# wall, space floor, . goal, $ box, * box on a goal, @ player, + player on a goal). */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // A square on the outermost frame is a wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/** The squares from which a box alone can be pulled onto some goal (pulled back from the goals over open floor). */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** Whether the box just pushed to `t` sits in a frozen 2 x 2 block of walls and boxes with a box off its goal. */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/**
 * The squares the player reaches from `from` with `occupied` in the way, marked in `seen` with `stamp`; returns the
 * lowest square reached, which names the region.
 */
function reach(level: Level, occupied: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters (u first on ties). */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string | null {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return null;
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player stands on after `moves` (LURD, case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/** Minimum-cost assignment of rows to columns (square matrix): the Hungarian algorithm, O(n^3). */
function hungarian(cost: number[][]): number {
  const n = cost.length;
  const BIG = 1e9;
  const u = new Float64Array(n + 1);
  const v = new Float64Array(n + 1);
  const p = new Int32Array(n + 1);
  const way = new Int32Array(n + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(n + 1).fill(Infinity);
    const used = new Uint8Array(n + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0]!;
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1]![j - 1]! - u[i0]! - v[j]!;
        if (cur < minv[j]!) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j]! < delta) {
          delta = minv[j]!;
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]!] += delta;
          v[j]! -= delta;
        } else {
          minv[j]! -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0 !== 0);
  }
  let total = 0;
  for (let j = 1; j <= n; j++) {
    const c = cost[p[j]! - 1]![j - 1]!;
    if (c >= BIG / 2) return Infinity;
    total += c;
  }
  return total;
}

/** A binary heap ordered by (f, h, insertion order): every comparison is fixed, so pops are deterministic. */
class Heap {
  private a: { f: number; h: number; seq: number; idx: number }[] = [];
  get size(): number {
    return this.a.length;
  }
  private less(x: { f: number; h: number; seq: number }, y: { f: number; h: number; seq: number }): boolean {
    return x.f < y.f || (x.f === y.f && (x.h < y.h || (x.h === y.h && x.seq < y.seq)));
  }
  push(e: { f: number; h: number; seq: number; idx: number }): void {
    const a = this.a;
    let i = a.length;
    a.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i]!, a[p]!)) break;
      [a[i], a[p]] = [a[p]!, a[i]!];
      i = p;
    }
  }
  pop(): { f: number; h: number; seq: number; idx: number } {
    const a = this.a;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= a.length) break;
        if (c + 1 < a.length && this.less(a[c + 1]!, a[c]!)) c++;
        if (!this.less(a[c]!, a[i]!)) break;
        [a[i], a[c]] = [a[c]!, a[i]!];
        i = c;
      }
    }
    return top;
  }
}

interface SearchResult {
  pushes: number;
  moves: string;
  expansions: number;
}

/**
 * A push search of `level` with heuristic weight `weight` (1 is A*, optimal; higher is greedier) and at most
 * `maxExpand` expansions: {pushes, moves} or null when the budget runs out or no solution exists.
 */
function searchPushes(level: Level, weight: number, maxExpand: number): SearchResult | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  if (level.boxes.some((b) => !live[b]) && !solved(level.boxes)) return null;

  // Each goal's walking distance to every square (ignoring boxes), for the assignment heuristic.
  const distToGoal: Int32Array[] = goals.map((g) => {
    const dist = new Int32Array(size).fill(-1);
    dist[g] = 0;
    const queue = [g];
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi]!;
      for (const [dx, dy] of DIRS) {
        const q = p + dy * w + dx;
        if (!wall[q] && dist[q] < 0) {
          dist[q] = dist[p]! + 1;
          queue.push(q);
        }
      }
    }
    return dist;
  });
  const heuristic = (boxes: number[]): number => {
    if (boxes.length === 0) return 0;
    const n = boxes.length;
    const cost: number[][] = [];
    for (let i = 0; i < n; i++) {
      const row: number[] = [];
      for (let j = 0; j < n; j++) {
        const d = distToGoal[j]![boxes[i]!]!;
        row.push(d < 0 ? 1e9 : d);
      }
      cost.push(row);
    }
    return hungarian(cost);
  };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const keyOf = (boxes: number[], low: number): string => boxes.join(',') + '|' + low;

  const boxesList: number[][] = [level.boxes];
  const playerList: number[] = [level.player];
  const lowList: number[] = [];
  const parentList: number[] = [-1];
  const fromList: number[] = [-1]; // the box's square before the push that made this state
  const dirList: number[] = [-1]; // the push's direction index
  const gList: number[] = [0];
  for (const b of level.boxes) occupied[b] = 1;
  lowList.push(reach(level, occupied, level.player, seen, ++stamp, stack));
  for (const b of level.boxes) occupied[b] = 0;
  const best = new Map<string, number>([[keyOf(level.boxes, lowList[0]!), 0]]);
  const h0 = heuristic(level.boxes);
  if (h0 === Infinity) return null;
  const heap = new Heap();
  let seq = 0;
  heap.push({ f: h0, h: h0, seq: seq++, idx: 0 });
  let expansions = 0;
  let found = solved(level.boxes) ? 0 : -1;

  while (heap.size > 0 && found < 0) {
    const { idx: s } = heap.pop();
    const boxes = boxesList[s]!;
    if (best.get(keyOf(boxes, lowList[s]!)) !== gList[s]) continue; // a better path to this state was found
    if (expansions >= maxExpand) return null;
    expansions++;
    const g = gList[s]!;
    for (const b of boxes) occupied[b] = 1;
    reach(level, occupied, playerList[s]!, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi]!;
      for (let di = 0; di < 4; di++) {
        const [dx, dy] = DIRS[di]!;
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let key = '';
        let next: number[] | null = null;
        let low = -1;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          low = reach(level, occupied, b, mark, ++stamp, stack);
          key = keyOf(next, low);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || next === null) continue;
        const ng = g + 1;
        const prev = best.get(key);
        if (prev !== undefined && prev <= ng) continue;
        best.set(key, ng);
        const h = heuristic(next);
        if (h === Infinity) continue;
        const idx = boxesList.length;
        boxesList.push(next);
        playerList.push(b);
        lowList.push(low);
        parentList.push(s);
        fromList.push(b);
        dirList.push(di);
        gList.push(ng);
        if (solved(next)) {
          found = idx;
          break;
        }
        heap.push({ f: ng + weight * h, h, seq: seq++, idx });
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;

  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parentList[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  for (const s of path) {
    const nextBoxes = boxesList[s]!;
    const from = fromList[s]!;
    const di = dirList[s]!;
    const [dx, dy, , pushLetter] = DIRS[di]!;
    const d = dy * w + dx;
    for (const b of boxes) occupied[b] = 1;
    const walk = walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    if (walk === null) return null;
    moves += walk + pushLetter;
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves, expansions };
}

/** One room's solution: optimal A* first, then greedier weighted retries on budget exhaustion. */
function solveRoom(sub: Level): SearchResult | null {
  const first = searchPushes(sub, WEIGHTS[0]!, OPTIMAL_BUDGET);
  if (first !== null) return first;
  for (let k = 1; k < WEIGHTS.length; k++) {
    const retry = searchPushes(sub, WEIGHTS[k]!, WEIGHTED_BUDGET);
    if (retry !== null) return retry;
  }
  return null;
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway: a box there reaches no goal) out of the
 * floor, and each part left that holds a box is a room. Null when some part holds more or fewer boxes than goals, or
 * a box starts in the hallway: then the level is no set of rooms.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  if (goals.some((g) => part[g]! < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** The level solved room by room, or over the whole board when it is no set of rooms. */
function solveLevel(level: Level): { pushes: number; moves: string; expansions: number } | null {
  const rooms = roomsOf(level);
  if (rooms === null) {
    const whole = searchPushes(level, 1, OPTIMAL_BUDGET) ?? searchPushes(level, 4, WEIGHTED_BUDGET);
    return whole === null ? null : { pushes: whole.pushes, moves: whole.moves, expansions: whole.expansions };
  }
  let player = level.player;
  let pushes = 0;
  let moves = '';
  let expansions = 0;
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solveRoom(sub);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    expansions += solved.expansions;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves, expansions };
}

/** Replay `moves` on `level` exactly as the checker does: legality, solved, push count. */
function replay(level: Level, moves: string): { solved: boolean; pushes: number } | null {
  const { w, wall, goals } = level;
  const box = new Uint8Array(wall.length);
  for (const b of level.boxes) box[b] = 1;
  const goal = new Uint8Array(wall.length);
  for (const g of goals) goal[g] = 1;
  let player = level.player;
  let pushes = 0;
  for (const ch of moves) {
    const lower = ch.toLowerCase();
    const dir = DIRS.find(([, , l]) => l === lower);
    if (!dir) return null;
    const d = dir[1] * w + dir[0];
    const next = player + d;
    if (wall[next]) return null;
    if (box[next]) {
      const beyond = next + d;
      if (wall[beyond] || box[beyond]) return null;
      box[next] = 0;
      box[beyond] = 1;
      pushes++;
    }
    player = next;
  }
  for (let i = 0; i < box.length; i++) if (box[i] && !goal[i]) return { solved: false, pushes };
  return { solved: true, pushes };
}

function solve(text: string): string {
  const level = parseLevel(text);
  let result: { pushes: number; moves: string; expansions: number } | null = null;
  try {
    result = solveLevel(level);
  } catch {
    result = null;
  }
  if (result !== null) {
    const check = replay(level, result.moves);
    if (check !== null && check.solved && check.pushes === result.pushes) {
      if (STATS) console.error(`solved in ${result.pushes} pushes, ${result.expansions} expansions`);
      return result.moves;
    }
  }
  if (STATS) console.error('unsolved, writing an empty solution');
  return '';
}

for (const id of readdirSync(I).sort()) {
  let moves = '';
  try {
    moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
