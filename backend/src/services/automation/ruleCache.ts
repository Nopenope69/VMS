/**
 * In-process change counter for automation rules. Caches derived from the rule table (for example
 * the minimum-dwell milestones in DetectionIngestionService) reload when it moves, instead of
 * serving a stale view for their whole TTL. Every code path that writes AutomationRule calls
 * markAutomationRulesChanged().
 */
let version = 0;

export function markAutomationRulesChanged(): void {
  version++;
}

export function automationRulesVersion(): number {
  return version;
}
