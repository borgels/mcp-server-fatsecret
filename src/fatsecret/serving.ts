/**
 * Closes a gap in every existing open-source FatSecret MCP server: none help
 * the caller pick a serving_id/number_of_units from a natural-language
 * quantity — they leave raw servings-array plumbing to the caller. This
 * fuzzy-matches a human description ("1 slice", "100g", "medium") against a
 * food's servings array from a `food.get` response.
 */

export interface FatSecretServing {
  serving_id: string;
  serving_description?: string;
  measurement_description?: string;
  metric_serving_amount?: string;
  metric_serving_unit?: string;
  number_of_units?: string;
  [key: string]: unknown;
}

/** food.get responses nest servings as either a single object or an array under food.servings.serving. */
export function normalizeServings(servingsField: unknown): FatSecretServing[] {
  if (!servingsField || typeof servingsField !== 'object') {
    return [];
  }
  const serving = (servingsField as { serving?: unknown }).serving;
  if (!serving) {
    return [];
  }
  return Array.isArray(serving) ? (serving as FatSecretServing[]) : [serving as FatSecretServing];
}

export function pickServing(servings: FatSecretServing[], query: string): FatSecretServing | undefined {
  if (servings.length === 0) {
    return undefined;
  }
  const q = query.trim().toLowerCase();
  if (!q) {
    return servings[0];
  }
  const terms = q.split(/\s+/).filter(Boolean);
  const compactQuery = q.replace(/\s+/g, '');
  const scored = servings.map(serving => {
    const text = `${serving.serving_description ?? ''} ${serving.measurement_description ?? ''}`.toLowerCase();
    const compactText = text.replace(/\s+/g, '');
    let score = 0;
    if (text === q) score += 10;
    if (text.includes(q)) score += 5;
    // Also compare with whitespace stripped, so "100g" matches a "100 g" description.
    if (compactText.includes(compactQuery)) score += 4;
    for (const term of terms) {
      if (text.includes(term)) score += 1;
    }
    return { serving, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.score ? scored[0].serving : servings[0];
}
