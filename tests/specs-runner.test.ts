import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { buildBot } from "../src/bot.js";
import {
  parseBotSpecs,
  runSpec,
  computeCoverage,
  formatSuiteResult,
  type BotSpec,
  type SuiteResult,
} from "../src/toolkit/index.js";
import { _reset, _setToday } from "../src/standup/store.js";

// The objective-gate runner, locally: glob every tests/specs/*.json, run each
// spec against a FRESH bot, and (crucially) RESET the durable store before each
// spec so they're isolated — the same isolation the platform harness gets from a
// fresh process. Also assert command coverage == 1 (every declared command has a
// meaningful spec).

const specsDir = new URL("./specs/", import.meta.url);
const commandsDir = new URL("./commands/", import.meta.url);

function loadSpecs(): { file: string; specs: BotSpec[] }[] {
  return readdirSync(specsDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => ({
      file,
      specs: parseBotSpecs(JSON.parse(readFileSync(new URL(file, specsDir), "utf8"))),
    }));
}

function loadDeclaredCommands(): string[] {
  return readdirSync(commandsDir)
    .filter((f) => f.endsWith(".json"))
    .flatMap((file) => JSON.parse(readFileSync(new URL(file, commandsDir), "utf8")) as string[]);
}

describe("tests/specs/*.json objective gate", () => {
  it("every spec passes against a fresh, reset bot", async () => {
    const files = loadSpecs();
    const results = [];
    for (const { specs } of files) {
      for (const spec of specs) {
        _reset();
        _setToday("2026-06-28");
        const bot = await buildBot("test-token");
        results.push(await runSpec(bot, spec));
      }
    }
    const suite: SuiteResult = {
      total: results.length,
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
    if (suite.failed > 0) console.error(formatSuiteResult(suite));
    expect(suite.failed).toBe(0);
    expect(suite.passed).toBeGreaterThan(0);
  });

  it("every declared command is covered by a meaningful spec", () => {
    const allSpecs = loadSpecs().flatMap((f) => f.specs);
    const declared = loadDeclaredCommands();
    const coverage = computeCoverage(allSpecs, declared);
    expect(coverage.missing).toEqual([]);
    expect(coverage.fraction).toBe(1);
  });
});
