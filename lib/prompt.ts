import {
  boardToCompact,
  describeMove,
  emptyCount,
  maxTile,
  maxTilePos,
  rankMoves,
  type Board,
  type Dir,
  type RankedMove,
} from "./game";

export type Mode = "pure" | "hinted" | "assisted";

export const MODE_LABEL: Record<Mode, string> = {
  assisted: "jevos 裁决 · 2 候选（快）",
  hinted: "jevos 自选 · 4 候选（慢）",
  pure: "纯 jevos · 无提示",
};

export type MovePrompt = {
  state: string;
  instructions: string;
  criteria: Record<string, string>;
  candidates: Dir[];
  legal: Dir[];
  ranked: RankedMove[];
};

export function buildMovePrompt(
  board: Board,
  score: number,
  moves: number,
  mode: Mode,
  exclude: Dir[] = [],
): MovePrompt {
  const ranked = rankMoves(board).filter((move) => !exclude.includes(move.dir));
  const legal = ranked.map((move) => move.dir);
  const candidates =
    mode === "assisted" && ranked.length > 2 ? ranked.slice(0, 2) : ranked;

  const criteria: Record<string, string> = {};
  for (const candidate of candidates) {
    let description = describeMove(candidate.dir, candidate.result);
    if (mode === "hinted") {
      description += ", eval " + Math.round(candidate.score);
    }
    criteria[candidate.dir] = description;
  }

  const pos = maxTilePos(board);
  const state =
    "2048 4x4. score " +
    score +
    ", move " +
    moves +
    ". board: " +
    boardToCompact(board) +
    ". " +
    emptyCount(board) +
    " empty, max " +
    maxTile(board) +
    " at r" +
    (pos.r + 1) +
    "c" +
    (pos.c + 1) +
    ".";

  const instructions =
    mode === "assisted"
      ? "Pick the better of these two candidate 2048 moves. Prefer merges, more empty cells, monotonic rows and columns, and keep the largest tile in a corner."
      : mode === "hinted"
        ? "Pick the best 2048 move. Each candidate shows the resulting board, points gained, empty cells, largest tile position, row monotonicity and a heuristic evaluation (higher is better). Prefer a higher evaluation, merges, empty cells and a cornered largest tile."
        : "Pick the best 2048 move. Prefer merges, more empty cells, monotonic rows and columns, and keep the largest tile in a corner.";

  return {
    state,
    instructions,
    criteria,
    candidates: candidates.map((move) => move.dir),
    legal,
    ranked,
  };
}
