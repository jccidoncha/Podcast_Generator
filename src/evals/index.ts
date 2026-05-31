import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@/lib/logger";
import { checkLength, checkStructure } from "./checks/structure";
import { checkGroundedness } from "./checks/groundedness";
import { judgeScript } from "./judges/llm-judge";
import { rubricVersion } from "./rubrics/script";

// Eval harness entrypoint. Run with `pnpm eval`.
//
// CLAUDE.md §9: cheap, deterministic, dry-run. Never spends API credits.
// Reads fixtures from src/evals/fixtures, runs the pipeline against each with
// stubbed providers, then runs the deterministic + judge checks against the
// resulting script.
async function main() {
  const fixturesDir = join(process.cwd(), "src/evals/fixtures");
  const entries = (await readdir(fixturesDir).catch(() => [])).filter(
    (f) => f.endsWith(".json"),
  );

  if (entries.length === 0) {
    logger.info(
      { rubricVersion },
      "no fixtures yet — add JSON fixtures to src/evals/fixtures to start scoring",
    );
    process.exit(0);
  }

  // Sketch of what runs per fixture once fixtures exist. Left commented so
  // the harness boots clean today without dragging in unused imports.
  //
  //   for (const file of entries) {
  //     const fixture = JSON.parse(await readFile(join(fixturesDir, file), "utf8"));
  //     const script = await openaiProvider.generateScript(fixture);
  //     const results = [
  //       checkStructure(script, fixture.targetLengthMin),
  //       checkLength(script, fixture.targetLengthMin),
  //       checkGroundedness(script, fixture.articles),
  //       ...await judgeScript(script),
  //     ];
  //     logger.info({ file, results }, "fixture evaluated");
  //   }

  void checkStructure;
  void checkLength;
  void checkGroundedness;
  void judgeScript;
}

main().catch((err) => {
  logger.error({ err }, "eval harness crashed");
  process.exit(1);
});
