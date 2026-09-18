# kbai-skill

A self-contained template for building a **deterministic model** with structured reasoning. Rules are JavaScript functions executed by a forward-chaining symboling inference engine locally with Node.js — no LLM is used at inference time.

To interact with unstructured inputs, an agent can be used to orchestrate a feedback loop between LLM fact extraction and deterministic rule evaluation, refusing to guess when facts are ambiguous.

This repo contains a model knowledge base template (clone it, use the skill to modify `.kb/`, ship) and the `symbolic-kb` skill in `.claude/skills/symbolic-kb/`, which includes instructions for maintaining the knowledge base and the symbolic reasoning engine. This skill is designed to run as an [Agent Skills](https://agentskills.io) standard skill (opencode, Claude Code, Codex).

## Typical use on unstructured source data

A common practical example is where the deterministic code is responsible for making a decision, whereas LLM handles extraction of simple facts from the source unstructured data (a source document, a set of facts/state that need to be extracted from the text etc). The decision-making then runs until an answer can be determined:

1. The agent picks the rule that answers your question, and extracts the facts it can see in the document/state.
2. It runs the engine. If a fact is missing, the engine returns `FACT_NEEDED` with that fact's schema — never a guess.
3. The agent goes back to the document for that specific fact (using the schema's type and description), adds it, and re-runs.
4. Repeat until `COMPLETED`, then the agent answers with the reasoning tree attached.

### Example

In an opencode, Claude Code, or Codex session in this repo, ask:

> Here's a contract: "Acme LLC and Beta Inc. agree to a 12-month non-compete. Signed by A. Smith for Acme and J. Doe for Beta." Is it valid according to the 'symbolic-kb' skill?

The agent extracts `contract.hasNonCompete`, `contract.signedByPartyA`, `contract.signedByPartyB` from the text, runs the inference, and answers with the reasoning tree — the same one the command-line example below prints. If a fact isn't in the document (e.g., one signature is missing), the engine stops at `FACT_NEEDED` for that fact and the agent says so rather than guessing:

> ● Skill(symbolic-kb)
> Successfully loaded skill
> 
>   Searched for 1 pattern, ran 3 shell commands
> 
> Yes — valid, according to the contract.isValid rule.
> 
> Reasoning trace:
> - contract.hasNonCompete = true (12-month non-compete clause is present)
> - contract.signedByPartyA = true (A. Smith signed for Acme)
> - contract.signedByPartyB = true (J. Doe signed for Beta)
> - → contract.isSignedByBothParties = true (both signatures present)
> - → contract.isValid = true (has non-compete AND signed by both parties)

For a document on disk, point the agent at the file (attach it or give its path) and ask the same question.

## Inference without an agent

For structured inputs, the same engine can be called programmatically without an LLM or an agent:

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

A `FACT_NEEDED` response is the engine refusing to guess — supply the missing fact and re-run, or have an agent extract it from your document (see the Quick start above).

## Editing the knowledge base with an agent

To add or change rules, describe them in natural language; the agent translates your description to first-order logic, writes the rule file, updates `manifest.json` (question, condition, dependencies), and lints the schemas.

Usage example in this repo:

> Show me the knowledge base in this project

(Prints explanation of the existing rules in the knowledge base)

> Add a rule: a contract is binding if it is valid and has been filed with the county.

The agent updates the knowledge base with the additional rule.

Re-run the query example to see how the updated tree executes.

### Automatic learning

Modern agents can use the skill to automatically *build entire reasoning knowledge base from a set of a few examples*, reverse-engineering them into a decision-making model.

For example:

> Redo this knowledge base to implement logic behind writing the emails. Use relevant skill to remove all existing rules, analyse the following examples and write rules that would produce all information needed to write a welcome email from the inputs: [a set of emails and when each email was sent]

The agent would then analyze a few email examples provided and reverse-engineer how each was written and how decisions about varying the examples were made based on the input variables, producing a deterministic model capable of making decisions and writing an email brief from those input variables.

## Knowledge base layout reference

```
.kb/
  manifest.json          # Rule metadata: question, condition, dependencies schema
  rules/
    <rule-name>.mjs      # One async function per file (ESM, default export). Filename IS the rule name.
  query-log.jsonl        # Append-only log of queries (written by the agent)
```

Override the KB directory with `--kb-dir <path>` on any script, or set it in `AGENTS.md`.

### Writing a rule manually

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

### Maintaining the KB

```bash
# Reconcile enum conflicts across rules that reference the same string fact
node .claude/skills/symbolic-kb/scripts/lint_schemas.mjs --kb-dir .kb
```

Rules are auto-discovered at runtime — no build step. Run `lint_schemas.mjs` after manifest enum changes.

### Deploying

There is no compiled bundle and no build step. The KB is loaded at runtime: `load_kb.mjs` reads `manifest.json`, dynamically imports `rules/*.mjs`, and wires a `handler` via `createHandler` from `inference.mjs`. To deploy, ship `.kb/` (`rules/*.mjs` + `manifest.json`) alongside `inference.mjs` and `load_kb.mjs`:

- run locally via `run_inference.mjs` (above),
- deploy to AWS Lambda — zip `.kb/` + `inference.mjs` + `load_kb.mjs` and use `loadKB(kbDir).handler` as the entry point; Lambda reads the files at cold start, no bundler needed,
- wrap in Express/HTTP for programmatic access, or
- import directly in Node.js: `import { loadKB } from './load_kb.mjs'; const { handler } = await loadKB(kbDir)`.

## Going further

The full agent workflows — natural-language-to-logic rule authoring, the fact-extraction feedback loop, and single-rule evaluation — live in `.claude/skills/symbolic-kb/SKILL.md`. Read that when you're ready to drive the KB from a conversation rather than the CLI.
