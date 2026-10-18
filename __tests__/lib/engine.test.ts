import {
  defaultProviderId,
  engineList,
  isProviderId,
  resolveEngine,
} from "@/lib/engine";

const KEYS = [
  "AI_PROVIDER",
  "JEVOS_URL",
  "JEVOS_MODEL",
  "OLLAMA_URL",
  "OLLAMA_MODEL",
  "OLLAMA27_URL",
  "OLLAMA27_MODEL",
  "STARTLUX_URL",
  "STARTLUX_MODEL",
  "STARTLUX27_URL",
  "STARTLUX27_MODEL",
  "JEV_API_URL",
  "JEV_API_KEY",
  "JEV_API_MODEL",
  "JEV_API_PATH",
  "JEV_API_HEALTH_PATH",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
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

describe("provider resolution", () => {
  it("accepts only the six supported engines", () => {
    expect(isProviderId("jevos")).toBe(true);
    expect(isProviderId("ollama")).toBe(true);
    expect(isProviderId("ollama27b")).toBe(true);
    expect(isProviderId("startlux")).toBe(true);
    expect(isProviderId("startlux27b")).toBe(true);
    expect(isProviderId("jevapi")).toBe(true);
    expect(isProviderId("openai")).toBe(false);
    expect(isProviderId(undefined)).toBe(false);
  });

  it("defaults to jevos and follows AI_PROVIDER when valid", () => {
    expect(defaultProviderId()).toBe("jevos");
    process.env.AI_PROVIDER = "ollama";
    expect(defaultProviderId()).toBe("ollama");
    process.env.AI_PROVIDER = "nonsense";
    expect(defaultProviderId()).toBe("jevos");
  });

  it("resolves the jevos engine on 8017", () => {
    const engine = resolveEngine("jevos");
    expect(engine.endpoint).toBe("http://127.0.0.1:8017");
    expect(engine.model).toBe("jev-latest");
    expect(engine.transport).toBe("cpu");
  });

  it("resolves the ollama engine on 11434 with clef-flash:9b", () => {
    const engine = resolveEngine("ollama");
    expect(engine.endpoint).toBe("http://127.0.0.1:11434");
    expect(engine.model).toBe("clef-flash:9b");
    expect(engine.transport).toBe("gpu");
  });

  it("adds the ollama 27B engine next to the 9B one on the same daemon", () => {
    const engine = resolveEngine("ollama27b");
    expect(engine.endpoint).toBe("http://127.0.0.1:11434");
    expect(engine.model).toBe("clef:27b");
    expect(engine.transport).toBe("gpu");
    expect(engine.label).toBe("ollama-27b");

    process.env.OLLAMA27_URL = "http://10.0.2.160:11434";
    process.env.OLLAMA27_MODEL = "clef:27b-q4";
    const custom = resolveEngine("ollama27b");
    expect(custom.endpoint).toBe("http://10.0.2.160:11434");
    expect(custom.model).toBe("clef:27b-q4");

    // The 9B ollama engine keeps its own model and endpoint.
    expect(resolveEngine("ollama").model).toBe("clef-flash:9b");
    expect(resolveEngine("ollama").endpoint).toBe("http://127.0.0.1:11434");
  });

  it("resolves the startlux server on 8081", () => {
    const engine = resolveEngine("startlux");
    expect(engine.endpoint).toBe("http://127.0.0.1:8081");
    expect(engine.model).toBe("StartLux-Decision-v1.1-9B-Instant");
    expect(engine.transport).toBe("gpu");
  });

  it("keeps the 27B build available next to the 9B one on 8082", () => {
    const engine = resolveEngine("startlux27b");
    expect(engine.endpoint).toBe("http://127.0.0.1:8082");
    expect(engine.model).toBe("StartLux-Decision-v1.1-27B-Instant");
    expect(engine.transport).toBe("gpu");

    process.env.STARTLUX27_URL = "http://10.0.2.160:8082";
    process.env.STARTLUX27_MODEL = "StartLux-Decision-v1.1-27B-Instant-Q4_K_M";
    const custom = resolveEngine("startlux27b");
    expect(custom.endpoint).toBe("http://10.0.2.160:8082");
    expect(custom.model).toBe("StartLux-Decision-v1.1-27B-Instant-Q4_K_M");

    // The 9B engine must not pick up the 27B overrides.
    expect(resolveEngine("startlux").endpoint).toBe("http://127.0.0.1:8081");
  });

  it("honours STARTLUX_URL and STARTLUX_MODEL", () => {
    process.env.STARTLUX_URL = "http://10.0.2.160:8081/";
    process.env.STARTLUX_MODEL = "startlux-decision-9b";
    const engine = resolveEngine("startlux");
    expect(engine.endpoint).toBe("http://10.0.2.160:8081");
    expect(engine.model).toBe("startlux-decision-9b");
  });

  it("honours env overrides and normalises trailing slashes", () => {
    process.env.OLLAMA_URL = "http://127.0.0.1:11434///";
    process.env.OLLAMA_MODEL = "clef-flash:27b";
    const engine = resolveEngine("ollama");
    expect(engine.endpoint).toBe("http://127.0.0.1:11434");
    expect(engine.model).toBe("clef-flash:27b");
  });

  it("falls back to the default provider for unknown ids", () => {
    process.env.AI_PROVIDER = "ollama";
    expect(resolveEngine("bogus").id).toBe("ollama");
    expect(resolveEngine(undefined).id).toBe("ollama");
  });

  it("keeps jev-api unconfigured until the operator supplies .env values", () => {
    const engine = resolveEngine("jevapi");
    expect(engine.endpoint).toBe("");
    expect(engine.model).toBe("jev-latest");
    expect(engine.transport).toBe("cloud");
    expect(engine.hint).toContain("JEV_API_URL");
    // The key is read per request, never stored on the engine descriptor.
    expect("apiKey" in engine).toBe(false);
  });

  it("honours JEV_API_URL / JEV_API_KEY / JEV_API_MODEL", () => {
    process.env.JEV_API_URL = "https://api.example.com/";
    process.env.JEV_API_KEY = "secret-key";
    process.env.JEV_API_MODEL = "jev-test";

    const engine = resolveEngine("jevapi");
    expect(engine.endpoint).toBe("https://api.example.com");
    expect(engine.model).toBe("jev-test");
    expect(engine.transport).toBe("cloud");

    // The other engines must not pick up the hosted API settings.
    expect(resolveEngine("jevos").endpoint).toBe("http://127.0.0.1:8017");
    expect(resolveEngine("jevos").model).toBe("jev-latest");
  });

  it("lists all six engines", () => {
    const engines = engineList();
    expect(engines.map((engine) => engine.id)).toEqual([
      "jevos",
      "ollama",
      "ollama27b",
      "startlux",
      "startlux27b",
      "jevapi",
    ]);
  });
});
