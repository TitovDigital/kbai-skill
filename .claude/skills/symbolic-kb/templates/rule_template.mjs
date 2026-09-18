/**
 * Rule template for the symbolic-kb skill.
 *
 * @author Pavel Titov
 * @copyright 2024-2026 Able Digital Ltd
 * @license Business Source License 1.1 (see LICENSE)
 */

// Rule template — copy this pattern when creating a new rule.
//
// Naming convention: subject.predicate (e.g., contract.isValid)
// Each rule is an async function that takes one parameter: the `infer` callback.
// Call infer('fact.name') to resolve a fact — either from known facts or by
// triggering another rule. Rules must always return a value.
// Only use `infer` and standard JS available in Node.js — no external packages.
//
// The file name IS the rule name (dots preserved). The loader maps the filename
// to the default export, so the declared function name is irrelevant. Do NOT
// include `export const rules` — the loader builds the rules map from filenames.

export default async function(infer) {
    const someFact = await infer('some.fact');
    return someFact === 'expected value';
}
