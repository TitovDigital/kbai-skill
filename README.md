# kbai-skill

A self-contained template for building a **deterministic knowledge base** with symbolic reasoning, designed to run as an [Agent Skills](https://agentskills.io) standard skill (opencode, Claude Code, Codex). Rules are JavaScript functions executed by a forward-chaining inference engine locally with Node.js — no LLM is used at inference time. The agent orchestrates a feedback loop between LLM fact extraction and deterministic rule evaluation, refusing to guess when facts are ambiguous.

This repo is both a starter template (clone it, edit `.kb/`, ship) and the home of the `symbolic-kb` skill in `.claude/skills/symbolic-kb/`.

## What's in the box

- `.claude/skills/symbolic-kb/` — the skill: `SKILL.md` (full workflow reference), `inference.mjs` (engine), `scripts/` (load, run, lint, tree), `templates/rule_template.mjs`
- `.kb/` — example knowledge base: a `Contract Validity Checker` with two nested rules (`contract.isValid` → `contract.isSignedByBothParties`)

## Compatibility

Symbolic inference runs using plain Node.js

Editing is done using a skill. It follows the [Agent Skills](https://agentskills.io) standard and is compatible with opencode, Claude Code, and Codex.

## Editing the knowledge base with an agent

The skill should be discovered automatically. To add or change rules, describe them in natural language; the agent translates your description to first-order logic, writes the rule file, updates `manifest.json` (question, condition, dependencies), and lints the schemas.

Usage example in this repo:

> Show me the knowledge base in this project

(Prints explanation of the existing rules in the knowledge base)

> Add a rule: a contract is binding if it is valid and has been filed with the county.

The agent updates the knowledge base with the additional rule.

Then run the query example below to see how the updated tree executed.

## Quick start

```bash
# 1. Query with a missing fact — the engine recurses into contract.isSignedByBothParties,
#    finds contract.signedByPartyB missing, and stops (rules load at runtime, no build step)
echo '{"fact":"contract.isValid","facts":{"contract.hasNonCompete":true,"contract.signedByPartyA":true}}' \
  | node .claude/skills/symbolic-kb/scripts/run_inference.mjs --kb-dir .kb \
  | node .claude/skills/symbolic-kb/scripts/print_tree.mjs
# ▶ Inferring contract.isValid — Is the contract valid?
#   contract.hasNonCompete = true (known)
#   ▶ Inferring contract.isSignedByBothParties — Is the contract signed by both parties?
#     contract.signedByPartyA = true (known)
#     ✗ contract.signedByPartyB is missing (boolean) — Whether party B signed the contract
#   ✗ inference stopped due to contract.signedByPartyB missing
# ✗ inference stopped due to contract.signedByPartyB missing

# 2. Provide all facts — inference recurses and completes
echo '{"fact":"contract.isValid","facts":{"contract.hasNonCompete":true,"contract.signedByPartyA":true,"contract.signedByPartyB":true}}' \
  | node .claude/skills/symbolic-kb/scripts/run_inference.mjs --kb-dir .kb \
  | node .claude/skills/symbolic-kb/scripts/print_tree.mjs
# ▶ Inferring contract.isValid — Is the contract valid?
#   Rule: A contract is valid if it has a non-compete clause and is signed by both parties
#   contract.hasNonCompete = true (known)
#   ▶ Inferring contract.isSignedByBothParties — Is the contract signed by both parties?
#     Rule: A contract is signed by both parties if party A and party B both signed
#     contract.signedByPartyA = true (known)
#     contract.signedByPartyB = true (known)
#   ✓ inferred contract.isSignedByBothParties = true
# ✓ inferred contract.isValid = true
```

A `FACT_NEEDED` response is the engine refusing to guess — the orchestrating agent extracts the missing fact from the user's text and re-runs. See Workflow 2 in `SKILL.md` for the full loop.

## Knowledge base layout

```
.kb/
  manifest.json          # Rule metadata: question, condition, dependencies schema
  rules/
    <rule-name>.mjs      # One async function per file (ESM, default export). Filename IS the rule name.
  query-log.jsonl        # Append-only log of queries (written by the agent)
```

Override the KB directory with `--kb-dir <path>` on any script, or set it in `AGENTS.md`.

## Writing a rule

Copy `templates/rule_template.mjs` into `.kb/rules/<subject.predicate>.mjs`. The default-exported function takes an `infer` callback and returns a value. Use only `infer` and standard JS — no external packages.

```javascript
export default async function(infer) {
  const hasNonCompete = await infer('contract.hasNonCompete');
  const isSignedByBoth = await infer('contract.isSignedByBothParties');
  return hasNonCompete && isSignedByBoth;
}
```

Then register the rule in `manifest.json`:

```json
{
  "name": "Contract Validity Checker",
  "rules": {
    "contract.isValid": {
      "question": "Is the contract valid?",
      "condition": "A contract is valid if it has a non-compete clause and is signed by both parties",
      "dependencies": {
        "type": "object",
        "properties": {
          "contract.hasNonCompete": { "type": "boolean", "description": "Whether the contract includes a non-compete clause" },
          "contract.isSignedByBothParties": { "type": "boolean", "description": "Whether the contract is signed by both parties" }
        }
      }
    }
  }
}
```

`question` is what the rule answers; `condition` is the plain-English logic; `dependencies` is a JSON schema of facts the rule needs (used by the engine to ask for missing facts).

## Maintaining the KB

```bash
# Reconcile enum conflicts across rules that reference the same string fact
node .claude/skills/symbolic-kb/scripts/lint_schemas.mjs --kb-dir .kb
```

Rules are auto-discovered at runtime — no build step. Run `lint_schemas.mjs` after manifest enum changes.

## Deploying

There is no compiled bundle and no build step. The KB is loaded at runtime: `load_kb.mjs` reads `manifest.json`, dynamically imports `rules/*.mjs`, and wires a `handler` via `createHandler` from `inference.mjs`. To deploy, ship `.kb/` (`rules/*.mjs` + `manifest.json`) alongside `inference.mjs` and `load_kb.mjs`:

- run locally via `run_inference.mjs` (above),
- deploy to AWS Lambda — zip `.kb/` + `inference.mjs` + `load_kb.mjs` and use `loadKB(kbDir).handler` as the entry point; Lambda reads the files at cold start, no bundler needed,
- wrap in Express/HTTP for programmatic access, or
- import directly in Node.js: `import { loadKB } from './load_kb.mjs'; const { handler } = await loadKB(kbDir)`.

## Going further

The full agent workflows — natural-language-to-logic rule authoring, the fact-extraction feedback loop, and single-rule evaluation — live in `.claude/skills/symbolic-kb/SKILL.md`. Read that when you're ready to drive the KB from a conversation rather than the CLI.

<!-- Copyright 2024-2026 Pavel Titov -->
