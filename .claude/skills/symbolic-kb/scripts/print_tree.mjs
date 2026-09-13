#!/usr/bin/env node
/**
 * print_tree.mjs — Pretty-prints the reasoning trace from run_inference.mjs's JSON output.
 *
 * @author Pavel Titov
 * @copyright 2024-2026 Pavel Titov
 *
 * Reads the JSON result of run_inference.mjs from stdin ({ stopReason, result, facts, log })
 * and renders the log as a human-readable, sequential explanation of the inference.
 *
 * Each rule block reads top-to-bottom:
 *   ▶ Inferring <fact> — <question>      ← the fact being inferred, highlighted
 *     Rule: <condition>                    ← the rule behind the inference, right under the header
 *     <premise> = <value> (known)          ← premises in execution order
 *     [recursively-inferred sub-rules nest here, indented one more level]
 *     ✓ inferred <fact> = <value>          ← result, its own line
 *   …or, if a premise is missing:
 *     ✗ <fact> is missing (<type>) — <description>
 *     ✗ inference stopped due to <fact> missing
 *
 * Indentation deepens only for recursive sub-rules (a rule triggering another rule) — that's
 * where the reasoning "trees"; the flat case is a plain sequential list, not a formal tree.
 * Lines are emitted in execution order within each block.
 *
 * The rule block is buffered until its RULE_COMPLETED (the condition is only logged then), so
 * the condition can be placed right under the header rather than at the end.
 *
 * Usage:
 *   echo '{"fact":"...","facts":{...}}' \
 *     | node run_inference.mjs --kb-dir .kb \
 *     | node print_tree.mjs
 *
 * Question and condition text are parsed from the engine's log message strings, whose format
 * is stable (defined in inference.mjs):
 *   RULE_STARTED:   "Inferring <fact> using rule '<question>'"
 *   RULE_COMPLETED: "Successfully inferred <fact> to be <value> using the logic: <condition>"
 */

// Read JSON from stdin (the output of run_inference.mjs).
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
let data;
try {
  data = JSON.parse(Buffer.concat(chunks).toString());
} catch (err) {
  process.stderr.write(`print_tree: could not parse stdin as JSON (${err.message})\n`);
  process.exit(1);
}

const log = data.log || [];

function parseQuestion(msg) {
  const m = msg && msg.match(/using rule '([^']+)'/);
  return m ? m[1] : null;
}
function parseCondition(msg) {
  const m = msg && msg.match(/using the logic: (.+)/);
  return m ? m[1] : null;
}

function formatValue(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

// Reconstruct the rule/premise hierarchy from the flat log. A stack of open rule nodes;
// RULE_STARTED pushes, RULE_COMPLETED pops and seals the node with its result + condition.
// Children are appended in execution order, so sub-rules land where they ran.
function buildTree(log) {
  let root = null;
  const stack = [];
  const top = () => stack[stack.length - 1];
  for (const e of log) {
    if (e.code === 'RULE_STARTED') {
      const node = { kind: 'rule', fact: e.fact, question: parseQuestion(e.message), condition: null, result: null, complete: false, children: [] };
      if (!top()) root = node; else top().children.push(node);
      stack.push(node);
    } else if (e.code === 'FACT_OBTAINED') {
      const node = { kind: 'fact', fact: e.fact, result: e.result };
      if (!top()) root = node; else top().children.push(node);
    } else if (e.code === 'RULE_COMPLETED') {
      const node = stack.pop();
      if (node) { node.result = e.result; node.complete = true; node.condition = parseCondition(e.message); }
    } else if (e.code === 'FACT_NEEDED') {
      const node = { kind: 'needed', fact: e.fact, schema: e.schema };
      if (!top()) root = node; else top().children.push(node);
    } else if (e.code === 'RULE_ERROR') {
      if (top()) top().error = e.message;
    }
  }
  return root;
}

function renderNeeded(node) {
  const s = node.schema || {};
  let line = `✗ ${node.fact} is missing`;
  if (s.type) line += ` (${s.type})`;
  if (s.description) line += ` — ${s.description}`;
  if (s.enum) line += ` [one of: ${s.enum.join(' | ')}]`;
  return line;
}

// Find the missing fact (a 'needed' node) anywhere in this rule's subtree — the engine
// stops at the first missing leaf, which may be nested several levels down a recursive
// rule chain, so an ancestor incomplete rule reports the actual missing leaf, not a
// generic placeholder.
function findMissingFact(node) {
  for (const c of node.children || []) {
    if (c.kind === 'needed') return c.fact;
    if (c.kind === 'rule') {
      const found = findMissingFact(c);
      if (found) return found;
    }
  }
  return null;
}

// Render a rule node as a block: header, the rule (condition) right under it, premises in
// execution order, then the result on its own line. `prefix` is the indent for the header;
// the block's body sits at `prefix + '  '`.
function renderRule(node, prefix, lines) {
  const inner = prefix + '  ';
  const head = node.question ? `▶ Inferring ${node.fact} — ${node.question}` : `▶ Inferring ${node.fact}`;
  lines.push(prefix + head);
  // The rule behind the inference (its condition), right after the header — only known
  // once the rule completed, which is why the block is buffered.
  if (node.condition) lines.push(inner + 'Rule: ' + node.condition);
  for (const child of node.children) {
    if (child.kind === 'fact') {
      lines.push(inner + `${child.fact} = ${formatValue(child.result)} (known)`);
    } else if (child.kind === 'needed') {
      lines.push(inner + renderNeeded(child));
    } else if (child.kind === 'rule') {
      // A recursively-inferred premise: render its block at this rule's body indent, so
      // it nests one level deeper — the only place indentation deepens.
      renderRule(child, inner, lines);
    }
  }
  // Result on its own line, at the same indent as the header — it states the outcome for
  // the same fact the header announced, so the two align.
  if (node.complete) {
    lines.push(prefix + `✓ inferred ${node.fact} = ${formatValue(node.result)}`);
  } else {
    const missing = findMissingFact(node) || 'a missing fact';
    lines.push(prefix + `✗ inference stopped due to ${missing} missing`);
  }
  if (node.error) lines.push(prefix + `✗ ${node.error}`);
}

function render(root) {
  const lines = [];
  if (!root) return lines;
  if (root.kind === 'rule') {
    renderRule(root, '', lines);
  } else if (root.kind === 'fact') {
    lines.push(`✓ ${root.fact} = ${formatValue(root.result)} (already known)`);
  } else if (root.kind === 'needed') {
    lines.push(renderNeeded(root));
  }
  return lines;
}

process.stdout.write(render(buildTree(log)).join('\n') + '\n');
