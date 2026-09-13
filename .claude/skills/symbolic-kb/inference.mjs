/**
 * Inference engine — forward-chaining rule evaluator.
 *
 * @author Pavel Titov
 * @copyright 2024-2026 Pavel Titov
 *
 * Adapted from lib/public_js/inference.js in the KBAI codebase.
 *
 * The engine is rule-source-agnostic: `createHandler(rules, ruleDescriptions)`
 * returns a Lambda-shaped `handler(event, context)` that closes over the given
 * rules and descriptions. A loader (load_kb.mjs) builds those from the KB's
 * `rules/*.mjs` + `manifest.json` at runtime, so there is no compile/bundle step
 * for local execution. For Lambda, zip the KB + this engine + the loader; no
 * bundler is needed.
 */
export class Inference {
  /**
   * @param {object} rules - Knowledge base: fact name -> async function(infer)
   * @param {object} facts - Initial known facts
   * @param {object} [ruleDescriptions] - Metadata for logging: { name: { question, condition, dependencies } }
   */
  constructor(rules, facts, ruleDescriptions = {}) {
    if (!rules)
      throw new Error("Rules must be defined")
    if (!facts)
      throw new Error("Facts must be defined")
    this.rules = rules
    this.facts = facts
    this.ruleDescriptions = ruleDescriptions
    /** Log of inference events */
    this.log = []
  }

  infer(fact) {
    if (this.facts[fact] !== undefined) {
      this.log.push({
        code: 'FACT_OBTAINED',
        message: `Using known ${fact} (${this.facts[fact]})`,
        fact,
        result: this.facts[fact]
      })
      return Promise.resolve(this.facts[fact])
    } else {
      // Wrap this in a Promise to ensure consistent error handling
      return Promise.resolve().then(() => {
        return this.#inferUsingRule(fact)
      })
    }
  }

  /**
   * Executes a rule to infer a fact value.
   * If no rule exists for the fact, logs FACT_NEEDED with the parent rule's
   * dependency schema so the orchestrating agent knows what to extract.
   * @param {string} fact - The fact to infer
   * @returns {Promise} Promise that resolves to the inferred fact value
   * @throws {Error} Throws error if inference fails or a fact is missing
   * @private
   */
  #inferUsingRule(fact) {
    if (!this.rules[fact]) {
      const message = `Inference stopped due to unknown fact, re-run with fact ${fact} provided`
      // Find the most recent RULE_STARTED log entry that has this fact as a dependency
      const parentRule = this.log.slice().reverse().find(log =>
        log.code === 'RULE_STARTED' &&
        log.dependencies?.properties?.[fact] !== undefined
      )
      this.log.push({
        code: 'FACT_NEEDED',
        message,
        fact,
        schema: parentRule?.dependencies?.properties[fact],
      })
      // Return a rejected promise instead of throwing directly
      return Promise.reject(new Error(message))
    }

    this.log.push({
      code: 'RULE_STARTED',
      message: `Inferring ${fact} using rule '${this.ruleDescriptions[fact]?.question}'`,
      fact,
      dependencies: this.ruleDescriptions[fact]?.dependencies,
    })

    return this.rules[fact](this.infer.bind(this)).then(result => {
      this.facts[fact] = result
      this.log.push({
        code: 'RULE_COMPLETED',
        message: `Successfully inferred ${fact} to be ${JSON.stringify(result)} using the logic: ${this.ruleDescriptions[fact]?.condition}`,
        fact,
        result
      })
      return result
    }).catch(error => {
      if (this.log.length > 0 && this.log[this.log.length-1].code !== 'FACT_NEEDED')
        this.log.push({
          code: 'RULE_ERROR',
          message: `Error inferring ${fact}: ${error.message}`,
          fact,
        })
      throw error
    })
  }
}

/**
 * Factory for a request handler. The returned handler accepts the same event
 * shape as AWS Lambda ({ body: JSON string }), so the same handler runs locally
 * via run_inference.mjs or as a Lambda entry point.
 *
 * Input event body: { fact: string, facts: object }
 * Response body: { stopReason: 'COMPLETED'|'FACT_NEEDED'|'ERROR', facts, log, result?, error? }
 */
export function createHandler(rules, ruleDescriptions) {
  return async (event, context) => {
    let request = {}
    if (event.body && event.body.length > 0) {
      try {
        request = JSON.parse(event.body)
      } catch (error) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Unable to parse request body: ' + error.message })
        }
      }
    }

    if (!request.fact || request.fact.length === 0)
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Fact to infer must be specified' })
      }

    // Replace underscores with dots for compatibility with Copilot Studio
    // that doesn't support dots in field names
    const requestFacts = Object.fromEntries(Object.entries(request.facts || {}).map(([k, v]) => [k.replace(/_/g, '.'), v]))
    const engine = new Inference(rules, requestFacts, ruleDescriptions)

    return engine.infer(request.fact).then(result => {
      return {
        statusCode: 200,
        body: JSON.stringify({
          stopReason: 'COMPLETED',
          result,
          facts: engine.facts,
          log: engine.log,
        })
      }
    }).catch(error => {
      // There are two error possibilities:
      //  - inference missing an external fact, in which case corresponding details are in the log
      //  - unhandled error during inference
      const lastLogItem = engine.log.length > 0 ? engine.log[engine.log.length-1] : null
      if (lastLogItem?.code === 'FACT_NEEDED')
        return {
          statusCode: 200,
          body: JSON.stringify({
            stopReason: 'FACT_NEEDED',
            facts: engine.facts,
            log: engine.log,
          })
        }
      else // generic unhandled error
        return {
          statusCode: 500,
          body: JSON.stringify({
            stopReason: 'ERROR',
            error: error.message,
            facts: engine.facts,
            log: engine.log,
          })
        }
    })
  };
}
