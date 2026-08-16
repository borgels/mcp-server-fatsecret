#!/usr/bin/env node
/**
 * Opt-in live smoke test against the real FatSecret API. Not run by `npm test`.
 * Requires FATSECRET_CONSUMER_KEY/_CONSUMER_SECRET, and (for the private-data
 * check) an already-linked token in FATSECRET_STORE_PATH for FATSECRET_DEV_USER.
 */
import { FatSecretClient } from '../src/fatsecret/client.js';
import { TokenStore } from '../src/fatsecret/token-store.js';

async function main(): Promise<void> {
  const client = new FatSecretClient();
  console.error('Searching public food database for "apple"...');
  const search = await client.publicRequest('foods.search', { search_expression: 'apple', max_results: 1 });
  console.error(JSON.stringify(search, null, 2));

  const devUser = process.env.FATSECRET_DEV_USER;
  if (!devUser) {
    console.error('FATSECRET_DEV_USER not set — skipping private-data check.');
    return;
  }
  const store = new TokenStore();
  if (!store.getTokens(devUser)) {
    console.error(`No linked token for ${devUser} — run the auth flow first. Skipping private-data check.`);
    return;
  }
  console.error(`Fetching profile for ${devUser}...`);
  const profile = await client.userRequest(devUser, store, 'profile.get', {});
  console.error(JSON.stringify(profile, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
