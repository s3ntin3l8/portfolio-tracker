import type { SourceSummary } from "@portfolio/api-client";

export function mergeTaxComponents(sources: SourceSummary[]): Record<string, string> {
  return sources.reduce<Record<string, string>>((acc, s) => {
    if (s.taxComponents) Object.assign(acc, s.taxComponents);
    return acc;
  }, {});
}
