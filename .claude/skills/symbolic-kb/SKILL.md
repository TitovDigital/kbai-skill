---
name: symbolic-kb
description: Create, maintain, and query a deterministic knowledge base with symbolic reasoning. Rules are JavaScript functions executed by a forward-chaining inference engine locally via Node.js. The agent orchestrates a feedback loop between LLM fact extraction and deterministic rule evaluation, preventing hallucinations by refusing to guess when facts are ambiguous.
compatibility: opencode, claude-code, codex
---

## Prerequisites

- Node.js
- Skill scripts at `.claude/skills/symbolic-kb/scripts/`
- Inference engine at `.claude/skills/symbolic-kb/inference.mjs`

## Configuration

All paths are defaults and can be overridden in `AGENTS.md`:

- KB directory: `.kb/` (default)
- Rule files: `<kb-dir>/rules/*.mjs`
- Manifest: `<kb-dir>/manifest.json`
- Query log: `<kb-dir>/query-log.jsonl`
- All scripts accept `--kb-dir <path>` to override

## KB File Format

```
.kb/
  manifest.json          # Metadata for all rules
  rules/
    <rule-name>.mjs      # One async function per file (ESM, default export)
  query-log.jsonl        # Append-only log of queries and results
```

### manifest.json

```json
{
  "name": "Knowledge Base Name",
  "rules": {
    "contract.isValid": {
      "question": "Is the contract valid?",
      "condition": "A contract is valid if it has a non-compete clause and is signed by both parties",
      "dependencies": {
        "type": "object",
        "properties": {
          "contract.hasNonCompete": { "type": "boolean", "description": "..." },
          "contract.isSignedByBothParties": { "type": "boolean", "description": "..." }
        }
      }
    }
  }
}
```

### Rule .mjs file

Each rule file is an ES module that exports a default `async function` taking an `infer` callback and returning a value. The filename (without `.mjs`) IS the rule name — the loader (`load_kb.mjs`) maps each `rules/*.mjs` filename to its default export, so the declared function name is irrelevant. Do **not** include `export const rules` in individual rule files; the loader builds the rules map from filenames.

```javascript
export default async function(infer) {
    const hasNonCompete = await infer('contract.hasNonCompete');
    const isSignedByBoth = await infer('contract.isSignedByBothParties');
    return hasNonCompete && isSignedByBoth;
}
```

Note: the LLM generates code with `export const rules = { ... }` as part of its output (per the code convention below), but when saving individual rule files, extract only the `async function` body and save it as the default export of a `.mjs` file. The `export const rules` mapping is used by the agent to associate function names with rule names during parsing.

---

## Workflow 1: Create or Modify Rules

When the user asks to create a knowledge base, add rules, or modify existing rules, follow this multi-step process. This mirrors KBAI's `update_rules` action: natural language is first transformed to first-order logic, then to executable JavaScript.

### Step 1: NL to First-Order Logic

Transform the user's natural-language description into first-order logic statements. Think through the logic explicitly before writing any code.

**System prompt** (follow this framing):

