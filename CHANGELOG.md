# Changelog

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
