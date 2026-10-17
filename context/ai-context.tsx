import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import { mergeAnimationDuration } from "@/constants";
import {
  boardFromTiles,
  DIR_TO_ACTION,
  legalMoves,
  maxTile,
  tileSignature,
  type Dir,
} from "@/lib/game";
import { GameContext } from "./game-context";

export type AiMode = "pure" | "hinted" | "assisted";

/** Mirrors lib/engine.ts; kept local so the client bundle never imports the
 * server-side fetch helpers. */
export type EngineProvider = "jevos" | "ollama";

export type EngineInfo = {
  id: EngineProvider;
  label: string;
  model: string;
  transport?: "cpu" | "gpu";
};

export type Outlook = {
  score: number;
  label: string;
  probabilities: Record<string, number>;
  confidence: number;
};

export type PromptView = {
  state: string;
  instructions: string;
  criteria: Record<string, string>;
};

export type Decision = {
  n: number;
  dir: Dir;
  probabilities: Record<string, number>;
  confidence: number;
  latencyMs: number;
  tokens: number;
  skipped: boolean;
  fallback: boolean;
  legal: Dir[];
  candidates: Dir[];
  outlook: Outlook | null;
  prompt: PromptView | null;
  at: number;
};

export type EngineHealth = {
  ok: boolean;
  provider?: EngineProvider;
  label?: string;
  endpoint?: string;
  model?: string;
  transport?: "cpu" | "gpu";
  latencyMs?: number;
  error?: string;
  hint?: string;
  engines?: EngineInfo[];
};

export type AiStats = {
  moves: number;
  score: number;
  maxTile: number;
  avgConfidence: number;
  avgLatency: number;
};

const ENGINE_STORAGE_KEY = "2048-engine";

type AiContextValue = {
  running: boolean;
  busy: boolean;
  error: string | null;
  engine: EngineHealth | null;
  engines: EngineInfo[];
  provider: EngineProvider | null;
  setProvider: (provider: EngineProvider) => void;
  mode: AiMode;
  setMode: (mode: AiMode) => void;
  speedMs: number;
  setSpeedMs: (speed: number) => void;
  decisions: Decision[];
  last: Decision | null;
  moveNo: number;
  stats: AiStats;
  start: () => void;
  pause: () => void;
  step: () => void;
  restart: () => void;
  refreshHealth: () => void;
  clearError: () => void;
};

const defaultStats: AiStats = {
  moves: 0,
  score: 0,
  maxTile: 0,
  avgConfidence: 0,
  avgLatency: 0,
};

const AiContext = createContext<AiContextValue>({
  running: false,
  busy: false,
  error: null,
  engine: null,
  engines: [],
  provider: null,
  setProvider: () => undefined,
  mode: "assisted",
  setMode: () => undefined,
  speedMs: 150,
  setSpeedMs: () => undefined,
  decisions: [],
  last: null,
  moveNo: 0,
  stats: defaultStats,
  start: () => undefined,
  pause: () => undefined,
  step: () => undefined,
  restart: () => undefined,
  refreshHealth: () => undefined,
  clearError: () => undefined,
});

export function useAi(): AiContextValue {
  return useContext(AiContext);
}