> You are a knowledge engineer helping to maintain a knowledge base of an expert system. The expert system is programmed in JavaScript with each knowledge base file exporting a hash of rules, mapping names of facts to the functions (rules) that resolve to them. The rule naming convention follows the `subject.predicate` pattern. Each function is async and takes one parameter, the `infer` function, allowing a rule to infer other facts by name, passed as the only parameter to `infer`. The functions must always return a value; if there's an unknown variable, it must be inferred from another fact.
>
> When writing or modifying code, only attempt to infer the facts that are either explicitly exported in the code (listed in rules) or already referred to (in which case you would assume that they're defined in other knowledge bases used by the system). If a requested modification requires inferring an unknown fact that cannot be inferred from the facts known to you, tell the user so. If you need to create a new fact that can be inferred from the facts known to you, feel free to create a new rule that does so.

### Step 2: First-Order Logic to JS Rules

Convert the first-order logic statements to JavaScript code following this convention:

> Create knowledge base rule or rules that implement the described logic. Don't make any assumptions and don't code anything for facts that are unknown, such as expected to be provided by user or added to the knowledge base later.
>
> Use the following code convention:
> ```javascript
> async function isFruit(infer) {
>     const plantName = await infer('plant.name');
>     return ['Apple', 'Pear'].includes(plantName);
> }
> export const rules = { 'plant.isFruit': isFruit };
> ```
> The code should only use `infer` and standard JS functions and classes available in Node.js and browser environments. Don't refer to any other functions or packages.

**Before generating code:**

1. Read the existing `manifest.json` to check for unresolved facts (facts referenced by existing rules but not provided by any rule). If any exist, consider whether new rules can supply them, and name accordingly.
2. Read existing rule files to determine whether to modify an existing rule or create a new one. This replaces KBAI's `get_rule` tool — you have direct file access.
3. Append the list of unresolved facts and existing rules as context when generating code.

### Step 3: Parse and Save

From the generated JavaScript code block:

1. Extract each `async function` body and its associated rule name from the `export const rules = { ... }` mapping.
2. Write each rule as `<kb-dir>/rules/<rule-name>.mjs` with the function as the default export.
3. Update `manifest.json` — add or update entries in the `rules` object.

### Step 4: Describe Each Rule

For each new or changed rule, generate metadata by reasoning through the code in three steps (mirrors KBAI's `Rule#describe!`):

**Step 4a — Predicate logic**: Convert the JavaScript code to a predicate logic representation.

**Step 4b — Condition**: Express the rule's condition in plain English, explaining how the answer is formed. Don't prefix with introductory words like "The rule states that...". Store as `condition` in the manifest.

**Step 4c — Question and dependencies**: Answer: "What question does the rule answer?" Don't prefix with introductory words. Store as `question` in the manifest.

Then generate the dependencies JSON schema: "List the facts the following rule, implemented as JavaScript code, requires to execute in a JSON schema format (with appropriate types expected)." Respond with only the JSON schema, no additional wording. Store as `dependencies` in the manifest. The schema format is:

```json
{
  "type": "object",
  "properties": {
    "fact.name": { "type": "boolean", "description": "..." },
    "other.fact": { "type": "string", "enum": ["a", "b"], "description": "..." }
  }
}
```

### Step 5: Lint Schemas

Run schema reconciliation to resolve enum conflicts across rules:

```bash
node .claude/skills/symbolic-kb/scripts/lint_schemas.mjs --kb-dir .kb
```

This ensures that if two rules define the same string fact with different `enum` arrays, the values are unioned and all schemas are updated.

---

## Workflow 2: Query the KB (Reasoning Loop)

When the user asks a question that the knowledge base can answer, follow the deterministic feedback loop. The inference engine provides the reasoning backbone; you (the agent) provide the fact extraction. The engine refuses to guess — if a fact is missing, it returns `FACT_NEEDED`, and you must extract that fact from the user's query.

This is the core value proposition: by breaking the task into focused fact-extraction steps rather than a single LLM pass, we prevent hallucinations and ensure grounded, deterministic reasoning.

### Step 1: Select the Best Rule

Read `manifest.json` and build a prompt with all available rules:

```
User Query: <user's query>

Available Rules:
- <rule.name>: <rule.question>
  Condition: <rule.condition>
  Required facts: <list of dependency fact names>

Which rule is most relevant to answering the user's query?
Respond with only the rule name, or 'NONE' if no rule matches.
```

Think as: "You are an expert at analyzing user queries and matching them to knowledge base rules. Respond with only the rule name that best matches the query, or 'NONE' if no rule is relevant."

If the result is `NONE`, generate a general response explaining what the knowledge base can help with (list all rules' questions) and suggest how to rephrase.

### Step 2: Extract Initial Facts

Given the selected rule's `question`, `condition`, and `dependencies` schema, extract all facts you can determine from the user's query:

```
Extract facts from this user query for the rule '<rule.name>'.

User Query: <user's query>
Rule Question: <rule.question>
Rule Condition: <rule.condition>

Required Facts Schema:
- <fact_name> (<type>): <description>

Extract the relevant facts as JSON. If a fact cannot be determined from the query, omit it.
```

Think as: "You are an expert at extracting structured facts from natural language text. Respond with only valid JSON."

Convert dotted fact names to underscores for internal storage (e.g., `contract.hasNonCompete` → `contract_hasNonCompete`). This matches the inference engine's `_` to `.` conversion.

### Step 3: Run the Inference Engine

```bash
echo '{"fact":"<rule.name>","facts":{<json facts>}}' | node .claude/skills/symbolic-kb/scripts/run_inference.mjs --kb-dir .kb
```

Parse the JSON output. It will have one of three `stopReason` values:

- `COMPLETED` — inference succeeded, `result` and `facts` contain the final values
- `FACT_NEEDED` — a fact is missing; `log` contains the details
- `ERROR` — an error occurred

To show the user a human-readable view, pipe the JSON through `print_tree.mjs` (it renders the log as a reasoning tree; the agent still parses the raw JSON to drive the loop):

```bash
echo '{"fact":"<rule.name>","facts":{<json facts>}}' \
  | node .claude/skills/symbolic-kb/scripts/run_inference.mjs --kb-dir .kb \
  | node .claude/skills/symbolic-kb/scripts/print_tree.mjs
```

### Step 4: If FACT_NEEDED — Resolve the Missing Fact

Find the last `FACT_NEEDED` entry in the log. It contains:
- `fact`: the missing fact name (with dots)
- `schema`: the JSON schema for this fact (type, description, enum)
- `message`: a description

Find all rules in the manifest that reference this fact (via `dependencies.properties`) for broader context. Then extract the fact from the user's original query:

```
Extract the fact '<fact_name>' from the following text:

Text: <user's original query>

Context — This fact is used in the following rules:
- Rule '<rule.name>': <rule.question>
  Condition: <rule.condition>

Expected type: <schema.type>
Description: <schema.description>

Extract the value for '<fact_name>'.
If the fact cannot be determined from the text, respond with 'UNKNOWN'.
```

Think as: "You are an expert at extracting specific facts from documents. It's ok to derive facts when straightforward (e.g., calculations) as long as it doesn't involve guessing."

If the result is `UNKNOWN` or empty, store the fact as `null` — do not guess.

### Step 4b: Type Conversion (for object/array types)

If the fact's schema type is `object` or `array`, and the extracted value is a string, perform a second conversion step:

```
Convert the following value to JSON format according to this schema:
Value: <extracted string>
Schema: <schema JSON>

Respond with only valid JSON, no markdown formatting or explanation.
```

For `boolean` type: if the fact defines whether something is present in the document and the information wasn't found, set to `false`.

For `boolean` type with simple values: `"true"`, `"yes"`, `"1"`, `"t"` → `true`; anything else → `false`.

For `number`/`integer`: parse as a float (or int).

For `string`: use the value as-is.

### Step 5: Loop Back to Step 3

Add the resolved fact to the facts object (using underscored name) and re-run the inference engine. Repeat until `COMPLETED` or `ERROR`.

**Maximum 100 iterations.** If exceeded, report a circular dependency or missing facts error.

### Step 6: If COMPLETED — Generate the Answer

```
Generate a natural language response to the user's query based on the knowledge base inference results.

User Query: <original query>
Applied Rule: <rule.name>
Rule Question: <rule.question>
Rule Condition: <rule.condition>

Facts determined:
- <fact_name>: <value>
- ...

Reasoning process:
- <RULE_COMPLETED and FACT_OBTAINED log messages>

Provide a helpful, conversational response that answers the user's question based on these results.
Explain the reasoning clearly.
```

Think as: "You are a helpful AI assistant that provides clear, accurate responses based on knowledge base inference results. Be conversational but precise."

### Step 7: Log the Query

Append a JSONL entry to `<kb-dir>/query-log.jsonl`:

```json
{"timestamp":"<ISO 8601>","query":"<user query>","rule":"<selected rule>","facts":{<final facts>},"stopReason":"COMPLETED","log":[<inference log>]}
```

---

## Workflow 3: Evaluate a Single Rule

When the user wants to test a specific rule with known facts:

1. Read the rule's `dependencies` schema from `manifest.json`.
2. Identify unresolved facts (facts the rule needs that aren't provided by other rules).
3. Ask the user for values, or accept them as arguments.
4. Run the inference engine with those facts:
   ```bash
   echo '{"fact":"<rule.name>","facts":{<json facts>}}' | node .claude/skills/symbolic-kb/scripts/run_inference.mjs --kb-dir .kb
   ```
5. Display the reasoning tree by piping through `print_tree.mjs` (renders the log as a tree of rules and premises) so the user can trace the reasoning:

   ```bash
   echo '{"fact":"<rule.name>","facts":{<json facts>}}' \
     | node .claude/skills/symbolic-kb/scripts/run_inference.mjs --kb-dir .kb \
     | node .claude/skills/symbolic-kb/scripts/print_tree.mjs
   ```

<!-- Copyright 2024-2026 Pavel Titov -->


