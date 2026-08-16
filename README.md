# mcp-server-fatsecret

MCP server for the [FatSecret Platform API](https://platform.fatsecret.com/docs) —
food/recipe search plus your own food diary, weight, exercise, saved meals,
and favorites. Built for multiple named individuals sharing one hosted
instance, each linking their own real FatSecret account.

This is an independent, unofficial project. Not affiliated with or endorsed
by FatSecret.

## Scope

- **Public food/recipe database** (search, nutrition detail, recipes) —
  read-only, no personal data involved, authenticated via OAuth2
  client-credentials.
- **Your own FatSecret data** — profile, food diary, weight diary, exercise
  diary, saved meals, favorites, custom foods — read AND write, authenticated
  via a per-person OAuth1 token you link yourself.
- Every write goes through a **prepare → commit** ceremony: `fatsecret_prepare_*`
  returns a dry-run preview with a hash; nothing is sent to FatSecret until a
  `fatsecret_commit_*` call restates that hash plus a fresh idempotency key.

## Multi-user model

This server is designed to run as **one shared instance** behind a gateway
that authenticates callers (e.g. via Entra ID) and forwards the verified
caller identity as `X-MCP-User`. Each person's FatSecret OAuth1 token is
stored in its own encrypted row, keyed by that identity — nobody can reach
anyone else's diary, weight, or exercise data. If `FATSECRET_TRUST_FORWARDED_USER`
is unset (or the header is missing), every data/auth tool refuses outright.

For local development without a gateway, set `FATSECRET_DEV_USER` to act as
a single fixed identity over stdio.

## Setup

1. Register a developer app at [platform.fatsecret.com](https://platform.fatsecret.com)
   to get a consumer key/secret. **Premier tier** is recommended if any user
   is outside the US — the free Basic tier's food database is US-only.
2. Set `FATSECRET_CONSUMER_KEY` / `FATSECRET_CONSUMER_SECRET`.
3. Generate an encryption key for the token store: `openssl rand -hex 32` →
   `FATSECRET_ENCRYPTION_KEY`.
4. Set `FATSECRET_ENABLE_WRITES=true` once you're ready to allow writes (off
   by default).
5. Each person links their own account once: call `fatsecret_start_auth`,
   open the returned URL, sign into (or create) your fatsecret.com account,
   approve, then call `fatsecret_complete_auth` with the PIN FatSecret shows
   you. `fatsecret_check_auth_status` / `fatsecret_disconnect` manage the
   link afterward.

### Claude / Cursor config (local stdio)

```json
{
  "mcpServers": {
    "fatsecret": {
      "command": "npx",
      "args": ["-y", "mcp-server-fatsecret"],
      "env": {
        "FATSECRET_CONSUMER_KEY": "...",
        "FATSECRET_CONSUMER_SECRET": "...",
        "FATSECRET_ENCRYPTION_KEY": "...",
        "FATSECRET_DEV_USER": "you@example.com",
        "FATSECRET_ENABLE_WRITES": "true"
      }
    }
  }
}
```

## API tiers (Basic vs Premier) — read this before wondering why a food is missing

FatSecret's Platform API has a free **Basic** tier and a paid **Premier** tier,
and the split materially affects what this server can do. Note the paid
*consumer app* subscription is a different product and does **not** unlock any
of this.

On **Basic** (the default):
- The food database is **US-only**. `region=DK` and other localization is a
  Premier feature, so non-US foods largely won't be found.
- Only `foods.search` **v1** is available (v2–v5 are Premier).
- **Custom foods (`food.create`) are Premier-only** — you cannot inject your own
  nutrition values.
- **Listing favorites is Premier-only** (`foods.get_favorites`, most-eaten,
  recently-eaten). Adding and removing favorites still works.
- Everything that actually matters for a diary **does** work: logging, editing
  and deleting food entries, copying days, weight, saved meals, and exercise.

Set `FATSECRET_PREMIER=true` **only** if the app has genuinely been upgraded.
Tools backed by Premier-only methods are not registered at all on Basic, so
callers are never offered a tool that can only fail, and any direct call to one
fails fast with an explanation instead of an opaque upstream error.

**Working with non-US foods on Basic:** look the item up in a local food-data
source (e.g. Open Food Facts or a national food-composition database) to get its
real macros, then log the closest match from FatSecret's database with the
serving quantity scaled so the calories and macros line up. Search results
include per-serving macros in `food_description` to make that matching possible.

## Write policy

- `FATSECRET_ENABLE_WRITES=true` — required for any mutating call; off by
  default.
- `FATSECRET_ENABLE_PROFILE_CREATE` — separately gates the account-less
  `profile.create` fallback auth path (dev/test only; see below). Off by
  default even when general writes are enabled.
- `FATSECRET_POLICY_PATH` — optional JSON file to further restrict which
  capabilities/methods are allowed.
- `FATSECRET_AUDIT_LOG` — optional JSONL audit log path. Records
  tool/actingAs/status/a hash of the target — **never** the actual food,
  weight, or exercise data itself, since this is personal health-adjacent
  information.

Every write tool follows: `fatsecret_prepare_*` (dry-run, returns
`operationHash`) → `fatsecret_commit_prepared_operation` (requires the
operation object back, a restated `confirmOperationHash`, and a fresh
`idempotencyKey`). The idempotency key is a **local-only** safety net —
FatSecret's API has no server-side idempotency support, unlike some other
providers — so retrying a commit with the same key only protects you within
this process's lifetime, not across a restart.

## Auth model

The **primary** path is real 3-legged OAuth1 against your own fatsecret.com
account (`fatsecret_start_auth` / `fatsecret_complete_auth`), so your
FatSecret mobile app and this MCP server see the same diary.

A **fallback** path, `profile.create`, can mint an account-less token pair
(no real login, no companion-app access) for quick local testing — gated
separately behind `FATSECRET_ENABLE_PROFILE_CREATE` and its own commit tool,
`fatsecret_commit_profile_create`. Not recommended for real use.

## Exercise logging — a real API limitation

FatSecret has no endpoint to log a single ad-hoc workout. It only supports a
recurring weekly **template** (`exercise_entries.save_template`) that gets
**committed** into a given day's diary (`exercise_entries.commit_day`), plus
shifting minutes between two exercises on an existing day
(`exercise_entry.edit`). `fatsecret_log_one_off_exercise` orchestrates the
template-swap-then-commit sequence for a one-off workout, but it is not
atomic across FatSecret's underlying calls — if it fails partway, your
template may be left modified; the tool reports which steps completed so you
can check and restore it.

## Security / audit

See [SECURITY.md](SECURITY.md). Credentials are read from the server
environment only, never accepted as tool arguments. Per-user tokens are
encrypted at rest (AES-256-GCM).

## Optional HTTP server

`npm run dev:http` (or the published Docker image, which runs
`dist/http.js`) exposes `/mcp` over Streamable HTTP, gated by
`MCP_HTTP_TOKEN`. Intended to sit behind a reverse proxy that authenticates
callers and forwards their identity as `X-MCP-User` (only trusted when
`FATSECRET_TRUST_FORWARDED_USER=true`).

## Verification

```
npm run typecheck && npm test && npm run build
```

For a live check against the real API (requires real credentials and a
linked account): `npm run smoke:live`.

## API sources

- [FatSecret Platform API docs](https://platform.fatsecret.com/docs)
- [Authentication guide](https://platform.fatsecret.com/docs/guides/authentication)

## License

Apache-2.0
