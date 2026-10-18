/**
 * Decision-engine abstraction.
 *
 * Both backends speak the same wire protocol:
 *   POST {endpoint}/v1/systemone  { model, state, questions }
 *     -> { answers, usage }
 *
 * jevos (feder-cr/jev) speaks it natively. ollama >= 0.40 exposes the same
 * route for decision models such as clef-flash:9b and clef:27b, and the
 * StartLux-Decision server (startlux-decide serve, GGUF on llama.cpp) serves
 * the same TypeSafe format. Switching engines therefore only changes the
 * endpoint and the model id - the prompts stay untouched.
 *
 * jevapi is the hosted Jev API. It speaks the same wire protocol, but its
 * base URL and bearer token have no sensible default, so both are left empty
 * on purpose: whoever runs the deployment supplies them in .env.
 *
 * A hosted endpoint may also be geo-fenced (api.typesafe.ai answers HTTP 451
 * outside its allowed regions). Node's global fetch ignores HTTPS_PROXY, so
 * the hosted engine honours JEV_API_PROXY and tunnels through it explicitly.
 */

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

export type ProviderId =
  | "jevos"
  | "ollama"
  | "ollama27b"
  | "startlux"
  | "startlux27b"
  | "jevapi";

export type EngineConfig = {
  id: ProviderId;
  label: string;
  endpoint: string;
  model: string;
  /** Where the model runs, for the UI. */
  transport: "cpu" | "gpu" | "cloud";
  /** One-line fix shown when the engine is unreachable. */
  hint: string;
};

export type EngineHealth = {
  ok: boolean;
  provider: ProviderId;
  label: string;
  endpoint: string;
  model?: string;
  transport: "cpu" | "gpu" | "cloud";
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
  "ollama27b",
  "startlux",
  "startlux27b",
  "jevapi",
];

/** Shown whenever the hosted API is missing its operator-supplied settings. */
const JEV_API_HINT =
  "Set JEV_API_URL and JEV_API_KEY in .env, then restart the app (see .env.example)";

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
  ollama27b: {
    // Same daemon as ollama, a different decision model: clef:27b is 27B
    // Q4_K_M (~18 GB), so on 4x A2 it needs the layers spread over several
    // GPUs (deploy/ollama-gpu.sh) instead of a single card.
    url: "http://127.0.0.1:11434",
    model: "clef:27b",
    label: "ollama-27b",
    transport: "gpu" as const,
    hint: "ollama pull clef:27b, then spread it over the GPUs: bash deploy/ollama-gpu.sh apply",
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
  jevapi: {
    // Hosted Jev API. No default URL and no default key: the operator of this
    // deployment sets JEV_API_URL + JEV_API_KEY in .env. An empty endpoint
    // keeps the engine visible in the picker while health reports why it is
    // not usable yet.
    url: "",
    model: "jev-latest",
    label: "jev-api",
    transport: "cloud" as const,
    hint: JEV_API_HINT,
  },
};

const ENV_KEYS: Record<ProviderId, { url: string; model: string }> = {
  jevos: { url: "JEVOS_URL", model: "JEVOS_MODEL" },
  ollama: { url: "OLLAMA_URL", model: "OLLAMA_MODEL" },
  ollama27b: { url: "OLLAMA27_URL", model: "OLLAMA27_MODEL" },
  startlux: { url: "STARTLUX_URL", model: "STARTLUX_MODEL" },
  startlux27b: { url: "STARTLUX27_URL", model: "STARTLUX27_MODEL" },
  jevapi: { url: "JEV_API_URL", model: "JEV_API_MODEL" },
};

/** Decision route. Hosted deployments occasionally mount it elsewhere. */
function decisionPath(id: ProviderId): string {
  if (id === "jevapi") return env("JEV_API_PATH") || "/v1/systemone";
  return "/v1/systemone";
}

/** Bearer auth for the hosted API. The key is read per request and never
 * stored on EngineConfig, so no API response can echo it back. */
function authHeaders(id: ProviderId): Record<string, string> {
  if (id !== "jevapi") return {};
  const key = env("JEV_API_KEY");
  return key ? { Authorization: "Bearer " + key } : {};
}

