import { randomUUID } from "node:crypto";
import { RuleAssertionSchema, RuleDefinitionSchema, type RuleAssertion, type RuleDefinition, type RuleEvaluator } from "./contracts";

export class BusinessRuleRegistry {
  readonly #rules = new Map<string, { definition: RuleDefinition; evaluate: RuleEvaluator }>();

  register(definition: RuleDefinition, evaluate: RuleEvaluator): void {
    const parsed = RuleDefinitionSchema.parse(definition);
    const key = `${parsed.id}@${parsed.version}`;
    if (this.#rules.has(key)) throw new Error(`duplicate_rule:${key}`);
    this.#rules.set(key, { definition: parsed, evaluate });
  }

  list(): RuleDefinition[] { return [...this.#rules.values()].map((item) => item.definition); }

  resolve(ruleId: string, asOf: string, jurisdiction: string): RuleDefinition {
    const matches = [...this.#rules.values()]
      .map((item) => item.definition)
      .filter((definition) => definition.id === ruleId
        && definition.jurisdiction === jurisdiction
        && definition.effectivePeriod.from <= asOf
        && (!definition.effectivePeriod.to || definition.effectivePeriod.to >= asOf))
      .sort((left, right) => right.effectivePeriod.from.localeCompare(left.effectivePeriod.from)
        || right.version.localeCompare(left.version));
    if (matches.length === 0) throw new Error(`no_effective_rule:${ruleId}:${jurisdiction}:${asOf}`);
    const newest = matches[0]!;
    const sameStart = matches.filter((item) => item.effectivePeriod.from === newest.effectivePeriod.from);
    if (sameStart.length > 1) throw new Error(`ambiguous_effective_rule:${ruleId}:${jurisdiction}:${asOf}`);
    return newest;
  }

  evaluateEffective(ruleId: string, facts: Record<string, unknown>, artifactSha256: string, asOf: string, jurisdiction: string): RuleAssertion {
    const definition = this.resolve(ruleId, asOf, jurisdiction);
    return this.evaluate(ruleId, definition.version, facts, artifactSha256, asOf);
  }

  evaluate(ruleId: string, version: string, facts: Record<string, unknown>, artifactSha256: string, asOf: string): RuleAssertion {
    const registered = this.#rules.get(`${ruleId}@${version}`);
    if (!registered) throw new Error(`unknown_rule:${ruleId}@${version}`);
    const definition = registered.definition;
    if (asOf < definition.effectivePeriod.from || (definition.effectivePeriod.to && asOf > definition.effectivePeriod.to)) {
      return RuleAssertionSchema.parse({ assertionId: randomUUID(), ruleId, ruleVersion: version, status: "not_applicable", message: `Rule is not effective on ${asOf}`, facts: {}, artifactSha256, locators: [], evaluatedAt: new Date().toISOString() });
    }
    const missing = definition.requiredFacts.filter((key) => facts[key] === undefined || facts[key] === null);
    if (missing.length) {
      return RuleAssertionSchema.parse({ assertionId: randomUUID(), ruleId, ruleVersion: version, status: "unverifiable", message: `Missing facts: ${missing.join(", ")}`, facts: {}, artifactSha256, locators: [], evaluatedAt: new Date().toISOString() });
    }
    return RuleAssertionSchema.parse({ assertionId: randomUUID(), ruleId, ruleVersion: version, ...registered.evaluate(facts, definition), artifactSha256, evaluatedAt: new Date().toISOString() });
  }
}

export const businessRuleRegistry = new BusinessRuleRegistry();
