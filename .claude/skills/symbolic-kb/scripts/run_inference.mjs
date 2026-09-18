#!/usr/bin/env node
/**
 * run_inference.mjs — Runs the knowledge base locally.
 *
 * @author Pavel Titov
 * @copyright 2024-2026 Able Digital Ltd
 * @license Business Source License 1.1 (see LICENSE)
 *
 * Replaces the HTTP call to AWS Lambda in KBAI's chat_controller.rb
 * (run_kbai_inference, chat_controller.rb:368-412). Instead of POSTing to a
 * Lambda Function URL, this loads the KB at runtime via load_kb.mjs (which
 * dynamically imports `rules/*.mjs` and reads `manifest.json`) and invokes the
 * resulting handler directly. No compile step, no compiled bundle.
 *
 * Usage:
 *   echo '{"fact":"contract.isValid","facts":{...}}' | node run_inference.mjs
 *   node run_inference.mjs --kb-dir .kb < input.json
 *
 * Reads JSON from stdin: { fact: string, facts: object }
 * Writes JSON to stdout: { stopReason, facts, log, result?, error? }
 */
import { loadKB } from './load_kb.mjs';

// Parse --kb-dir argument (default: .kb)
const args = process.argv.slice(2);
let kbDir = '.kb';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--kb-dir' && args[i + 1]) {
    kbDir = args[i + 1];
    i++;
  }
}

// Read JSON from stdin
const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}
const input = JSON.parse(Buffer.concat(chunks).toString());

// Load the KB (rules + manifest -> handler) and invoke it. loadKB resolves
// kbDir relative to the cwd, so both `--kb-dir .kb` and `--kb-dir /abs/path`
// work without a compile step.
const { handler } = await loadKB(kbDir);

const result = await handler({ body: JSON.stringify(input) }, {});
process.stdout.write(result.body);
