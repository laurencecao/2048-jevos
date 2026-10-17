/**
 * Decision-engine abstraction.
 *
 * Both backends speak the same wire protocol:
 *   POST {endpoint}/v1/systemone  { model, state, questions }
 *     -> { answers, usage }
 *
 * jevos (feder-cr/jev) speaks it natively. ollama >= 0.40 exposes the same
 * route for decision models such as clef-flash:9b, and the StartLux-Decision
 * server (startlux-decide serve, GGUF on llama.cpp) serves the same TypeSafe
 * format. Switching engines therefore only changes the endpoint and the model
 * id - the prompts stay untouched.
 */

export type ProviderId = "jevos" | "ollama" | "startlux" | "startlux27b";

export type EngineConfig = {
  id: ProviderId;
  label: string;
  endpoint: string;
  model: string;
  /** Where the model runs, for the UI. */
  transport: "cpu" | "gpu";
  /** One-line fix shown when the engine is unreachable. */
  hint: string;
};

export type EngineHealth = {
  ok: boolean;
  provider: ProviderId;
  label: string;
  endpoint: string;
  model?: string;
  transport: "cpu" | "gpu";
  latencyMs?: number;
  error?: string;
  hint?: string;
};

export type SystemOneResponse = {
  model?: string;
  answers?: Record<string, any>;
  usage?: { input_tokens?: number; output_tokens?: number };
};

export const PROVIDERS: ProviderId[] = [
  "jevos",
  "ollama",
  "startlux",
  "startlux27b",
];

const DEFAULTS = {
  jevos: {
    url: "http://127.0.0.1:8017",
    model: "jev-latest",
    label: "jevos",
    transport: "cpu" as const,
    hint: "Start jevos: bash deploy/start.sh (or ./jev serve --threads 4)",
  },
  ollama: {
    url: "http://127.0.0.1:11434",
    model: "clef-flash:9b",
    label: "ollama",
    transport: "gpu" as const,
    hint: "Start ollama and pull the model: ollama pull clef-flash:9b",
  },
  startlux: {
    // startlux-decide serve fronts llama-server: 8081 is the decision API,
    // 8018 is the raw llama-server it reads probabilities from.
    url: "http://127.0.0.1:8081",
    model: "StartLux-Decision-v1.1-9B-Instant",
    label: "startlux",
    transport: "gpu" as const,
    hint: "Start the StartLux server: startlux-decide serve --model <folder> --backend llamacpp --llamacpp-url http://127.0.0.1:8018 --port 8081",
  },
  startlux27b: {
    // The 27B build runs side by side with the 9B one: llama-server on 8019,
    // decision API on 8082. Both stay resident (deploy/startlux-both.sh).
    url: "http://127.0.0.1:8082",
    model: "StartLux-Decision-v1.1-27B-Instant",
    label: "startlux-27b",
    transport: "gpu" as const,
    hint: "Start both models: bash deploy/startlux-both.sh (27B decision API on 8082)",
  },
};

const ENV_KEYS: Record<ProviderId, { url: string; model: string }> = {
  jevos: { url: "JEVOS_URL", model: "JEVOS_MODEL" },
  ollama: { url: "OLLAMA_URL", model: "OLLAMA_MODEL" },
  startlux: { url: "STARTLUX_URL", model: "STARTLUX_MODEL" },
  startlux27b: { url: "STARTLUX27_URL", model: "STARTLUX27_MODEL" },
};

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

export function isProviderId(value: unknown): value is ProviderId {
  return (
    value === "jevos" ||
    value === "ollama" ||
    value === "startlux" ||
    value === "startlux27b"
  );
}

/** AI_PROVIDER picks the server-side default; anything unknown means jevos. */
export function defaultProviderId(): ProviderId {
  const configured = (env("AI_PROVIDER") || "").toLowerCase();
  return isProviderId(configured) ? configured : "jevos";
}

export function resolveEngine(provider?: unknown): EngineConfig {
  const id: ProviderId = isProviderId(provider)
    ? provider
    : defaultProviderId();
  const fallback = DEFAULTS[id];
  const keys = ENV_KEYS[id];

  return {
    id,
    label: fallback.label,
    endpoint: (env(keys.url) || fallback.url).replace(/\/+$/, ""),
    model: env(keys.model) || fallback.model,
    transport: fallback.transport,
    hint: fallback.hint,
  };
}

export function engineList(): EngineConfig[] {
  return PROVIDERS.map((provider) => resolveEngine(provider));
}

