// Bundles ../SYSTEM_PROMPT.md into src/persona.ts so standalone mode uses the same persona.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const text = readFileSync(join(here, "..", "..", "SYSTEM_PROMPT.md"), "utf8");
writeFileSync(
  join(here, "..", "src", "persona.ts"),
  `// Generated from SYSTEM_PROMPT.md by scripts/sync-persona.mjs. Do not edit.\nexport const SYSTEM_PROMPT = ${JSON.stringify(text)};\n`,
);