function jevApiConfigured(): boolean {
  return Boolean(env("JEV_API_URL") && env("JEV_API_KEY"));
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

type CloudResult = { status: number; ok: boolean; text: string; json: unknown };

/** Egress proxy for the hosted engine. Node's fetch ignores these vars. */
function jevApiProxy(): string | undefined {
  return env("JEV_API_PROXY") || env("HTTPS_PROXY") || env("https_proxy");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * An https.Agent that opens a CONNECT tunnel through an HTTP proxy and then
 * runs TLS inside it. Kept dependency-free on purpose: the proxy is an
 * optional deployment detail, not a runtime requirement of the app.
 */
function tunnelAgent(proxy: string): https.Agent {
  const url = new URL(proxy);
  const proxyPort = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
  const agent = new https.Agent({ keepAlive: false }) as https.Agent & {
    createConnection?: unknown;
  };
  agent.createConnection = (
    options: { host?: string; port?: number | string; servername?: string },
    callback: (error: Error | null, socket?: tls.TLSSocket) => void,
  ) => {
    const target = options.host + ":" + (Number(options.port) || 443);
    const headers: Record<string, string> = { Host: target };
    if (url.username || url.password) {
      const credentials =
        decodeURIComponent(url.username) +
        ":" +
        decodeURIComponent(url.password);
      headers["Proxy-Authorization"] =
        "Basic " + Buffer.from(credentials).toString("base64");
    }
    const connect = http.request({
      host: url.hostname,
      port: proxyPort,
      method: "CONNECT",
      path: target,
      headers,
    });
    connect.once("connect", (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        callback(
          new Error("proxy CONNECT failed: HTTP " + response.statusCode),
        );
        return;
      }
      // SNI cannot carry an IP address; local/plain hosts omit it.
      const servername = options.servername || options.host || "";
      const secured = tls.connect({
        socket,
        servername: net.isIP(servername) ? undefined : servername,
      });
      secured.once("secureConnect", () => callback(null, secured));
      secured.once("error", (error: Error) => callback(error));
    });
    connect.once("error", (error: Error) => callback(error));
    connect.end();
    return undefined;
  };
  return agent;
}

/**
 * One HTTP call to the hosted API. Uses the plain global fetch unless an egress
 * proxy is configured; then it tunnels through the proxy with node:https.
 */
async function cloudRequest(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs: number;
  },
): Promise<CloudResult> {
  const target = new URL(url);
  // Plain-HTTP endpoints (local test servers, dev gateways) never need the
  // egress proxy; it exists for geo-fenced HTTPS hosts.
  const proxy = target.protocol === "https:" ? jevApiProxy() : undefined;
  if (!proxy) {
    const response = await fetch(url, {
      method: init.method || "GET",
      headers: init.headers,
      body: init.body,
      cache: "no-store",
      signal: AbortSignal.timeout(init.timeoutMs),
    });
    const text = await response.text().catch(() => "");
    return {
      status: response.status,
      ok: response.ok,
      text,
      json: parseJson(text),
    };
  }

  return await new Promise<CloudResult>((resolve, reject) => {
    const headers: Record<string, string> = { ...(init.headers || {}) };
    if (init.body)
      headers["Content-Length"] = String(Buffer.byteLength(init.body));
    const request = https.request(
      {
        host: target.hostname,
        port: Number(target.port) || 443,
        path: target.pathname + target.search,
        method: init.method || "GET",
        headers,
        agent: tunnelAgent(proxy),
        timeout: init.timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = response.statusCode || 0;
          resolve({
            status,
            ok: status >= 200 && status < 300,
            text,
            json: parseJson(text),
          });
        });
      },
    );
    request.on("timeout", () => {
      request.destroy(new Error("timed out after " + init.timeoutMs + " ms"));
    });
    request.on("error", (error: Error) => reject(error));
    if (init.body) request.write(init.body);
    request.end();
  });
}

