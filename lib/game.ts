export type Dir = "up" | "down" | "left" | "right";
export type Board = number[][];

export const SIZE = 4;
export const DIRS: Dir[] = ["up", "down", "left", "right"];
export const DIR_LABEL: Record<Dir, string> = {
  up: "上",
  down: "下",
  left: "左",
  right: "右",
};
export const DIR_ARROW: Record<Dir, string> = {
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
};
export const DIR_TO_ACTION = {
  up: "move_up",
  down: "move_down",
  left: "move_left",
  right: "move_right",
} as const;

export type TileLike = {
  position: [number, number] | number[];
  value: number;
};

export type MoveResult = {
  board: Board;
  gained: number;
  moved: boolean;
};

export type RankedMove = {
  dir: Dir;
  result: MoveResult;
  score: number;
};

export function emptyBoard(): Board {
  return Array.from({ length: SIZE }, () => Array<number>(SIZE).fill(0));
}

export function cloneBoard(board: Board): Board {
  return board.map((row) => row.slice());
}

/**
 * The game stores a tile's position as [x, y] while the board is indexed
 * board[y][x]. Keep that translation in one place.
 */
export function boardFromTiles(tiles: TileLike[]): Board {
  const board = emptyBoard();
  for (const tile of tiles) {
    const [x, y] = tile.position;
    if (x >= 0 && x < SIZE && y >= 0 && y < SIZE) {
      board[y][x] = tile.value;
    }
  }
  return board;
}

export function emptyCount(board: Board): number {
  return board.reduce(
    (total, row) => total + row.filter((value) => value === 0).length,
    0,
  );
}

export function maxTile(board: Board): number {
  return board.reduce(
    (best, row) => Math.max(best, ...row),
    0,
  );
}

export function maxTilePos(board: Board): { r: number; c: number } {
  const best = maxTile(board);
  for (let r = 0; r < SIZE; r += 1) {
    for (let c = 0; c < SIZE; c += 1) {
      if (board[r][c] === best) return { r, c };
    }
  }
  return { r: 0, c: 0 };
}

export function isCorner(r: number, c: number): boolean {
  return (r === 0 || r === SIZE - 1) && (c === 0 || c === SIZE - 1);
}

function slideLine(line: number[]): { line: number[]; gained: number } {
  const values = line.filter((value) => value !== 0);
  const output: number[] = [];
  let gained = 0;

  for (let i = 0; i < values.length; i += 1) {
    if (i + 1 < values.length && values[i] === values[i + 1]) {
      const merged = values[i] * 2;
      output.push(merged);
      gained += merged;
      i += 1;
    } else {
      output.push(values[i]);
    }
  }

  while (output.length < SIZE) output.push(0);
  return { line: output, gained };
}

export function simulate(board: Board, dir: Dir): MoveResult {
  const next = cloneBoard(board);
  let gained = 0;
  let moved = false;

  if (dir === "left" || dir === "right") {
    for (let r = 0; r < SIZE; r += 1) {
      const line = next[r].slice();
      if (dir === "right") line.reverse();
      const result = slideLine(line);
      const output = dir === "right" ? result.line.slice().reverse() : result.line;
      gained += result.gained;
      if (output.some((value, c) => value !== next[r][c])) moved = true;
      next[r] = output;
    }
  } else {
    for (let c = 0; c < SIZE; c += 1) {
      const line = Array.from({ length: SIZE }, (_, r) => next[r][c]);
      if (dir === "down") line.reverse();
      const result = slideLine(line);
      const output = dir === "down" ? result.line.slice().reverse() : result.line;
      gained += result.gained;
      for (let r = 0; r < SIZE; r += 1) {
        if (next[r][c] !== output[r]) moved = true;
        next[r][c] = output[r];
      }
    }
  }

  return { board: next, gained, moved };
}

export function legalMoves(
  board: Board,
): { dir: Dir; result: MoveResult }[] {
  return DIRS.map((dir) => ({ dir, result: simulate(board, dir) })).filter(
    ({ result }) => result.moved,
  );
}

/** 0..1: share of adjacent row/column pairs that are non-increasing. */
export function monotonicity(board: Board): number {
  let good = 0;
  let total = 0;

  for (let r = 0; r < SIZE; r += 1) {
    for (let c = 0; c < SIZE - 1; c += 1) {
      total += 1;
      if (board[r][c] >= board[r][c + 1]) good += 1;
    }
  }
  for (let c = 0; c < SIZE; c += 1) {
    for (let r = 0; r < SIZE - 1; r += 1) {
      total += 1;
      if (board[r][c] >= board[r + 1][c]) good += 1;
    }
  }

  return total === 0 ? 1 : good / total;
}

function log2(value: number): number {
  return value > 0 ? Math.log2(value) : 0;
}

/**
 * A deliberately small 1-ply 2048 heuristic. It is only used to rank the
 * candidate moves that are handed to the model (and for the optional
 * "heuristic only" baseline); every order still ends with a model choice.
 */
export function evaluate(board: Board): number {
  const empty = emptyCount(board);
  let monotonic = 0;
  let smoothness = 0;
  let merges = 0;

  for (let r = 0; r < SIZE; r += 1) {
    for (let c = 0; c < SIZE; c += 1) {
      if (c < SIZE - 1) {
        const a = log2(board[r][c]);
        const b = log2(board[r][c + 1]);
        if (a > 0 && b > 0) {
          smoothness -= Math.abs(a - b);
          if (a === b) merges += 1;
        }
        if (a > b) monotonic += a - b;
        else if (b > a) monotonic -= b - a;
      }
      if (r < SIZE - 1) {
        const a = log2(board[r][c]);
        const b = log2(board[r + 1][c]);
        if (a > 0 && b > 0) {
          smoothness -= Math.abs(a - b);
          if (a === b) merges += 1;
        }
      }
    }
  }

  const pos = maxTilePos(board);
  const corner = isCorner(pos.r, pos.c) ? 1 : 0;

  return (
    empty * 270 +
    monotonic * 47 +
    smoothness * 10 +
    merges * 300 +
    corner * 1500
  );
}

export function rankMoves(board: Board): RankedMove[] {
  return legalMoves(board)
    .map(({ dir, result }) => ({
      dir,
      result,
      score: evaluate(result.board),
    }))
    .sort((a, b) => b.score - a.score);
}

export function boardToCompact(board: Board): string {
  return board.map((row) => row.join(" ")).join(" / ");
}

export function describeMove(dir: Dir, result: MoveResult): string {
  const board = result.board;
  const pos = maxTilePos(board);
  return (
    dir +
    ": => " +
    boardToCompact(board) +
    "; +" +
    result.gained +
    ", " +
    emptyCount(board) +
    " empty, max " +
    maxTile(board) +
    (isCorner(pos.r, pos.c) ? " corner" : " not corner") +
    ", mono " +
    monotonicity(board).toFixed(2)
  );
}

export function tileSignature(tiles: TileLike[]): string {
  return tiles
    .map(
      (tile) =>
        String(tile.position[0]) +
        "," +
        String(tile.position[1]) +
        ":" +
        String(tile.value),
    )
    .join("|");
}

export function isBoard(value: unknown): value is Board {
  return (
    Array.isArray(value) &&
    value.length === SIZE &&
    value.every(
      (row) =>
        Array.isArray(row) &&
        row.length === SIZE &&
        row.every(
          (cell) =>
            typeof cell === "number" &&
            Number.isFinite(cell) &&
            cell >= 0 &&
            cell <= 131072,
        ),
    )
  );
}