function failure(
  engine: EngineConfig,
  started: number,
  error: string,
  hint = engine.hint,
): EngineHealth {
  return {
    ok: false,
    provider: engine.id,
    label: engine.label,
    endpoint: engine.endpoint,
    transport: engine.transport,
    latencyMs: Date.now() - started,
    error,
    hint,
  };
}

export async function engineHealth(provider?: unknown): Promise<EngineHealth> {
  const engine = resolveEngine(provider);
  const started = Date.now();

  try {
    if (engine.id === "jevos") {
      const response = await fetch(engine.endpoint + "/health", {
        cache: "no-store",
        signal: AbortSignal.timeout(3000),
      });
      const latencyMs = Date.now() - started;
      if (!response.ok) {
        return failure(engine, started, "HTTP " + response.status);
      }
      const json = await response.json().catch(() => null);
      return {
        ok: true,
        provider: engine.id,
        label: engine.label,
        endpoint: engine.endpoint,
        transport: engine.transport,
        latencyMs,
        model:
          json && typeof json.model === "string" ? json.model : engine.model,
      };
    }

    if (engine.id === "startlux" || engine.id === "startlux27b") {
      // startlux-decide answers GET /health with {"status":"ok","model":...}.
      const response = await fetch(engine.endpoint + "/health", {
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        return failure(engine, started, "HTTP " + response.status);
      }
      const json = (await response.json().catch(() => null)) as {
        status?: string;
        model?: string;
        kind?: string;
      } | null;
      if (!json || json.status !== "ok") {
        return failure(engine, started, "startlux health is not ok");
      }
      return {
        ok: true,
        provider: engine.id,
        label: engine.label,
        endpoint: engine.endpoint,
        transport: engine.transport,
        latencyMs: Date.now() - started,
        model: json.model || engine.model,
      };
    }

    // ollama: /api/version proves the daemon is up, /api/tags proves the
    // decision model is actually pulled (otherwise every move would 404).
    const version = await fetch(engine.endpoint + "/api/version", {
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    if (!version.ok) {
      return failure(engine, started, "HTTP " + version.status);
    }

    const tags = await fetch(engine.endpoint + "/api/tags", {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    const listing = await tags.json().catch(() => null);
    const names: string[] = Array.isArray(listing?.models)
      ? listing.models
          .map((entry: any) => entry?.name || entry?.model)
          .filter((name: unknown): name is string => typeof name === "string")
      : [];

    if (names.length === 0) {
      return failure(
        engine,
        started,
        "ollama is running but has no models",
        "ollama pull " + engine.model,
      );
    }
    if (!names.includes(engine.model)) {
      return failure(
        engine,
        started,
        "ollama is running but " + engine.model + " is not pulled",
        "ollama pull " + engine.model,
      );
    }

    return {
      ok: true,
      provider: engine.id,
      label: engine.label,
      endpoint: engine.endpoint,
      transport: engine.transport,
      latencyMs: Date.now() - started,
      model: engine.model,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(engine, started, message);
  }
}

export type EngineAnswer = {
  json: SystemOneResponse;
  latencyMs: number;
  endpoint: string;
  engine: EngineConfig;
};

export async function askEngine(
  provider: unknown,
  state: string,
  questions: Record<string, unknown>,
): Promise<EngineAnswer> {
  const engine = resolveEngine(provider);
  const started = Date.now();

  const body: Record<string, unknown> = {
    model: engine.model,
    state,
    questions,
  };
  if (engine.id === "ollama") {
    // Keep the 10 GB model resident between moves; a cold load takes ~110 s.
    body.keep_alive = env("OLLAMA_KEEP_ALIVE") || "30m";
  }

  // ollama may need to load the model on the first request, so allow more
  // time than jevos, which loads its model at startup. startlux reads an
  // Instant prompt in one llama.cpp pass; the first request may still wait
  // for a cold page cache.
  const timeoutMs =
    engine.id === "ollama"
      ? 180000
      : engine.id === "startlux" || engine.id === "startlux27b"
        ? 120000
        : 30000;

  let response: Response;
  try {
    response = await fetch(engine.endpoint + "/v1/systemone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(
      "cannot reach " +
        engine.label +
        " at " +
        engine.endpoint +
        " (" +
        (error instanceof Error ? error.message : String(error)) +
        ")",
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      engine.label +
        " returned HTTP " +
        response.status +
        (text ? ": " + text.slice(0, 300) : ""),
    );
  }

  const json = (await response.json()) as SystemOneResponse;
  return {
    json,
    latencyMs: Date.now() - started,
    endpoint: engine.endpoint,
    engine,
  };
}
