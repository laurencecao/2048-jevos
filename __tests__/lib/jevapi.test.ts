/** @jest-environment node */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { askEngine, engineHealth, resolveEngine } from "@/lib/engine";

const KEYS = [
  "JEV_API_URL",
  "JEV_API_KEY",
  "JEV_API_MODEL",
  "JEV_API_PATH",
  "JEV_API_HEALTH_PATH",
] as const;

const saved: Record<string, string | undefined> = {};
let server: Server;
let base = "";
let seen: { url?: string; auth?: string }[] = [];
let healthStatus = 200;

beforeAll(async () => {
  server = createServer((request, response) => {
    seen.push({ url: request.url, auth: request.headers.authorization });
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };

    if (request.url === "/health") {
      if (healthStatus !== 200) return json(healthStatus, { error: "nope" });
      return json(200, { status: "ok", model: "jev-cloud-1" });
    }
    if (request.url === "/v1/systemone" || request.url === "/custom") {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () =>
        json(200, {
          model: "jev-cloud-1",
          answers: {
            move: {
              choice: "left",
              confidence: 0.9,
              probabilities: { left: 0.9 },
            },
          },
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
      );
      return;
    }
    json(404, { error: "not found" });
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
  healthStatus = 200;
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("hosted jev API", () => {
  it("reports not-configured without making a request", async () => {
    const health = await engineHealth("jevapi");
    expect(health.ok).toBe(false);
    expect(health.error).toContain("JEV_API_URL");
    expect(health.hint).toContain("JEV_API_URL");
    expect(seen).toHaveLength(0);
  });

  it("requires a key even when the URL is set", async () => {
    process.env.JEV_API_URL = base;
    const health = await engineHealth("jevapi");
    expect(health.ok).toBe(false);
    expect(health.error).toContain("JEV_API_KEY");
    expect(seen).toHaveLength(0);
  });

  it("probes /health with a bearer token and reports the model", async () => {
    process.env.JEV_API_URL = base;
    process.env.JEV_API_KEY = "secret-key";

    const health = await engineHealth("jevapi");
    expect(health.ok).toBe(true);
    expect(health.transport).toBe("cloud");
    expect(health.model).toBe("jev-cloud-1");
    expect(seen[0]).toEqual({ url: "/health", auth: "Bearer secret-key" });
  });

  it("treats a missing health route as reachable", async () => {
    process.env.JEV_API_URL = base;
    process.env.JEV_API_KEY = "secret-key";
    healthStatus = 404;

    const health = await engineHealth("jevapi");
    expect(health.ok).toBe(true);
    expect(health.model).toBe("jev-latest");
  });

  it("surfaces a rejected key instead of pretending it works", async () => {
    process.env.JEV_API_URL = base;
    process.env.JEV_API_KEY = "bad-key";
    healthStatus = 401;

    const health = await engineHealth("jevapi");
    expect(health.ok).toBe(false);
    expect(health.error).toContain("rejected");
  });

  it("posts decisions to /v1/systemone with the bearer token", async () => {
    process.env.JEV_API_URL = base;
    process.env.JEV_API_KEY = "secret-key";
    process.env.JEV_API_MODEL = "jev-cloud-1";

    const answer = await askEngine("jevapi", "state: test", {
      move: { type: "choice" },
    });

    expect(answer.json.answers?.move?.choice).toBe("left");
    expect(answer.endpoint).toBe(base);
    expect(answer.engine.label).toBe("jev-api");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      url: "/v1/systemone",
      auth: "Bearer secret-key",
    });
  });

  it("lets JEV_API_PATH override the decision route", async () => {
    process.env.JEV_API_URL = base;
    process.env.JEV_API_KEY = "secret-key";
    process.env.JEV_API_PATH = "/custom";

    expect(resolveEngine("jevapi").endpoint).toBe(base);
    const answer = await askEngine("jevapi", "state: test", {
      move: { type: "choice" },
    });
    expect(answer.json.answers?.move?.choice).toBe("left");
    expect(seen[0].url).toBe("/custom");
  });
});
