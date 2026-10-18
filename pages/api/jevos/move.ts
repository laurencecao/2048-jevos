import type { NextApiRequest, NextApiResponse } from "next";
import { isBoard, legalMoves, type Board, type Dir } from "@/lib/game";
import {
  askEngine,
  defaultProviderId,
  isProviderId,
  resolveEngine,
} from "@/lib/engine";
import { buildMovePrompt, type Mode, type MoveCandidate } from "@/lib/prompt";

const MODES: Mode[] = ["pure", "hinted", "assisted", "wide"];
const DIRECTIONS: Dir[] = ["up", "down", "left", "right"];

function asDir(value: unknown): Dir | null {
  return typeof value === "string" && DIRECTIONS.includes(value as Dir)
    ? (value as Dir)
    : null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function firstDirs(candidates: MoveCandidate[]): Dir[] {
  return Array.from(new Set(candidates.map((candidate) => candidate.dir)));
}

function probabilityOf(
  probabilities: Record<string, number>,
  id: string,
): number {
  const value = probabilities[id];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Sum per-candidate probabilities into one number per direction, so the
 * 4-cell dpad stays meaningful when a candidate is a two-move plan. */
function byDirection(
  probabilities: Record<string, number>,
  candidates: MoveCandidate[],
): Record<string, number> {
  const summed: Record<string, number> = {};
  for (const candidate of candidates) {
    summed[candidate.dir] =
      (summed[candidate.dir] ?? 0) + probabilityOf(probabilities, candidate.id);
  }
  return summed;
}

export default async function handler(
  request: NextApiRequest,
  response: NextApiResponse,
) {
  response.setHeader("Cache-Control", "no-store");

  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "method not allowed" });
  }

  const body = (request.body || {}) as Record<string, unknown>;
  if (!isBoard(body.board)) {
    return response
      .status(400)
      .json({ error: "board must be a 4x4 array of numbers" });
  }

  const board = body.board as Board;
  const legal = legalMoves(board);
  if (legal.length === 0) {
    return response.status(200).json({ gameOver: true, legal: [] });
  }

  const mode: Mode = MODES.includes(body.mode as Mode)
    ? (body.mode as Mode)
    : "hinted";
  const exclude = Array.isArray(body.exclude)
    ? body.exclude.map(asDir).filter((dir): dir is Dir => dir !== null)
    : [];

  const provider = isProviderId(body.provider)
    ? body.provider
    : defaultProviderId();
  const engine = resolveEngine(provider);
  const engineView = {
    id: engine.id,
    label: engine.label,
    model: engine.model,
    transport: engine.transport,
  };

  const prompt = buildMovePrompt(
    board,
    numberOr(body.score, 0),
    numberOr(body.moves, 0),
    mode,
    exclude,
  );

  if (prompt.candidates.length === 0) {
    return response
      .status(409)
      .json({ error: "no legal move left after exclusions" });
  }

  const candidateIds = prompt.candidates.map((candidate) => candidate.id);
  const dirs = firstDirs(prompt.candidates);

  const publicPrompt = {
    state: prompt.state,
    instructions: prompt.instructions,
    criteria: prompt.criteria,
  };

  // A single direction needs no model call; report it honestly.
  if (dirs.length === 1) {
    return response.status(200).json({
      gameOver: false,
      skipped: true,
      fallback: false,
      model: engine.model + " (not called: one legal move)",
      engine: engineView,
      move: {
        choice: dirs[0],
        plan: dirs[0],
        probabilities: { [dirs[0]]: 1 },
        confidence: 1,
      },
      outlook: null,
      legal: prompt.legal,
      candidates: candidateIds,
      candidateDirs: dirs,
      plans: [],
      prompt: publicPrompt,
      latencyMs: 0,
      usage: null,
      endpoint: engine.endpoint,
    });
  }

  try {
    const { json, latencyMs } = await askEngine(provider, prompt.state, {
      move: {
        type: "choice",
        instructions: prompt.instructions,
        criteria: prompt.criteria,
      },
      outlook: {
        type: "score",
        instructions: "How good is this 2048 position for the player?",
        criteria: ["losing", "weak", "ok", "strong", "winning"],
      },
    });

    const moveAnswer = json.answers && json.answers.move;
    if (!moveAnswer || typeof moveAnswer.choice !== "string") {
      throw new Error(engine.label + " returned no choice");
    }

    const probabilities =
      moveAnswer.probabilities && typeof moveAnswer.probabilities === "object"
        ? (moveAnswer.probabilities as Record<string, number>)
        : {};

    // The model may answer with a candidate id ("left+up"), a bare direction
    // ("left"), or something unknown. Resolve in that order and flag the
    // fallback instead of silently playing an unrequested move.
    const answer = moveAnswer.choice;
    let chosen =
      prompt.candidates.find((candidate) => candidate.id === answer) ?? null;
    let fallback = false;

    if (!chosen) {
      const sameDirection = prompt.candidates.filter(
        (candidate) => candidate.dir === answer,
      );
      if (sameDirection.length > 0) {
        chosen = sameDirection.sort(
          (a, b) =>
            probabilityOf(probabilities, b.id) -
            probabilityOf(probabilities, a.id),
        )[0];
      }
    }

    if (!chosen) {
      fallback = true;
      chosen = prompt.candidates
        .slice()
        .sort(
          (a, b) =>
            probabilityOf(probabilities, b.id) -
            probabilityOf(probabilities, a.id),
        )[0];
    }

    const outlookAnswer = json.answers && json.answers.outlook;
    const outlook =
      outlookAnswer && typeof outlookAnswer.score === "number"
        ? {
            score: outlookAnswer.score,
            label:
              (outlookAnswer.legend &&
                outlookAnswer.legend[
                  String(Math.round(outlookAnswer.score))
                ]) ||
              "",
            probabilities: outlookAnswer.probabilities || {},
            confidence:
              typeof outlookAnswer.confidence === "number"
                ? outlookAnswer.confidence
                : 0,
          }
        : null;

    return response.status(200).json({
      gameOver: false,
      skipped: false,
      fallback,
      model: json.model || engine.model,
      engine: { ...engineView, model: json.model || engine.model },
      move: {
        choice: chosen.dir,
        plan: chosen.id,
        probabilities: byDirection(probabilities, prompt.candidates),
        confidence:
          typeof moveAnswer.confidence === "number" ? moveAnswer.confidence : 0,
      },
      plans: prompt.candidates.map((candidate) => ({
        id: candidate.id,
        dir: candidate.dir,
        probability: probabilityOf(probabilities, candidate.id),
      })),
      outlook,
      legal: prompt.legal,
      candidates: candidateIds,
      candidateDirs: dirs,
      prompt: publicPrompt,
      latencyMs,
      usage: json.usage || null,
      endpoint: engine.endpoint,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return response.status(502).json({
      error: message,
      hint: engine.hint,
      provider: engine.id,
    });
  }
}
