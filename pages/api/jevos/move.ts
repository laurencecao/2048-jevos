import type { NextApiRequest, NextApiResponse } from "next";
import { isBoard, legalMoves, type Board, type Dir } from "@/lib/game";
import {
  askEngine,
  defaultProviderId,
  isProviderId,
  resolveEngine,
} from "@/lib/engine";
import { buildMovePrompt, type Mode } from "@/lib/prompt";

const MODES: Mode[] = ["pure", "hinted", "assisted"];
const DIRECTIONS: Dir[] = ["up", "down", "left", "right"];

function asDir(value: unknown): Dir | null {
  return typeof value === "string" && DIRECTIONS.includes(value as Dir)
    ? (value as Dir)
    : null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
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

  const publicPrompt = {
    state: prompt.state,
    instructions: prompt.instructions,
    criteria: prompt.criteria,
  };

  // A single legal move needs no model call; report it honestly.
  if (prompt.candidates.length === 1) {
    const dir = prompt.candidates[0];
    return response.status(200).json({
      gameOver: false,
      skipped: true,
      fallback: false,
      model: engine.model + " (not called: one legal move)",
      engine: engineView,
      move: { choice: dir, probabilities: { [dir]: 1 }, confidence: 1 },
      outlook: null,
      legal: prompt.legal,
      candidates: prompt.candidates,
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

    let choice = moveAnswer.choice as Dir;
    let fallback = false;
    if (!prompt.candidates.includes(choice)) {
      const ranked = Object.entries(probabilities)
        .filter(([dir]) => prompt.candidates.includes(dir as Dir))
        .sort((a, b) => Number(b[1]) - Number(a[1]));
      choice = (ranked[0]?.[0] as Dir) || prompt.candidates[0];
      fallback = true;
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
        choice,
        probabilities,
        confidence:
          typeof moveAnswer.confidence === "number" ? moveAnswer.confidence : 0,
      },
      outlook,
      legal: prompt.legal,
      candidates: prompt.candidates,
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
