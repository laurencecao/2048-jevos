import {
  boardFromTiles,
  emptyBoard,
  isBoard,
  legalMoves,
  rankPlans,
  simulate,
} from "@/lib/game";
import { buildMovePrompt } from "@/lib/prompt";

describe("2048 engine", () => {
  it("merges each tile at most once when moving left", () => {
    const board = [
      [2, 2, 4, 4],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    const result = simulate(board, "left");
    expect(result.board[0]).toEqual([4, 8, 0, 0]);
    expect(result.gained).toBe(12);
    expect(result.moved).toBe(true);
  });

  it("reports a packed row as not movable", () => {
    const board = [
      [2, 4, 8, 16],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    expect(simulate(board, "left").moved).toBe(false);
    expect(simulate(board, "down").moved).toBe(true);
  });

  it("maps [x,y] tile positions to board[y][x]", () => {
    const board = boardFromTiles([
      { position: [3, 0], value: 8 },
      { position: [0, 2], value: 4 },
    ]);
    expect(board[0][3]).toBe(8);
    expect(board[2][0]).toBe(4);
  });

  it("only offers legal moves to the model", () => {
    const board = [
      [2, 2, 0, 0],
      [4, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    const legal = legalMoves(board).map((move) => move.dir);
    expect(legal).toContain("left");
    expect(legal).toContain("right");
    expect(legal).toContain("down");
  });

  it("limits assisted prompts to two candidates", () => {
    const board = [
      [2, 2, 0, 0],
      [4, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    const prompt = buildMovePrompt(board, 0, 0, "assisted");
    expect(prompt.candidates.length).toBeLessThanOrEqual(2);
    expect(prompt.legal.length).toBeGreaterThanOrEqual(
      prompt.candidates.length,
    );
    expect(prompt.candidates.map((candidate) => candidate.id).sort()).toEqual(
      Object.keys(prompt.criteria).sort(),
    );
    for (const candidate of prompt.candidates) {
      expect(prompt.legal).toContain(candidate.dir);
    }
  });

  it("offers eight distinct two-move plans in wide mode", () => {
    const board = [
      [2, 2, 4, 4],
      [8, 16, 32, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    const prompt = buildMovePrompt(board, 0, 0, "wide");
    const ids = prompt.candidates.map((candidate) => candidate.id);

    expect(prompt.candidates.length).toBeGreaterThan(4);
    expect(prompt.candidates.length).toBeLessThanOrEqual(8);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.some((id) => id.includes("+"))).toBe(true);
    expect(ids.sort()).toEqual(Object.keys(prompt.criteria).sort());
    expect(
      new Set(prompt.candidates.map((candidate) => candidate.dir)).size,
    ).toBeGreaterThan(1);
    for (const candidate of prompt.candidates) {
      expect(prompt.legal).toContain(candidate.dir);
    }
  });

  it("drops excluded first moves from wide mode", () => {
    const board = [
      [2, 2, 4, 4],
      [8, 16, 32, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    const before = buildMovePrompt(board, 0, 0, "wide");
    const excluded = before.candidates[0].dir;
    const after = buildMovePrompt(board, 0, 0, "wide", [excluded]);

    expect(after.candidates.length).toBeGreaterThan(0);
    for (const candidate of after.candidates) {
      expect(candidate.dir).not.toBe(excluded);
    }
  });

  it("ranks at most eight plans without repeating a plan id", () => {
    const board = [
      [2, 2, 4, 4],
      [8, 16, 32, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    const plans = rankPlans(board, 8);
    expect(plans.length).toBeLessThanOrEqual(8);
    expect(new Set(plans.map((plan) => plan.id)).size).toBe(plans.length);
    for (const plan of plans) {
      expect(legalMoves(board).map((move) => move.dir)).toContain(plan.first);
      if (plan.second) {
        expect(
          legalMoves(plan.firstResult.board).map((move) => move.dir),
        ).toContain(plan.second);
      }
    }
  });

  it("rejects malformed boards", () => {
    expect(isBoard([[2]])).toBe(false);
    expect(isBoard(emptyBoard())).toBe(true);
  });
});
