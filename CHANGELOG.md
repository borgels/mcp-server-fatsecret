# Changelog

## Unreleased

- Published to npm and the MCP Registry from tagged releases.

## 0.2.0

### Changes

- HTTP: the server refuses to start without `MCP_HTTP_TOKEN` when bound to a
  non-loopback address or with `MCP_ALLOW_ANY_ORIGIN=true`.
  `MCP_HTTP_ALLOW_UNAUTHENTICATED=true` is an explicit escape hatch.
- HTTP: `MCP_HTTP_TOKEN` must be at least 32 printable ASCII characters.
- HTTP: failed authentications are limited per client address (429 with
  `Retry-After`); valid tokens are never throttled. New `MCP_AUTH_FAILURE_LIMIT`
  (default 20, `0` disables) and `MCP_AUTH_FAILURE_WINDOW_MS` (default 60000).
- HTTP: `Host` header check for loopback binds (`MCP_ALLOWED_HOSTS`).
- HTTP: 401 responses carry `WWW-Authenticate: Bearer`; invalid JSON returns 400
  (JSON-RPC parse error) instead of 500; oversized bodies are refused from
  `Content-Length` before reading; one log line per rejected request.
- HTTP: `GET /healthz`; graceful shutdown on SIGTERM/SIGINT.
- `PORT`, `MCP_MAX_BODY_BYTES`, `FATSECRET_TIMEOUT_MS` and the boolean `MCP_*`
  flags are validated at startup; invalid values stop the server instead of
  becoming `NaN`.
- HTTP: `FATSECRET_TRUST_FORWARDED_USER=true` without `MCP_HTTP_TOKEN` is
  refused as part of the startup configuration checks, cannot be overridden by
  `MCP_HTTP_ALLOW_UNAUTHENTICATED`, and `/mcp` fails closed in that case.
- FatSecret client: redirects are never followed (`redirect: 'manual'`) for
  signed OAuth1 requests and the OAuth2 token request.
- The MCP server reports the package version.
- Dependency updates (`@modelcontextprotocol/sdk` 1.32.2, `zod` 4.6.7, patched
  transitive dependencies). CI: pinned actions, image build on pull requests,
  images published only after tests pass, with SBOM and provenance.
- Prepared operations are HMAC-signed (`FATSECRET_PREPARE_SECRET`), expire after
  15 minutes and are bound to the preparing user; write policy is re-evaluated
  at commit; reserved request parameters are rejected.
- Separate OAuth1 (consumer key/shared secret) and OAuth2 (client id/secret)
  credentials.
- Premier-only methods are only registered with `FATSECRET_PREMIER=true`.

### Upgrade notes

- A non-loopback bind (`HOST`/`MCP_HTTP_HOST=0.0.0.0`) or
  `MCP_ALLOW_ANY_ORIGIN=true` now requires `MCP_HTTP_TOKEN` of at least 32
  characters (e.g. `openssl rand -hex 32`). A shorter token stops the server.
- Invalid values for the variables above now stop the server at startup.
- Deployments binding `0.0.0.0` must set `MCP_HTTP_TOKEN` (they already must
  when `FATSECRET_TRUST_FORWARDED_USER=true`).
- Existing variable names are unchanged.

## 0.1.0

Initial release.

- Read/write coverage of the FatSecret Platform API: food/recipe search,
  food diary, weight diary, exercise diary (within FatSecret's
  template/commit-day model — see README), saved meals, favorites, custom
  foods, and profile.
- Per-user OAuth1 (3-legged, out-of-band PIN flow) so each person links their
  own real fatsecret.com account — no shared credential.
- Multi-user, single-instance deployment: identity comes from the
  gateway-verified `X-MCP-User` header, tokens are stored per-user, encrypted
  at rest (AES-256-GCM).
- Prepare → commit write-safety ceremony (operation hash, idempotency key,
  audit log) for every mutating call, mirroring `mcp-server-e-conomic`.
