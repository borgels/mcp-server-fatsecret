# Security Policy

## Reporting A Vulnerability

Report suspected vulnerabilities privately to <security@borgels.com>.

Do not include API keys, OAuth1 consumer/token secrets, personal nutrition,
weight, or exercise data, or other secrets in public GitHub issues. Include a
concise description, affected package/version, reproduction steps, and impact
where possible.

## Supported Versions

Security fixes are targeted at the latest `main` branch and the latest published
release, when one exists.

## Credential Handling

This MCP server reads provider credentials only from the server environment and
does not accept credentials as tool arguments. Per-user FatSecret OAuth1 access
tokens are encrypted at rest (AES-256-GCM, key from `FATSECRET_ENCRYPTION_KEY`)
and are never returned in tool output. If you believe a token or consumer
secret was exposed, rotate it immediately: disconnect and reconnect the
affected FatSecret account (rotates the user's OAuth1 token) and/or regenerate
the consumer key/secret in the FatSecret Platform developer console.

Food, weight, and exercise diary data is personal health-adjacent information —
treat it with the same care as other personal data, not merely as business data.