export function isProviderId(value: unknown): value is ProviderId {
  return (
    value === "jevos" ||
    value === "ollama" ||
    value === "ollama27b" ||
    value === "startlux" ||
    value === "startlux27b" ||
    value === "jevapi"
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
  const endpoint = (env(keys.url) || fallback.url).replace(/\/+$/, "");

  return {
    id,
    label: fallback.label,
    endpoint,
    model: env(keys.model) || fallback.model,
    transport: fallback.transport,
    hint:
      id === "jevapi" && (!endpoint || !env("JEV_API_KEY"))
        ? JEV_API_HINT
        : fallback.hint,
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

    if (engine.id === "jevapi") {
      if (!engine.endpoint) {
        return failure(
          engine,
          started,
          "JEV_API_URL is not configured",
          JEV_API_HINT,
        );
      }
      if (!jevApiConfigured()) {
        return failure(
          engine,
          started,
          "JEV_API_KEY is not configured",
          JEV_API_HINT,
        );
      }

      // Hosted APIs rarely expose /health. Probe it when present, but treat
      // 404/405 as "the host answered, there is just no health route".
      const probe = await cloudRequest(
        engine.endpoint + (env("JEV_API_HEALTH_PATH") || "/health"),
        { headers: authHeaders("jevapi"), timeoutMs: 8000 },
      );
      const latencyMs = Date.now() - started;

      if (probe.status === 451) {
        return failure(
          engine,
          started,
          "blocked in this region (HTTP 451)",
          "Set JEV_API_PROXY=http://host:port (.env) so this host can egress elsewhere, or point JEV_API_URL at a reachable gateway",
        );
      }
      if (probe.status === 401 || probe.status === 403) {
        return failure(
          engine,
          started,
          "JEV_API_KEY was rejected (HTTP " + probe.status + ")",
          "Check JEV_API_KEY in .env",
        );
      }
      if (probe.status === 404 || probe.status === 405) {
        return {
          ok: true,
          provider: engine.id,
          label: engine.label,
          endpoint: engine.endpoint,
          transport: engine.transport,
          latencyMs,
          model: engine.model,
        };
      }
      if (!probe.ok) {
        return failure(engine, started, "HTTP " + probe.status);
      }

      const json = probe.json as { model?: string; status?: string } | null;
      return {
        ok: true,
        provider: engine.id,
        label: engine.label,
        endpoint: engine.endpoint,
        transport: engine.transport,
        latencyMs,
        model: json?.model || engine.model,
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

    // ollama + ollama27b: /api/version proves the daemon is up, /api/tags
    // proves the decision model is actually pulled (otherwise every move
    // would 404). Both engines talk to the same daemon by default.
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

  if (engine.id === "jevapi") {
    if (!engine.endpoint) {
      throw new Error(
        "JEV_API_URL is not configured (set it in .env and restart the app)",
      );
    }
    if (!env("JEV_API_KEY")) {
      throw new Error(
        "JEV_API_KEY is not configured (set it in .env and restart the app)",
      );
    }
  }

  const body: Record<string, unknown> = {
    model: engine.model,
    state,
    questions,
  };
  if (engine.id === "ollama" || engine.id === "ollama27b") {
    // Keep the decision model resident between moves; a cold load of the 9B
    // takes ~110 s, the 27B takes a few minutes. OLLAMA27_KEEP_ALIVE wins for
    // the 27B engine, OLLAMA_KEEP_ALIVE stays the shared fallback.
    const keepAlive =
      engine.id === "ollama27b"
        ? env("OLLAMA27_KEEP_ALIVE") || env("OLLAMA_KEEP_ALIVE")
        : env("OLLAMA_KEEP_ALIVE");
    body.keep_alive = keepAlive || "30m";
  }

  // ollama may need to load the model on the first request, so allow more
  // time than jevos, which loads its model at startup. startlux reads an
  // Instant prompt in one llama.cpp pass; the first request may still wait
  // for a cold page cache.
  const timeoutMs =
    engine.id === "ollama"
      ? 180000
      : engine.id === "ollama27b"
        ? 300000
        : engine.id === "startlux" ||
            engine.id === "startlux27b" ||
            engine.id === "jevapi"
          ? 120000
          : 30000;

  let result: CloudResult;
  try {
    const endpoint = engine.endpoint + decisionPath(engine.id);
    const headers = {
      "Content-Type": "application/json",
      ...authHeaders(engine.id),
    };
    const payload = JSON.stringify(body);
    result =
      engine.id === "jevapi"
        ? await cloudRequest(endpoint, {
            method: "POST",
            headers,
            body: payload,
            timeoutMs,
          })
        : await (async () => {
            const response = await fetch(endpoint, {
              method: "POST",
              headers,
              body: payload,
              cache: "no-store",
              signal: AbortSignal.timeout(timeoutMs),
            });
            const text = await response.text().catch(() => "");
            return {
              status: response.status,
              ok: response.ok,
              text,
              json: parseJson(text),
            };
          })();
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

  if (result.status === 451) {
    throw new Error(
      engine.label +
        " is blocked in this region (HTTP 451) - set JEV_API_PROXY in .env or use a reachable gateway",
    );
  }
  if (!result.ok) {
    throw new Error(
      engine.label +
        " returned HTTP " +
        result.status +
        (result.text ? ": " + result.text.slice(0, 300) : ""),
    );
  }

  const json = result.json as SystemOneResponse;
  return {
    json,
    latencyMs: Date.now() - started,
    endpoint: engine.endpoint,
    engine,
  };
}
