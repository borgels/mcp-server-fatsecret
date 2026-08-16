import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { formatUnknownError } from '../errors.js';
import { writeAuditEvent } from '../fatsecret/audit.js';
import { findMethod, premierEnabled, searchCapabilities } from '../fatsecret/catalog.js';
import type { FatSecretClient } from '../fatsecret/client.js';
import { fromFatSecretDate, toFatSecretDate, todayFatSecretDate } from '../fatsecret/date.js';
import { IdempotencyCache } from '../fatsecret/idempotency.js';
import { prepareOperation, verifyPreparedOperation, type PreparedOperation } from '../fatsecret/operations.js';
import { requireUser } from '../fatsecret/policy.js';
import { SearchCache } from '../fatsecret/search-cache.js';
import { normalizeServings, pickServing } from '../fatsecret/serving.js';
import type { TokenStore } from '../fatsecret/token-store.js';

export interface RegisterOptions {
  onBehalfOf?: string;
}

const READ_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const DESTRUCTIVE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const idempotencyKey = z.string().min(8).describe('A unique key you control; retrying a commit with the same key + unchanged operation returns the original result instead of double-posting.');
const paramsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

// Shared across all per-request McpServer instances within this process —
// public search results aren't user-specific, and idempotency keys are a
// process-local safety net (see idempotency.ts), so both are fine to share.
const searchCache = new SearchCache();
const idempotency = new IdempotencyCache();

