/**
 * load_kb.mjs — Dynamic KB loader.
 *
 * @author Pavel Titov
 * @copyright 2024-2026 Pavel Titov
 *
 * Replaces compile_kb.mjs. Instead of concatenating rule files + engine into a
 * bundle, this reads the KB at runtime: it reads `manifest.json`, dynamically
 * imports each `rules/*.mjs` file (mapping the filename to its default export),
 * and wires the result into a handler via `createHandler` from the engine.
 *
 * The engine (../inference.mjs) and this loader live in the skill dir; the KB
 * (`rules/` + `manifest.json`) is pure data, located by `kbDir`. No compile
 * step, no generated bundle, no stale artifacts — edit a rule and re-run.
 *
 * Usage (imported by run_inference.mjs):
 *   const { handler } = await loadKB(kbDir)
 *
 * Rule files are ESM modules exporting a default async function:
 *   export default async function(infer) { ... }
 * The rule name IS the filename (minus `.mjs`); the declared function name is
 * irrelevant. Files are imported via `file://` URLs so imports resolve the same
 * on POSIX and Windows regardless of the cwd.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHandler } from '../inference.mjs';

export async function loadKB(kbDir) {
  const manifestPath = resolve(kbDir, 'manifest.json');
  const rulesDir = resolve(kbDir, 'rules');

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

  // Dynamically import each rule file. The rule name is the filename without
  // `.mjs` (e.g., `contract.isValid.mjs` -> rule `contract.isValid`). Each file
  // must export a default async function(infer); the loader maps the filename
  // to that export, so the declared function name doesn't matter.
  const rules = {};
  for (const file of readdirSync(rulesDir).filter(f => f.endsWith('.mjs')).sort()) {
    const ruleName = file.replace(/\.mjs$/, '');
    const fileURL = pathToFileURL(join(rulesDir, file)).href;
    const mod = await import(fileURL);
    if (typeof mod.default !== 'function') {
      throw new Error(`Rule file '${file}' must export a default async function(infer)`);
    }
    rules[ruleName] = mod.default;
  }

  // Build rule descriptions from the manifest; the engine uses these for
  // logging (RULE_STARTED/RULE_COMPLETED messages and FACT_NEEDED schemas).
  const ruleDescriptions = {};
  for (const [name, meta] of Object.entries(manifest.rules || {})) {
    ruleDescriptions[name] = {
      question: meta.question,
      condition: meta.condition,
      dependencies: meta.dependencies,
    };
  }

  return { handler: createHandler(rules, ruleDescriptions) };
}
