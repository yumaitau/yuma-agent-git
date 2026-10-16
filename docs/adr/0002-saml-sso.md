# ADR 0002: SAML sign-in waits for a safe verifier

- Status: Accepted
- Date: 2026-10-16
- Issue: #27 (epic #23)

## Context

Issue #27 asks for SP-initiated SAML 2.0 next to OIDC, but only with a
maintained library that verifies signed assertions and runs on Workers. SAML
security rests on XML Signature checks: canonicalisation, reference
resolution and defences against signature wrapping. Hand-written versions of
these checks are a well-known source of authentication bypasses, so building
our own is not an option.

Candidates checked on 2026-10-16 (npm metadata, package source and GitHub
Security Advisories):

- `samlify` 2.13.1: maintained, but uses Node's `crypto` module and `node-rsa`
  through `xml-crypto`. Advisories include signature wrapping (CVE-2025-47949,
  critical) and XML injection into signed attribute values (CVE-2026-46490,
  high, May 2026).
- `@node-saml/node-saml` 5.1.0: Node-only (`engines: node >= 18`), built on
  `xml-crypto`, `xml2js` and Node `crypto`. Two critical verification bypasses
  in July 2025 (CVE-2025-54369, CVE-2025-54419).
- `xml-crypto` 6.4.0 (the signature layer under both): Node `crypto`, and three
  critical verification bypasses since 2024 (CVE-2024-32962, CVE-2025-29774,
  CVE-2025-29775).
- `xmldsigjs` 2.8.8: uses WebCrypto, so it could load on Workers, but it is an
  XML Signature library only. Assertion checks (which element was signed,
  audience, recipient, time window, replay, one assertion per response) would
  be ours to write, which is the risky part.
- `saml2-js`: Node-only, built on `xml-crypto`.

## Options

1. Run `samlify` or `node-saml` under `nodejs_compat`. Unproven on Workers, and
   the dependency chain has a steady record of critical bypasses.
2. Write SAML checks on `xmldsigjs`. Workers-compatible, but we would own the
   wrapping and assertion checks.
3. Ship OIDC only. Google Workspace and Microsoft Entra ID, the IdPs named in
   #27, both speak OIDC. An organisation that only has SAML can put an
   OIDC-issuing broker in front of it.

## Decision

Option 3. `org_sso.protocol` accepts `saml` in the schema so the setting has a
place to land, but the API refuses it with `saml_unsupported`. Org SSO, its
enforcement and SCIM work with OIDC providers today.

## Consequences

- No XML parsing or XML Signature code on the sign-in path.
- SAML-only IdPs need a broker that issues OIDC, or wait for this ADR to be
  revisited.

## Review triggers

- A maintained SAML library that runs on Workers with WebCrypto, validates
  assertions itself and has an independent security review.
- A customer whose IdP cannot issue OIDC and cannot use a broker.
