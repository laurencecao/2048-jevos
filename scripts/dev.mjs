#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const LOCAL_JEVOS = path.join(process.cwd(), ".jevos", "jev");
const JEVOS_DIR =
  process.env.JEVOS_DIR ||
  (existsSync(LOCAL_JEVOS) ? LOCAL_JEVOS : "/tmp/jev-macos/jev");
const JEVOS_BIN = process.env.JEVOS_BIN || path.join(JEVOS_DIR, "jev");
const JEVOS_URL = (process.env.JEVOS_URL || "http://127.0.0.1:8017").replace(
  /\/+$/,
  "",
);
const PORT = process.env.PORT || "3000";
const THREADS = process.env.JEVOS_THREADS || "4";

async function healthy() {
  try {
    const response = await fetch(JEVOS_URL + "/health", {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await healthy()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

let jevos = null;
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (jevos) {
    jevos.kill("SIGINT");
    jevos = null;
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

if (await healthy()) {
  console.log("[dev] jevos already running at " + JEVOS_URL);
} else {
  if (!existsSync(JEVOS_BIN)) {
    console.error(
      "[dev] jevos binary not found: " +
        JEVOS_BIN +
        "\n[dev] Set JEVOS_DIR (or JEVOS_BIN), or start jevos yourself.\n" +
        "[dev] Install: download jev-macos-arm64.tar.gz + jevos-v5-openvino-int8.zip from\n" +
        "[dev] https://github.com/feder-cr/jev/releases and unzip the model into jev/model/.",
    );
    process.exit(1);
  }

  console.log(
    "[dev] starting jevos: " + JEVOS_BIN + " serve --threads " + THREADS,
  );
  jevos = spawn(JEVOS_BIN, ["serve", "--threads", THREADS], {
    cwd: JEVOS_DIR,
    stdio: "inherit",
  });
  jevos.on("exit", (code) => {
    if (!shuttingDown) {
      console.error("[dev] jevos exited with code " + code);
      shutdown(code ?? 1);
    }
  });

  if (!(await waitForHealth())) {
    console.error("[dev] jevos did not become ready within 60s");
    shutdown(1);
  }
  console.log("[dev] jevos ready at " + JEVOS_URL);
}

const localNext = path.join(
  process.cwd(),
  "node_modules",
  "next",
  "dist",
  "bin",
  "next",
);
const nextCommand = existsSync(localNext)
  ? { command: process.execPath, args: [localNext, "dev", "-p", PORT] }
  : { command: "npx", args: ["next", "dev", "-p", PORT] };

console.log("[dev] starting Next.js on http://localhost:" + PORT);
const next = spawn(nextCommand.command, nextCommand.args, {
  stdio: "inherit",
  env: process.env,
});

next.on("exit", (code) => {
  shutdown(code ?? 0);
});
