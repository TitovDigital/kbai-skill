#!/usr/bin/env node
/**
 * lint_schemas.mjs — Reconciles enum conflicts across rule dependency schemas.
 *
 * @author Pavel Titov
 * @copyright 2024-2026 Pavel Titov
 *
 * Replaces the SchemaLintable concern (schema_lintable.rb) from the KBAI
 * Rails app. When multiple rules reference the same string fact with different
 * enum arrays, this script unions all values and updates each rule's schema
 * to include the complete set — ensuring backward compatibility and preventing
 * runtime validation errors.
 *
 * Usage:
 *   node lint_schemas.mjs                         # uses default .kb/
 *   node lint_schemas.mjs --kb-dir path/to/kb     # custom KB directory
 *
 * Why union instead of intersection:
 *  - Union ensures backward compatibility (existing values remain valid)
 *  - Prevents runtime errors when rules encounter previously unknown values
 *  - Allows the system to evolve as new enum values are added
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Parse --kb-dir argument (default: .kb)
const args = process.argv.slice(2);
let kbDir = '.kb';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--kb-dir' && args[i + 1]) {
    kbDir = args[i + 1];
    i++;
  }
}

const manifestPath = join(kbDir, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
const rules = manifest.rules || {};

// Phase 1: Collect all enum values per fact across all rules
const factEnumValues = {}; // { factName: { ruleName: [enum values] } }

for (const [ruleName, ruleMeta] of Object.entries(rules)) {
  const properties = ruleMeta.dependencies?.properties || {};
  for (const [factName, factSchema] of Object.entries(properties)) {
    if (factSchema && factSchema.type === 'string' && Array.isArray(factSchema.enum)) {
      if (!factEnumValues[factName]) factEnumValues[factName] = {};
      factEnumValues[factName][ruleName] = factSchema.enum;
    }
  }
}

// Phase 2: Find conflicts (same fact, different enum sets)
const conflicts = {};
for (const [factName, ruleEnums] of Object.entries(factEnumValues)) {
  const uniqueSets = Object.values(ruleEnums).map(arr => [...arr].sort().join(','));
  const uniqueCount = new Set(uniqueSets).size;
  if (uniqueCount > 1) {
    const allValues = [...new Set(Object.values(ruleEnums).flat())].sort();
    conflicts[factName] = { allValues, ruleEnums };
  }
}

// Phase 3: Reconcile — update each affected rule's schema
if (Object.keys(conflicts).length === 0) {
  console.log('No schema conflicts found.');
  process.exit(0);
}

for (const [factName, conflict] of Object.entries(conflicts)) {
  console.log(`Conflict: fact '${factName}' — unioning to [${conflict.allValues.join(', ')}]`);
  for (const [ruleName, currentEnum] of Object.entries(conflict.ruleEnums)) {
    if ([...currentEnum].sort().join(',') === conflict.allValues.join(',')) continue;
    const ruleMeta = rules[ruleName];
    ruleMeta.dependencies.properties[factName].enum = conflict.allValues;
    console.log(`  Updated rule '${ruleName}' enum from [${currentEnum.join(', ')}] to [${conflict.allValues.join(', ')}]`);
  }
}

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log('Schema linting complete.');