export default function AiProvider({ children }: PropsWithChildren) {
  const game = useContext(GameContext);
  const gameRef = useRef(game);
  gameRef.current = game;

  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [engine, setEngine] = useState<EngineHealth | null>(null);
  const [provider, setProviderState] = useState<EngineProvider | null>(null);
  const [mode, setMode] = useState<AiMode>("assisted");
  const [speedMs, setSpeedMs] = useState(150);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [moveNo, setMoveNo] = useState(0);
  const [tick, setTick] = useState(0);

  const runningRef = useRef(running);
  const busyRef = useRef(busy);
  const modeRef = useRef(mode);
  const providerRef = useRef<EngineProvider | null>(provider);
  const runIdRef = useRef(0);
  const stepRef = useRef(false);
  const moveNoRef = useRef(0);
  const bannedRef = useRef<Set<string>>(new Set());
  const sigRef = useRef("");
  const abortRef = useRef<AbortController | null>(null);
  const stateRef = useRef({ score: game.score, status: game.status });

  runningRef.current = running;
  busyRef.current = busy;
  modeRef.current = mode;
  providerRef.current = provider;
  stateRef.current = { score: game.score, status: game.status };

  const tiles = game.getTiles();
  const signature = tileSignature(tiles);
  const board = boardFromTiles(tiles);
  sigRef.current = signature;

  const last = decisions.length > 0 ? decisions[decisions.length - 1] : null;

  const stats: AiStats = {
    moves: moveNo,
    score: game.score,
    maxTile: maxTile(board),
    avgConfidence:
      decisions.filter((decision) => !decision.skipped).length === 0
        ? 0
        : decisions
            .filter((decision) => !decision.skipped)
            .reduce((total, decision) => total + decision.confidence, 0) /
          decisions.filter((decision) => !decision.skipped).length,
    avgLatency:
      decisions.filter((decision) => !decision.skipped).length === 0
        ? 0
        : decisions
            .filter((decision) => !decision.skipped)
            .reduce((total, decision) => total + decision.latencyMs, 0) /
          decisions.filter((decision) => !decision.skipped).length,
  };

  const refreshHealth = useCallback(async (id?: EngineProvider) => {
    const target = id ?? providerRef.current;
    const query = target ? "?provider=" + target : "";
    try {
      const response = await fetch("/api/jevos/health" + query, {
        cache: "no-store",
      });
      const json = (await response.json()) as EngineHealth;
      setEngine(json);
      // First load with no explicit choice: adopt the server's default.
      if (json.provider === "jevos" || json.provider === "ollama") {
        setProviderState((current) => current ?? json.provider ?? null);
      }
    } catch (caught) {
      setEngine({
        ok: false,
        error: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }, []);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(ENGINE_STORAGE_KEY);
    } catch {
      stored = null;
    }
    if (stored === "jevos" || stored === "ollama") {
      setProviderState(stored);
      void refreshHealth(stored);
      return;
    }
    // No local choice yet: ask the server which engine it defaults to.
    void refreshHealth();
  }, [refreshHealth]);

  const applyMove = useCallback((decision: Decision, sigBefore: string) => {
    const gameApi = gameRef.current;
    gameApi.moveTiles(
      DIR_TO_ACTION[decision.dir] as Parameters<typeof gameApi.moveTiles>[0],
    );
    moveNoRef.current += 1;
    setMoveNo(moveNoRef.current);
    setDecisions((previous) => [...previous.slice(-29), decision]);

    window.setTimeout(() => {
      if (sigRef.current === sigBefore) {
        bannedRef.current.add(sigBefore + "|" + decision.dir);
      }
      busyRef.current = false;
      setBusy(false);
      if (stepRef.current) {
        stepRef.current = false;
        runningRef.current = false;
        setRunning(false);
      }
      setTick((value) => value + 1);
    }, mergeAnimationDuration + 170);
  }, []);

  const decide = useCallback(async () => {
    if (!runningRef.current || busyRef.current) return;
    if (stateRef.current.status !== "ongoing") return;

    const tilesNow = gameRef.current.getTiles();
    const boardNow = boardFromTiles(tilesNow);
    const sigNow = tileSignature(tilesNow);
    const all = legalMoves(boardNow);

    if (all.length === 0) {
      runningRef.current = false;
      setRunning(false);
      return;
    }

    const excluded = all
      .map((move) => move.dir)
      .filter((dir) => bannedRef.current.has(sigNow + "|" + dir));
    if (excluded.length === all.length) {
      setError(
        "所有合法走法都试过但没有改变局面，已暂停。刷新页面可重置引擎状态。",
      );
      runningRef.current = false;
      setRunning(false);
      return;
    }

    busyRef.current = true;
    setBusy(true);
    setError(null);
    const runId = runIdRef.current;
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch("/api/jevos/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          board: boardNow,
          score: stateRef.current.score,
          moves: moveNoRef.current,
          mode: modeRef.current,
          provider: providerRef.current ?? undefined,
          exclude: excluded,
        }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));

      if (runId !== runIdRef.current) return;
      if (!response.ok) {
        throw new Error(
          (data && typeof data.error === "string" && data.error) ||
            "AI API returned HTTP " + response.status,
        );
      }
      if (data.gameOver) {
        runningRef.current = false;
        setRunning(false);
        busyRef.current = false;
        setBusy(false);
        return;
      }

      const decision: Decision = {
        n: moveNoRef.current + 1,
        dir: data.move.choice as Dir,
        probabilities: data.move.probabilities || {},
        confidence:
          typeof data.move.confidence === "number" ? data.move.confidence : 0,
        latencyMs: typeof data.latencyMs === "number" ? data.latencyMs : 0,
        tokens: data.usage?.input_tokens ?? 0,
        skipped: Boolean(data.skipped),
        fallback: Boolean(data.fallback),
        legal: data.legal || [],
        candidates: data.candidates || [],
        outlook: data.outlook || null,
        prompt: data.prompt || null,
        at: Date.now(),
      };

      applyMove(decision, sigNow);
    } catch (caught) {
      if (caught instanceof Error && caught.name === "AbortError") return;
      if (runId !== runIdRef.current) return;
      setError(caught instanceof Error ? caught.message : String(caught));
      runningRef.current = false;
      stepRef.current = false;
      setRunning(false);
      busyRef.current = false;
      setBusy(false);
    }
  }, [applyMove]);

  useEffect(() => {
    if (!running || busy || game.status !== "ongoing") return undefined;
    const timer = window.setTimeout(() => {
      void decide();
    }, speedMs);
    return () => window.clearTimeout(timer);
  }, [running, busy, game.status, signature, speedMs, tick, decide]);

  // If the game ends naturally, stop after a short grace period. The delay
  // leaves room for startGame() to reset a finished board.
  useEffect(() => {
    if (game.status === "ongoing" || !running) return undefined;
    const timer = window.setTimeout(() => {
      if (stateRef.current.status !== "ongoing") {
        runningRef.current = false;
        setRunning(false);
      }
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [game.status, running]);

  const start = useCallback(() => {
    setError(null);
    if (stateRef.current.status !== "ongoing") {
      moveNoRef.current = 0;
      setMoveNo(0);
      setDecisions([]);
      bannedRef.current.clear();
      gameRef.current.startGame();
    }
    runIdRef.current += 1;
    busyRef.current = false;
    setBusy(false);
    runningRef.current = true;
    setRunning(true);
    void refreshHealth();
    setTick((value) => value + 1);
  }, [refreshHealth]);

  const pause = useCallback(() => {
    runIdRef.current += 1;
    abortRef.current?.abort();
    runningRef.current = false;
    busyRef.current = false;
    setRunning(false);
    setBusy(false);
  }, []);

  const step = useCallback(() => {
    if (busyRef.current) return;
    setError(null);
    if (stateRef.current.status !== "ongoing") {
      moveNoRef.current = 0;
      setMoveNo(0);
      setDecisions([]);
      bannedRef.current.clear();
      gameRef.current.startGame();
    }
    stepRef.current = true;
    runIdRef.current += 1;
    runningRef.current = true;
    setRunning(true);
    void refreshHealth();
    setTick((value) => value + 1);
  }, [refreshHealth]);

  const restart = useCallback(() => {
    runIdRef.current += 1;
    abortRef.current?.abort();
    bannedRef.current.clear();
    moveNoRef.current = 0;
    setMoveNo(0);
    setDecisions([]);
    setError(null);
    busyRef.current = false;
    setBusy(false);
    gameRef.current.startGame();
    setTick((value) => value + 1);
  }, []);

  const clearError = useCallback(() => setError(null), []);
  const selectMode = useCallback((next: AiMode) => setMode(next), []);
  const selectSpeed = useCallback((next: number) => setSpeedMs(next), []);
  const selectProvider = useCallback(
    (next: EngineProvider) => {
      setProviderState(next);
      try {
        window.localStorage.setItem(ENGINE_STORAGE_KEY, next);
      } catch {
        // private mode / storage disabled: keep the in-memory choice only
      }
      setError(null);
      void refreshHealth(next);
    },
    [refreshHealth],
  );

  const value: AiContextValue = {
    running,
    busy,
    error,
    engine,
    engines: engine?.engines ?? [],
    provider,
    setProvider: selectProvider,
    mode,
    setMode: selectMode,
    speedMs,
    setSpeedMs: selectSpeed,
    decisions,
    last,
    moveNo,
    stats,
    start,
    pause,
    step,
    restart,
    refreshHealth: () => void refreshHealth(),
    clearError,
  };

  return <AiContext.Provider value={value}>{children}</AiContext.Provider>;
}
