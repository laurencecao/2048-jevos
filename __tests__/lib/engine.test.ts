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
  it("accepts only the two supported engines", () => {
    expect(isProviderId("jevos")).toBe(true);
    expect(isProviderId("ollama")).toBe(true);
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

  it("lists both engines", () => {
    const engines = engineList();
    expect(engines.map((engine) => engine.id)).toEqual(["jevos", "ollama"]);
  });
});