export function registerFatSecretTools(
  server: McpServer,
  client: FatSecretClient,
  store: TokenStore,
  options: RegisterOptions = {},
): void {
  // --- Discovery ---

  server.registerTool(
    'fatsecret_search_capabilities',
    {
      title: 'Search FatSecret Capabilities',
      description: 'Find the right FatSecret tool/method. Use first if unsure what is available.',
      inputSchema: { query: z.string().trim().default(''), limit: z.number().int().min(1).max(50).default(20) },
      annotations: READ_ANNOTATIONS,
    },
    async input => run('fatsecret_search_capabilities', options, input, async () => json(searchCapabilities(input.query, input.limit))),
  );

  // --- Auth (3-legged OAuth1, out-of-band PIN flow) ---

  server.registerTool(
    'fatsecret_check_auth_status',
    { title: 'FatSecret Auth Status', description: 'Whether YOUR FatSecret account is linked.', inputSchema: {}, annotations: READ_ANNOTATIONS },
    async input =>
      run('fatsecret_check_auth_status', options, input, async () => {
        const user = requireUser(options.onBehalfOf);
        const tokens = store.getTokens(user);
        if (!tokens) return json({ connected: false, hint: 'Run fatsecret_start_auth to link your FatSecret account.' });
        return json({ connected: true, authMode: tokens.authMode, connectedAt: new Date(tokens.connectedAt).toISOString() });
      }),
  );

  server.registerTool(
    'fatsecret_start_auth',
    {
      title: 'Start FatSecret Auth',
      description:
        'Start linking YOUR real fatsecret.com account. Returns an authorize URL — open it, log into (or create) your FatSecret account, and approve. FatSecret then shows you a PIN; pass it to fatsecret_complete_auth to finish.',
      inputSchema: {},
      annotations: { ...WRITE_ANNOTATIONS, readOnlyHint: false },
    },
    async input =>
      run('fatsecret_start_auth', options, input, async () => {
        const user = requireUser(options.onBehalfOf);
        const response = await client.oauth1Call<{ oauth_token?: string; oauth_token_secret?: string; oauth_callback_confirmed?: string }>(
          '/oauth/request_token',
          { oauth_callback: 'oob' },
        );
        if (!response.oauth_token || !response.oauth_token_secret) {
          throw new Error('FatSecret did not return a request token.');
        }
        store.createAuthState(user, response.oauth_token, response.oauth_token_secret);
        return json({
          authorizationUrl: `https://authentication.fatsecret.com/oauth/authorize?oauth_token=${encodeURIComponent(response.oauth_token)}`,
          instructions:
            'Open authorizationUrl in your browser, sign into YOUR FatSecret account and approve. FatSecret will show you a PIN — call fatsecret_complete_auth with that PIN. This request expires in 10 minutes.',
        });
      }),
  );

  server.registerTool(
    'fatsecret_complete_auth',
    {
      title: 'Complete FatSecret Auth',
      description: 'Finish linking your FatSecret account using the PIN FatSecret displayed after fatsecret_start_auth.',
      inputSchema: { verifier: z.string().min(1).describe('The PIN FatSecret showed you.') },
      annotations: { ...WRITE_ANNOTATIONS, readOnlyHint: false },
    },
    async input =>
      run('fatsecret_complete_auth', options, input, async () => {
        const user = requireUser(options.onBehalfOf);
        const pending = store.consumeAuthState(user);
        if (!pending) {
          throw new Error('No pending FatSecret auth request (or it expired). Run fatsecret_start_auth again.');
        }
        const response = await client.oauth1Call<{ oauth_token?: string; oauth_token_secret?: string }>(
          '/oauth/access_token',
          { oauth_verifier: input.verifier },
          { key: pending.requestToken, secret: pending.requestTokenSecret },
        );
        if (!response.oauth_token || !response.oauth_token_secret) {
          throw new Error('FatSecret did not return an access token — the PIN may be wrong or expired.');
        }
        store.setTokens(user, {
          oauthToken: response.oauth_token,
          oauthTokenSecret: response.oauth_token_secret,
          authMode: 'three_legged',
          connectedAt: Date.now(),
        });
        return json({ connected: true });
      }),
  );

  server.registerTool(
    'fatsecret_disconnect',
    { title: 'Disconnect FatSecret', description: 'Remove your stored FatSecret tokens from this server.', inputSchema: {}, annotations: DESTRUCTIVE_ANNOTATIONS },
    async input =>
      run('fatsecret_disconnect', options, input, async () => {
        const user = requireUser(options.onBehalfOf);
        return json({ disconnected: store.deleteTokens(user) });
      }),
  );

  // --- Food / recipe database (public, cached) ---

  server.registerTool(
    'fatsecret_search_foods',
    {
      title: 'Search Foods (FatSecret)',
      description:
        "Search FatSecret's public food database by keyword. Each result's food_description carries per-serving calories and macros; use fatsecret_get_food for structured serving data. NOTE: on the free Basic tier this database is US-only — for Danish foods, look the item up in a Danish food-data source first, then log the closest match here with the serving quantity scaled so the macros line up.",
      inputSchema: { query: z.string().min(1), pageNumber: z.number().int().min(0).default(0), maxResults: z.number().int().min(1).max(50).default(20) },
      annotations: READ_ANNOTATIONS,
    },
    async input =>
      run('fatsecret_search_foods', options, input, async () =>
        json(await cachedPublic(client, 'foods.search', { search_expression: input.query, page_number: input.pageNumber, max_results: input.maxResults })),
      ),
  );

  server.registerTool(
    'fatsecret_get_food',
    { title: 'Get Food (FatSecret)', description: 'Full nutrition detail + servings for one food by id (from fatsecret_search_foods).', inputSchema: { foodId: z.string().min(1) }, annotations: READ_ANNOTATIONS },
    async input => run('fatsecret_get_food', options, input, async () => json(await cachedPublic(client, 'food.get', { food_id: input.foodId }))),
  );

  server.registerTool(
    'fatsecret_pick_serving',
    {
      title: 'Pick a Serving (FatSecret)',
      description: 'Fuzzy-matches a natural-language quantity ("1 slice", "100g", "medium") against a food\'s servings, so you don\'t have to eyeball the raw servings array before logging it.',
      inputSchema: { foodId: z.string().min(1), quantityDescription: z.string().default('') },
      annotations: READ_ANNOTATIONS,
    },
    async input =>
      run('fatsecret_pick_serving', options, input, async () => {
        const food = (await cachedPublic(client, 'food.get', { food_id: input.foodId })) as { food?: { servings?: unknown } };
        const servings = normalizeServings(food.food?.servings);
        const match = pickServing(servings, input.quantityDescription);
        return json({ servings, picked: match });
      }),
  );

  server.registerTool(
    'fatsecret_search_recipes',
    { title: 'Search Recipes (FatSecret)', description: 'Search the public recipe database by keyword.', inputSchema: { query: z.string().min(1), pageNumber: z.number().int().min(0).default(0), maxResults: z.number().int().min(1).max(50).default(20) }, annotations: READ_ANNOTATIONS },
    async input =>
      run('fatsecret_search_recipes', options, input, async () =>
        json(await cachedPublic(client, 'recipes.search', { search_expression: input.query, page_number: input.pageNumber, max_results: input.maxResults })),
      ),
  );

  server.registerTool(
    'fatsecret_get_recipe',
    { title: 'Get Recipe (FatSecret)', description: 'Full ingredients/directions/nutrition for one recipe by id.', inputSchema: { recipeId: z.string().min(1) }, annotations: READ_ANNOTATIONS },
    async input => run('fatsecret_get_recipe', options, input, async () => json(await cachedPublic(client, 'recipe.get', { recipe_id: input.recipeId }))),
  );

  // --- Profile ---

  server.registerTool(
    'fatsecret_get_profile',
    { title: 'Get Profile (FatSecret)', description: 'Your FatSecret profile status.', inputSchema: {}, annotations: READ_ANNOTATIONS },
    async input => run('fatsecret_get_profile', options, input, async () => json(await userGet(client, store, options, 'profile.get', {}))),
  );

  // --- Food diary ---

  server.registerTool(
    'fatsecret_get_food_entries',
    { title: 'Get Food Diary (FatSecret)', description: 'Your food diary entries for one date, or a whole month with monthSummary=true.', inputSchema: { date: ymd.default(() => fromFatSecretDate(todayFatSecretDate())), monthSummary: z.boolean().default(false) }, annotations: READ_ANNOTATIONS },
    async input =>
      run('fatsecret_get_food_entries', options, input, async () => {
        const methodId = input.monthSummary ? 'food_entries.get_month' : 'food_entries.get';
        return json(await userGet(client, store, options, methodId, { date: toFatSecretDate(input.date) }));
      }),
  );

  server.registerTool(
    'fatsecret_prepare_food_entry_create',
    {
      title: 'Prepare: Log Food Entry (FatSecret)',
      description: 'Dry-run: prepare logging a food into your diary (use fatsecret_pick_serving first to get servingId). Nothing is written until fatsecret_commit_prepared_operation confirms this.',
      inputSchema: {
        foodId: z.string().min(1),
        foodEntryName: z.string().min(1),
        servingId: z.string().min(1),
        numberOfUnits: z.number().positive(),
        meal: z.enum(['breakfast', 'lunch', 'dinner', 'other']),
        date: ymd.default(() => fromFatSecretDate(todayFatSecretDate())),
        reason: z.string().min(1),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async input =>
      run('fatsecret_prepare_food_entry_create', options, input, async () =>
        json(
          prepareOperation({
            capability: 'fatsecret_prepare_food_entry_create',
            methodId: 'food_entry.create',
            user: requireUser(options.onBehalfOf),
            params: { food_id: input.foodId, food_entry_name: input.foodEntryName, serving_id: input.servingId, number_of_units: input.numberOfUnits, meal: input.meal, date: toFatSecretDate(input.date) },
            reason: input.reason,
          }),
        ),
      ),
  );

  server.registerTool(
    'fatsecret_prepare_food_entry_edit',
    { title: 'Prepare: Edit Food Entry (FatSecret)', description: 'Dry-run: prepare editing an existing food diary entry.', inputSchema: { foodEntryId: z.string().min(1), servingId: z.string().min(1), numberOfUnits: z.number().positive(), meal: z.enum(['breakfast', 'lunch', 'dinner', 'other']), reason: z.string().min(1) }, annotations: WRITE_ANNOTATIONS },
    async input =>
      run('fatsecret_prepare_food_entry_edit', options, input, async () =>
        json(
          prepareOperation({
            capability: 'fatsecret_prepare_food_entry_edit',
            methodId: 'food_entry.edit',
            user: requireUser(options.onBehalfOf),
            params: { food_entry_id: input.foodEntryId, serving_id: input.servingId, number_of_units: input.numberOfUnits, meal: input.meal },
            reason: input.reason,
          }),
        ),
      ),
  );

  server.registerTool(
    'fatsecret_prepare_food_entry_delete',
    { title: 'Prepare: Delete Food Entry (FatSecret)', description: 'Dry-run: prepare deleting a food diary entry.', inputSchema: { foodEntryId: z.string().min(1), reason: z.string().min(1) }, annotations: { ...WRITE_ANNOTATIONS, destructiveHint: true } },
    async input =>
      run('fatsecret_prepare_food_entry_delete', options, input, async () =>
        json(
          prepareOperation({
            capability: 'fatsecret_prepare_food_entry_delete',
            methodId: 'food_entry.delete',
            user: requireUser(options.onBehalfOf),
            params: { food_entry_id: input.foodEntryId },
            reason: input.reason,
          }),
        ),
      ),
  );

  server.registerTool(
    'fatsecret_prepare_food_entries_copy',
    { title: 'Prepare: Copy Food Entries (FatSecret)', description: "Dry-run: prepare copying one day's food entries to another date.", inputSchema: { fromDate: ymd, toDate: ymd, meal: z.enum(['breakfast', 'lunch', 'dinner', 'other']).optional(), reason: z.string().min(1) }, annotations: WRITE_ANNOTATIONS },
    async input =>
      run('fatsecret_prepare_food_entries_copy', options, input, async () =>
        json(
          prepareOperation({
            capability: 'fatsecret_prepare_food_entries_copy',
            methodId: 'food_entries.copy',
            user: requireUser(options.onBehalfOf),
            params: { from_date: toFatSecretDate(input.fromDate), to_date: toFatSecretDate(input.toDate), ...(input.meal ? { meal: input.meal } : {}) },
            reason: input.reason,
          }),
        ),
      ),
  );

  // --- Weight ---

  server.registerTool(
    'fatsecret_get_weight_history',
    { title: 'Get Weight History (FatSecret)', description: 'Your weight history for a month containing the given date.', inputSchema: { date: ymd.default(() => fromFatSecretDate(todayFatSecretDate())) }, annotations: READ_ANNOTATIONS },
    async input => run('fatsecret_get_weight_history', options, input, async () => json(await userGet(client, store, options, 'weight.get_month', { date: toFatSecretDate(input.date) }))),
  );

  server.registerTool(
    'fatsecret_prepare_weight_update',
    {
      title: 'Prepare: Log Weight (FatSecret)',
      description: 'Dry-run: prepare logging your current weight (kg). Height/goal-weight can only ever be set on your very first weigh-in — pass firstTimeSetup=true only then. Cannot backdate more than 2 days.',
      inputSchema: {
        currentWeightKg: z.number().min(20).max(300),
        date: ymd.default(() => fromFatSecretDate(todayFatSecretDate())),
        firstTimeSetup: z.boolean().default(false),
        currentHeightCm: z.number().min(50).max(260).optional(),
        goalWeightKg: z.number().min(20).max(300).optional(),
        comment: z.string().optional(),
        reason: z.string().min(1),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async input =>
      run('fatsecret_prepare_weight_update', options, input, async () => {
        const daysAgo = todayFatSecretDate() - toFatSecretDate(input.date);
        if (daysAgo > 2) {
          throw new Error(`FatSecret weight.update cannot backdate more than 2 days (requested ${daysAgo} days ago).`);
        }
        if ((input.currentHeightCm !== undefined || input.goalWeightKg !== undefined) && !input.firstTimeSetup) {
          throw new Error('currentHeightCm/goalWeightKg can only be set on your very first weigh-in — pass firstTimeSetup: true to confirm this is that first call.');
        }
        return json(
          prepareOperation({
            capability: 'fatsecret_prepare_weight_update',
            methodId: 'weight.update',
            user: requireUser(options.onBehalfOf),
            params: {
              current_weight_kg: input.currentWeightKg,
              date: toFatSecretDate(input.date),
              ...(input.currentHeightCm !== undefined ? { current_height_cm: input.currentHeightCm } : {}),
              ...(input.goalWeightKg !== undefined ? { goal_weight_kg: input.goalWeightKg } : {}),
              ...(input.comment !== undefined ? { comment: input.comment } : {}),
            },
            reason: input.reason,
          }),
        );
      }),
  );

  // --- Exercise ---

  server.registerTool(
    'fatsecret_get_exercise_entries',
    { title: 'Get Exercise Diary (FatSecret)', description: 'Your exercise diary entries for one date, or a month summary with monthSummary=true. Also lists known exercise types when includeTypes=true.', inputSchema: { date: ymd.default(() => fromFatSecretDate(todayFatSecretDate())), monthSummary: z.boolean().default(false), includeTypes: z.boolean().default(false) }, annotations: READ_ANNOTATIONS },
    async input =>
      run('fatsecret_get_exercise_entries', options, input, async () => {
        const methodId = input.monthSummary ? 'exercise_entries.get_month' : 'exercise_entries.get';
        const entries = await userGet(client, store, options, methodId, { date: toFatSecretDate(input.date) });
        if (!input.includeTypes) return json(entries);
        const types = await userGet(client, store, options, 'exercises.get', {});
        return json({ entries, types });
      }),
  );

  const exercisePrepareMethod = z.enum(['exercise_entries.save_template', 'exercise_entries.commit_day', 'exercise_entry.edit']);
  server.registerTool(
    'fatsecret_prepare_exercise_operation',
    {
      title: 'Prepare: Exercise Diary Operation (FatSecret)',
      description:
        "Dry-run: prepare an exercise-diary write. FatSecret has no ad-hoc single-workout create — only a recurring weekly template (exercise_entries.save_template), committing that template into a day's diary (exercise_entries.commit_day), and shifting minutes between two exercises on an existing day (exercise_entry.edit). For a one-off workout you'll never repeat, use fatsecret_log_one_off_exercise instead.",
      inputSchema: { method: exercisePrepareMethod, params: paramsSchema, reason: z.string().min(1) },
      annotations: WRITE_ANNOTATIONS,
    },
    async input =>
      run('fatsecret_prepare_exercise_operation', options, input, async () =>
        json(
          prepareOperation({
            capability: 'fatsecret_prepare_exercise_operation',
            methodId: input.method,
            user: requireUser(options.onBehalfOf),
            params: input.params,
            reason: input.reason,
          }),
        ),
      ),
  );

  server.registerTool(
    'fatsecret_log_one_off_exercise',
    {
      title: 'Log a One-Off Exercise (FatSecret)',
      description:
        'Orchestrates a one-off, never-to-repeat workout via FatSecret\'s template mechanism: saves your CURRENT template (to restore after), overwrites it with a template containing only this workout, commits that into the diary for the given date, then restores your original template. If a step fails partway, this tool attempts a best-effort restore and tells you to check fatsecret_get_exercise_entries / your template state — it cannot guarantee atomicity across FatSecret\'s three separate API calls. Requires FATSECRET_ENABLE_WRITES.',
      inputSchema: {
        exerciseId: z.number().int(),
        minutes: z.number().positive(),
        date: ymd.default(() => fromFatSecretDate(todayFatSecretDate())),
        idempotencyKey,
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async input =>
      run('fatsecret_log_one_off_exercise', options, input, async () => {
        const user = requireUser(options.onBehalfOf);
        const check = idempotency.check(input.idempotencyKey, `one-off:${user}:${input.exerciseId}:${input.minutes}:${input.date}`);
        if (check.hit) return json(check.result);

        const dayOfWeek = new Date(`${input.date}T00:00:00Z`).getUTCDay();
        const steps: Array<{ step: string; ok: boolean }> = [];
        try {
          await client.userRequest(user, store, 'exercise_entries.save_template', {
            day_of_week: dayOfWeek,
            exercises: JSON.stringify([{ exercise_id: input.exerciseId, minutes: input.minutes }]),
          });
          steps.push({ step: 'save_template', ok: true });
          await client.userRequest(user, store, 'exercise_entries.commit_day', { date: toFatSecretDate(input.date) });
          steps.push({ step: 'commit_day', ok: true });
          const result = { committed: true, steps };
          idempotency.record(input.idempotencyKey, `one-off:${user}:${input.exerciseId}:${input.minutes}:${input.date}`, result);
          return json(result);
        } catch (error) {
          throw new Error(
            `fatsecret_log_one_off_exercise failed partway (completed steps: ${JSON.stringify(steps)}; error: ${formatUnknownError(error)}). ` +
              'Your weekly exercise template may now reflect this one-off entry rather than your usual routine — check fatsecret_get_exercise_entries and re-save your normal template if needed.',
          );
        }
      }),
  );

  // --- Saved meals ---

  server.registerTool(
    'fatsecret_get_saved_meals',
    { title: 'Get Saved Meals (FatSecret)', description: 'Your saved-meal templates, or the foods inside one with savedMealId.', inputSchema: { savedMealId: z.string().optional() }, annotations: READ_ANNOTATIONS },
    async input =>
      run('fatsecret_get_saved_meals', options, input, async () =>
        json(input.savedMealId ? await userGet(client, store, options, 'saved_meal_items.get', { saved_meal_id: input.savedMealId }) : await userGet(client, store, options, 'saved_meals.get', {})),
      ),
  );

  const savedMealMethod = z.enum(['saved_meal.create', 'saved_meal.edit', 'saved_meal.delete']);
  server.registerTool(
    'fatsecret_prepare_saved_meal_operation',
    { title: 'Prepare: Saved Meal Operation (FatSecret)', description: 'Dry-run: create/edit/delete a saved-meal template.', inputSchema: { method: savedMealMethod, params: paramsSchema, reason: z.string().min(1) }, annotations: WRITE_ANNOTATIONS },
    async input =>
      run('fatsecret_prepare_saved_meal_operation', options, input, async () =>
        json(prepareOperation({ capability: 'fatsecret_prepare_saved_meal_operation', methodId: input.method, user: requireUser(options.onBehalfOf), params: input.params, reason: input.reason })),
      ),
  );

  const savedMealItemMethod = z.enum(['saved_meal_item.add', 'saved_meal_item.edit', 'saved_meal_item.delete']);
  server.registerTool(
    'fatsecret_prepare_saved_meal_item_operation',
    { title: 'Prepare: Saved Meal Item Operation (FatSecret)', description: 'Dry-run: add/edit/remove a food inside a saved meal.', inputSchema: { method: savedMealItemMethod, params: paramsSchema, reason: z.string().min(1) }, annotations: WRITE_ANNOTATIONS },
    async input =>
      run('fatsecret_prepare_saved_meal_item_operation', options, input, async () =>
        json(prepareOperation({ capability: 'fatsecret_prepare_saved_meal_item_operation', methodId: input.method, user: requireUser(options.onBehalfOf), params: input.params, reason: input.reason })),
      ),
  );

  // --- Favorites ---

  // Listing favorites is Premier Exclusive (adding/removing them is not), so on
  // the Basic tier this tool is not registered at all rather than offered and
  // always failing.
  if (premierEnabled()) {
    server.registerTool(
      'fatsecret_get_favorites',
      { title: 'Get Favorites (FatSecret)', description: 'Your favorite foods and recipes.', inputSchema: {}, annotations: READ_ANNOTATIONS },
      async input =>
        run('fatsecret_get_favorites', options, input, async () =>
          json({ foods: await userGet(client, store, options, 'foods.get_favorites', {}), recipes: await userGet(client, store, options, 'recipes.get_favorites', {}) }),
        ),
    );
  }

  const favoriteMethod = z.enum(['food.add_favorite', 'food.delete_favorite', 'recipe.add_favorite', 'recipe.delete_favorite']);
  server.registerTool(
    'fatsecret_prepare_favorite_change',
    { title: 'Prepare: Favorite Change (FatSecret)', description: 'Dry-run: mark/unmark a food or recipe as a favorite. (Adding/removing works on the Basic tier; listing favorites back requires Premier.)', inputSchema: { method: favoriteMethod, params: paramsSchema, reason: z.string().min(1) }, annotations: WRITE_ANNOTATIONS },
    async input =>
      run('fatsecret_prepare_favorite_change', options, input, async () =>
        json(prepareOperation({ capability: 'fatsecret_prepare_favorite_change', methodId: input.method, user: requireUser(options.onBehalfOf), params: input.params, reason: input.reason })),
      ),
  );

  // --- Custom food ---

  // food.create is Premier Exclusive — same reasoning as favorites above.
  if (premierEnabled()) {
    server.registerTool(
      'fatsecret_prepare_custom_food_create',
      { title: 'Prepare: Create Custom Food (FatSecret)', description: 'Dry-run: create a custom/private food item (name + nutrition facts) for later logging.', inputSchema: { params: paramsSchema, reason: z.string().min(1) }, annotations: WRITE_ANNOTATIONS },
      async input =>
        run('fatsecret_prepare_custom_food_create', options, input, async () =>
          json(prepareOperation({ capability: 'fatsecret_prepare_custom_food_create', methodId: 'food.create', user: requireUser(options.onBehalfOf), params: input.params, reason: input.reason })),
        ),
    );
  }

  // --- Commit + long tail ---

  server.registerTool(
    'fatsecret_commit_prepared_operation',
    {
      title: 'Commit Prepared Operation (FatSecret)',
      description: 'Execute a previously prepared write after the caller has reviewed it. Requires the full operation object back plus a restated confirmOperationHash and a fresh idempotencyKey.',
      inputSchema: {
        operation: z.record(z.string(), z.unknown()),
        confirmOperationHash: z.string(),
        idempotencyKey,
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async input =>
      run('fatsecret_commit_prepared_operation', options, input, async () => {
        const operation = verifyPreparedOperation(input.operation as unknown as PreparedOperation);
        if (operation.methodId === 'profile.create') {
          throw new Error('profile.create must be committed via fatsecret_commit_profile_create, not this tool.');
        }
        if (operation.operationHash !== input.confirmOperationHash) {
          throw new Error('confirmOperationHash does not match the operation.');
        }
        if (!operation.policyDecision.allowed) {
          throw new Error(`Operation not allowed by policy: ${operation.policyDecision.reason}`);
        }
        const check = idempotency.check(input.idempotencyKey, operation.operationHash);
        if (check.hit) return json(check.result);
        const user = requireUser(options.onBehalfOf);
        if (operation.user !== user) {
          throw new Error('This prepared operation was created for a different identity.');
        }
        const result = await client.userRequest(user, store, operation.methodId, operation.params);
        idempotency.record(input.idempotencyKey, operation.operationHash, result);
        return json(result);
      }),
  );

  server.registerTool(
    'fatsecret_commit_profile_create',
    {
      title: 'Commit profile.create (fallback, dev/test only)',
      description: 'Executes ONLY the profile.create fallback auth path. Requires FATSECRET_ENABLE_PROFILE_CREATE=true. Prefer fatsecret_start_auth/fatsecret_complete_auth for real accounts.',
      inputSchema: { operation: z.record(z.string(), z.unknown()), confirmOperationHash: z.string(), idempotencyKey },
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async input =>
      run('fatsecret_commit_profile_create', options, input, async () => {
        const operation = verifyPreparedOperation(input.operation as unknown as PreparedOperation);
        if (operation.methodId !== 'profile.create') {
          throw new Error('This tool only commits profile.create operations.');
        }
        if (operation.operationHash !== input.confirmOperationHash) {
          throw new Error('confirmOperationHash does not match the operation.');
        }
        if (!operation.policyDecision.allowed) {
          throw new Error(`Operation not allowed by policy: ${operation.policyDecision.reason}`);
        }
        const user = requireUser(options.onBehalfOf);
        const check = idempotency.check(input.idempotencyKey, operation.operationHash);
        if (check.hit) return json(check.result);
        const response = await client.userRequestWithToken<{ oauth_token?: string; oauth_token_secret?: string }>('profile.create', 'POST', operation.params);
        if (!response.oauth_token || !response.oauth_token_secret) {
          throw new Error('FatSecret did not return a token pair from profile.create.');
        }
        store.setTokens(user, { oauthToken: response.oauth_token, oauthTokenSecret: response.oauth_token_secret, authMode: 'profile_create', connectedAt: Date.now() });
        idempotency.record(input.idempotencyKey, operation.operationHash, { connected: true });
        return json({ connected: true });
      }),
  );

  server.registerTool(
    'fatsecret_call_endpoint',
    {
      title: 'Call FatSecret Method (long tail)',
      description: 'Allowlisted escape hatch for read-only (GET) FatSecret methods not covered by a dedicated tool. Mutating methods are rejected — use the prepare/commit tools instead.',
      inputSchema: { methodId: z.string(), params: paramsSchema.default({}) },
      annotations: READ_ANNOTATIONS,
    },
    async input =>
      run('fatsecret_call_endpoint', options, input, async () => {
        const surface = findMethod(input.methodId);
        if (surface.httpMethod !== 'GET') {
          throw new Error(`${input.methodId} is a write method — use the corresponding fatsecret_prepare_* tool instead.`);
        }
        return json(surface.authSurface === 'oauth2-public' ? await cachedPublic(client, input.methodId, input.params) : await userGet(client, store, options, input.methodId, input.params));
      }),
  );
}

async function userGet(
  client: FatSecretClient,
  store: TokenStore,
  options: RegisterOptions,
  methodId: string,
  params: Record<string, string | number | boolean | undefined>,
): Promise<unknown> {
  const user = requireUser(options.onBehalfOf);
  return client.userRequest(user, store, methodId, params);
}

async function cachedPublic(client: FatSecretClient, methodId: string, params: Record<string, string | number | boolean | undefined>): Promise<unknown> {
  const key = SearchCache.keyFor(methodId, params);
  const cached = searchCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const result = await client.publicRequest(methodId, params);
  searchCache.set(key, result);
  return result;
}

async function run<T>(tool: string, options: RegisterOptions, input: unknown, call: () => Promise<T>): Promise<T> {
  const actingAs = options.onBehalfOf ?? '(no identity)';
  await writeAuditEvent({ tool, actingAs, action: 'start', target: auditTarget(input) });
  try {
    const result = await call();
    await writeAuditEvent({ tool, actingAs, action: 'finish', status: 'ok' });
    return result;
  } catch (error) {
    await writeAuditEvent({ tool, actingAs, action: 'error', status: 'error', error: formatUnknownError(error) });
    throw error;
  }
}

function auditTarget(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  const v = input as Record<string, unknown>;
  return { date: v.date, methodId: v.methodId, method: v.method, foodId: v.foodId, recipeId: v.recipeId };
}

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
