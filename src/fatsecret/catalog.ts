export type FatSecretHttpMethod = 'GET' | 'POST';
export type FatSecretAuthSurface = 'oauth2-public' | 'oauth1-private';
export type CapabilityRisk = 'read' | 'draft' | 'commit' | 'dangerous';

export interface FatSecretMethod {
  /** FatSecret's `method=` RPC identifier, e.g. "food_entry.create". */
  id: string;
  httpMethod: FatSecretHttpMethod;
  authSurface: FatSecretAuthSurface;
  risk: CapabilityRisk;
  summary: string;
  keywords: string[];
}

/**
 * Explicit allowlist of every FatSecret method this server can call — nothing
 * uncatalogued is reachable, even through the generic long-tail escape hatch
 * (fatsecret_call_endpoint). Mirrors mcp-server-e-conomic's catalog.ts, but
 * hand-written rather than generated: FatSecret's surface is small (~30
 * methods) and a hand-curated, reviewed list matches the prepare/commit
 * ceremony's need for a stable risk classification better than codegen churn
 * would.
 *
 * Parameter names/versions reflect FatSecret's published docs at the time of
 * writing; confirm the exact current parameter set against
 * platform.fatsecret.com/docs before enabling writes in production.
 */
export const FATSECRET_METHODS: FatSecretMethod[] = [
  // --- Public food/recipe database (OAuth2 client-credentials) ---
  { id: 'foods.search', httpMethod: 'GET', authSurface: 'oauth2-public', risk: 'read', summary: 'Search the public food database by keyword.', keywords: ['food', 'search', 'mad'] },
  { id: 'food.get', httpMethod: 'GET', authSurface: 'oauth2-public', risk: 'read', summary: 'Get full nutrition detail + servings for one food by id.', keywords: ['food', 'nutrition', 'serving'] },
  { id: 'recipes.search', httpMethod: 'GET', authSurface: 'oauth2-public', risk: 'read', summary: 'Search the public recipe database by keyword/filters.', keywords: ['recipe', 'search', 'opskrift'] },
  { id: 'recipe.get', httpMethod: 'GET', authSurface: 'oauth2-public', risk: 'read', summary: 'Get full ingredients/directions/nutrition for one recipe by id.', keywords: ['recipe', 'ingredients'] },

  // --- Profile (OAuth1 private) ---
  { id: 'profile.get', httpMethod: 'GET', authSurface: 'oauth1-private', risk: 'read', summary: "Your FatSecret profile status.", keywords: ['profile', 'status'] },
  { id: 'profile.create', httpMethod: 'POST', authSurface: 'oauth1-private', risk: 'dangerous', summary: 'Fallback: mint an account-less FatSecret profile (dev/test only — no real login, no companion-app access).', keywords: ['profile', 'create', 'fallback'] },

  // --- Food diary (OAuth1 private) ---
  { id: 'food_entries.get', httpMethod: 'GET', authSurface: 'oauth1-private', risk: 'read', summary: 'Your food diary entries for one date.', keywords: ['diary', 'food entries', 'mad'] },
  { id: 'food_entries.get_month', httpMethod: 'GET', authSurface: 'oauth1-private', risk: 'read', summary: 'Monthly food diary summary.', keywords: ['diary', 'month'] },
  { id: 'food_entry.create', httpMethod: 'POST', authSurface: 'oauth1-private', risk: 'commit', summary: 'Log a food into your diary (food_id, serving_id, number_of_units, meal, date).', keywords: ['log', 'eat', 'diary', 'spis'] },
  { id: 'food_entry.edit', httpMethod: 'POST', authSurface: 'oauth1-private', risk: 'commit', summary: 'Edit an existing food diary entry.', keywords: ['edit', 'diary'] },
  { id: 'food_entry.delete', httpMethod: 'POST', authSurface: 'oauth1-private', risk: 'commit', summary: 'Delete a food diary entry.', keywords: ['delete', 'diary'] },
  { id: 'food_entries.copy', httpMethod: 'POST', authSurface: 'oauth1-private', risk: 'commit', summary: "Copy one day's food entries to another date.", keywords: ['copy', 'diary'] },

  // --- Weight (OAuth1 private) ---
  { id: 'weight.get_month', httpMethod: 'GET', authSurface: 'oauth1-private', risk: 'read', summary: 'Your weight history for a month.', keywords: ['weight', 'vægt', 'history'] },
  { id: 'weight.update', httpMethod: 'POST', authSurface: 'oauth1-private', risk: 'commit', summary: 'Log your current weight (kg). Height/goal-weight are one-shot-forever on first call.', keywords: ['weight', 'vægt', 'log'] },

  // --- Exercise (OAuth1 private) — no ad-hoc create; see fatsecret_log_one_off_exercise ---
  { id: 'exercises.get', httpMethod: 'GET', authSurface: 'oauth1-private', risk: 'read', summary: 'List known exercise types + ids.', keywords: ['exercise', 'types', 'træning'] },
  { id: 'exercise_entries.get', httpMethod: 'GET', authSurface: 'oauth1-private', risk: 'read', summary: 'Your exercise diary entries for one date.', keywords: ['exercise', 'diary'] },
  { id: 'exercise_entries.get_month', httpMethod: 'GET', authSurface: 'oauth1-private', risk: 'read', summary: 'Monthly exercise/calories-burned summary.', keywords: ['exercise', 'month'] },
  { id: 'exercise_entries.save_template', httpMethod: 'POST', authSurface: 'oauth1-private', risk: 'commit', summary: 'Define/edit your recurring weekly exercise routine template.', keywords: ['exercise', 'template', 'routine'] },
  { id: 'exercise_entries.commit_day', httpMethod: 'POST', authSurface: 'oauth1-private', risk: 'commit', summary: "Commit today's (or a given date's) template routine into the exercise diary.", keywords: ['exercise', 'commit', 'log'] },
  { id: 'exercise_entry.edit', httpMethod: 'POST', authSurface: 'oauth1-private', risk: 'commit', summary: 'Shift minutes between two exercises on an existing diary day.', keywords: ['exercise', 'edit', 'shift'] },

  // --- Saved meals (OAuth1 private) ---
  { id: 'saved_meals.get', httpMethod: 'GET', authSurface: 'oauth1-private', risk: 'read', summary: 'Your saved-meal templates.', keywords: ['saved meal', 'template'] },
  { id: 'saved_meal_items.get', httpMethod: 'GET', authSurface: 'oauth1-private', risk: 'read', summary: 'Foods inside one saved meal.', keywords: ['saved meal', 'items'] },
  { id: 'saved_meal.create', httpMethod: 'POST', authSurface: 'oauth1-private', risk: 'commit', summary: 'Create a saved-meal template.', keywords: ['saved meal', 'create'] },
  { id: 'saved_meal.edit', httpMethod: 'POST', authSurface: 'oauth1-private', risk: 'commit', summary: 'Edit a saved-meal template.', keywords: ['saved meal', 'edit'] },
  { id: 'saved_meal.delete', httpMethod: 'POST', authSurface: 'oauth1-private', risk: 'commit', summary: 'Delete a saved-meal template.', keywords: ['saved meal', 'delete'] },
  { id: 'saved_meal_item.add', httpMethod: 'POST', authSurface: 'oauth1-private', risk: 'commit', summary: 'Add a food to a saved meal.', keywords: ['saved meal', 'add'] },
  { id: 'saved_meal_item.edit', httpMethod: 'POST', authSurface: 'oauth1-private', risk: 'commit', summary: 'Edit a food inside a saved meal.', keywords: ['saved meal', 'edit'] },
  { id: 'saved_meal_item.delete', httpMethod: 'POST', authSurface: 'oauth1-private', risk: 'commit', summary: 'Remove a food from a saved meal.', keywords: ['saved meal', 'delete'] },

  // --- Favorites (OAuth1 private) — cheap/reversible, still audited ---
  { id: 'foods.get_favorites', httpMethod: 'GET', authSurface: 'oauth1-private', risk: 'read', summary: 'Your favorite foods.', keywords: ['favorite', 'food'] },
  { id: 'food.add_favorite', httpMethod: 'POST', authSurface: 'oauth1-private', risk: 'draft', summary: 'Mark a food as a favorite.', keywords: ['favorite', 'add'] },
  { id: 'food.delete_favorite', httpMethod: 'POST', authSurface: 'oauth1-private', risk: 'draft', summary: 'Unmark a food as a favorite.', keywords: ['favorite', 'delete'] },
  { id: 'recipes.get_favorites', httpMethod: 'GET', authSurface: 'oauth1-private', risk: 'read', summary: 'Your favorite recipes.', keywords: ['favorite', 'recipe'] },
  { id: 'recipe.add_favorite', httpMethod: 'POST', authSurface: 'oauth1-private', risk: 'draft', summary: 'Mark a recipe as a favorite.', keywords: ['favorite', 'add'] },
  { id: 'recipe.delete_favorite', httpMethod: 'POST', authSurface: 'oauth1-private', risk: 'draft', summary: 'Unmark a recipe as a favorite.', keywords: ['favorite', 'delete'] },

  // --- Custom food (OAuth1 private) ---
  { id: 'food.create', httpMethod: 'POST', authSurface: 'oauth1-private', risk: 'commit', summary: 'Create a custom/private food item (name + nutrition facts) for later logging.', keywords: ['custom food', 'create'] },
];

export function findMethod(id: string): FatSecretMethod {
  const method = FATSECRET_METHODS.find(m => m.id === id);
  if (!method) {
    throw new Error(`Unknown or non-allowlisted FatSecret method: ${id}`);
  }
  return method;
}

export interface Capability {
  id: string;
  summary: string;
}

export function searchCapabilities(query: string, limit = 20): Capability[] {
  const q = query.trim().toLowerCase();
  const pool = FATSECRET_METHODS.map(m => ({ id: m.id, summary: m.summary, keywords: m.keywords }));
  if (!q) {
    return pool.slice(0, limit).map(({ id, summary }) => ({ id, summary }));
  }
  const terms = q.split(/\s+/).filter(Boolean);
  return pool
    .map(m => ({
      m,
      score: terms.reduce((s, t) => s + ([m.id, m.summary, ...m.keywords].join(' ').toLowerCase().includes(t) ? 1 : 0), 0),
    }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => ({ id: x.m.id, summary: x.m.summary }));
}
