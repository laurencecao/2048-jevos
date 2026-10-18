import {
  boardToCompact,
  describeMove,
  emptyCount,
  isCorner,
  maxTile,
  maxTilePos,
  monotonicity,
  rankMoves,
  rankPlans,
  type Board,
  type Dir,
  type Plan,
  type RankedMove,
} from "./game";

export type Mode = "pure" | "hinted" | "assisted" | "wide";

export const MODE_LABEL: Record<Mode, string> = {
  assisted: "裁决 · 2 候选（快）",
  hinted: "自选 · 4 候选（慢）",
  wide: "两步行棋 · 8 候选",
  pure: "纯模型 · 无提示",
};

export type MoveCandidate = {
  /** What the model answers. Single-ply modes use the direction itself,
   * the 8-candidate mode uses "first+second" so each plan stays distinct. */
  id: string;
  /** The move that is actually played when this candidate wins. */
  dir: Dir;
  description: string;
};

export type MovePrompt = {
  state: string;
  instructions: string;
  criteria: Record<string, string>;
  candidates: MoveCandidate[];
  legal: Dir[];
  ranked: RankedMove[];
  plans: Plan[];
};

function describePlan(plan: Plan): string {
  const board = plan.result.board;
  const pos = maxTilePos(board);
  return (
    plan.id +
    ": => " +
    boardToCompact(board) +
    "; +" +
    (plan.firstResult.gained + plan.result.gained) +
    ", " +
    emptyCount(board) +
    " empty, max " +
    maxTile(board) +
    (isCorner(pos.r, pos.c) ? " corner" : " not corner") +
    ", mono " +
    monotonicity(board).toFixed(2) +
    ", eval " +
    Math.round(plan.score)
  );
}

export function buildMovePrompt(
  board: Board,
  score: number,
  moves: number,
  mode: Mode,
  exclude: Dir[] = [],
): MovePrompt {
  const ranked = rankMoves(board).filter((move) => !exclude.includes(move.dir));
  const legal = ranked.map((move) => move.dir);

  let candidates: MoveCandidate[] = [];
  let plans: Plan[] = [];

  if (mode === "wide") {
    plans = rankPlans(board, 8).filter((plan) => !exclude.includes(plan.first));
    candidates = plans.map((plan) => ({
      id: plan.id,
      dir: plan.first,
      description: describePlan(plan),
    }));
  } else {
    const picked =
      mode === "assisted" && ranked.length > 2 ? ranked.slice(0, 2) : ranked;
    candidates = picked.map((move) => ({
      id: move.dir,
      dir: move.dir,
      description:
        describeMove(move.dir, move.result) +
        (mode === "hinted" ? ", eval " + Math.round(move.score) : ""),
    }));
  }

  const criteria: Record<string, string> = {};
  for (const candidate of candidates) {
    criteria[candidate.id] = candidate.description;
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
        : mode === "wide"
          ? "Pick the best two-move plan. Each candidate is named first+second and shows the board after playing both moves, the total points gained and a heuristic evaluation (higher is better). Only the first move of your choice is played now; the second is the suggested follow-up and will be re-evaluated after the next tile spawns. Prefer the plan with the highest evaluation, merges, empty cells and a cornered largest tile."
          : "Pick the best 2048 move. Prefer merges, more empty cells, monotonic rows and columns, and keep the largest tile in a corner.";

  return {
    state,
    instructions,
    criteria,
    candidates,
    legal,
    ranked,
    plans,
  };
}
