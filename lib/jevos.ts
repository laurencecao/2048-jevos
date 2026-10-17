export type JevosHealth = {
  ok: boolean;
  endpoint: string;
  model?: string;
  latencyMs?: number;
  error?: string;
};

export type JevosResponse = {
  model?: string;
  answers?: Record<string, any>;
  usage?: { input_tokens?: number; output_tokens?: number };
};

export function jevosEndpoint(): string {
  return (process.env.JEVOS_URL || "http://127.0.0.1:8017").replace(/\/+$/, "");
}

export async function jevosHealth(): Promise<JevosHealth> {
  const endpoint = jevosEndpoint();
  const started = Date.now();
  try {
    const response = await fetch(endpoint + "/health", {
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      return {
        ok: false,
        endpoint,
        latencyMs,
        error: "HTTP " + response.status,
      };
    }
    const json = await response.json().catch(() => null);
    return {
      ok: true,
      endpoint,
      latencyMs,
      model: json && typeof json.model === "string" ? json.model : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      endpoint,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function askJevos(
  state: string,
  questions: Record<string, unknown>,
): Promise<{ json: JevosResponse; latencyMs: number; endpoint: string }> {
  const endpoint = jevosEndpoint();
  const started = Date.now();
  let response: Response;

  try {
    response = await fetch(endpoint + "/v1/systemone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.JEVOS_MODEL || "jev-latest",
        state,
        questions,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(25000),
    });
  } catch (error) {
    throw new Error(
      "cannot reach jevos at " +
        endpoint +
        " (" +
        (error instanceof Error ? error.message : String(error)) +
        ")",
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      "jevos returned HTTP " +
        response.status +
        (text ? ": " + text.slice(0, 200) : ""),
    );
  }

  const json = (await response.json()) as JevosResponse;
  return { json, latencyMs: Date.now() - started, endpoint };
}
