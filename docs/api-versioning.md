# API versioning and deprecation

This policy covers the HTTP API described by [`docs/openapi.json`](openapi.json)
(also served at `GET /api/v1/openapi.json` to signed-in callers). The
human-readable reference, with access rules and rate limits, is
[`docs/api.md`](api.md).

## Where the contract lives

- `worker/src/api/contract.ts` gives every route a stable `operationId` and points
  at the zod schemas the handlers parse request bodies with. Query parameters are
  declared there too.
- `npm run docs:openapi` walks the real Hono router and writes `docs/api.md`,
  `docs/openapi.json` (OpenAPI 3.1) and the generated SDK types in
  `sdk/src/schema.ts`. Never edit those by hand.
- CI regenerates all three and fails on any diff, and lints the document with
  Redocly. `worker/test/openapi.test.ts` fails when a mounted route is missing from
  the document or when the document no longer matches the zod schemas.
- The MCP server (#56) and the gh-compatible shim (#74) should reuse the same
  `operationId`s and schemas rather than defining their own.

## Path versioning

The major version is in the path: `/api/v1`. There is no version header. A
breaking change ships under a new prefix (`/api/v2`) next to the old one, and the
old prefix follows the deprecation process below.

Routes outside `/api` (`/auth/*`, `/scim/v2/*`, `/webhooks/*`, Git smart HTTP)
follow the protocol they implement and the same notice periods.

## What may change within v1

Only additive changes:

- new routes and new operations;
- new optional request fields and new optional query parameters;
- new response fields, and new values in response enums;
- new error `code` strings for new failure cases;
- looser limits (a longer maximum, a wider accepted set).

Clients must ignore response fields they do not know and must treat unknown
error codes by their HTTP status.

These are breaking and need a new major version:

- removing or renaming a route, an `operationId`, a field or a query parameter;
- making an optional input required, or narrowing what is accepted;
- changing a field's type or meaning;
- changing an existing error `code` or the `{ error: { code, message } }` envelope;
- changing pagination shape on an existing list route.

Security fixes are the one exception: a route may start refusing requests it
should never have accepted, without notice, and the change is called out in
`CHANGELOG.md`.

## Deprecation

When a route, field or parameter is to be removed:

1. Mark the operation `deprecated: true` in `docs/openapi.json` (no route is
   deprecated yet; add a `deprecated` flag to `RouteContract` and the generator
   the first time one is) and note it in `CHANGELOG.md`.
2. Responses from a deprecated operation carry
   - `Deprecation: @<unix-seconds>` ([RFC 9745](https://www.rfc-editor.org/rfc/rfc9745))
     with the date it was deprecated,
   - `Sunset: <HTTP-date>` ([RFC 8594](https://www.rfc-editor.org/rfc/rfc8594))
     with the earliest removal date, and
   - `Link: <https://…/docs/api-versioning.md>; rel="deprecation"`.
3. The sunset date is at least **90 days** after the deprecation is announced. The
   `yag` CLI and the dashboard move off the deprecated surface before then.
4. After the sunset date the route answers `410 Gone` with the usual error envelope
   for a further 30 days, then it is removed.

## Pagination

The standard list shape is `?cursor=&limit=` in the request and `next_cursor` in
the body (`null` on the last page). `listRefs`, `listTags`, `listRepos`,
`listChangesets` and `searchOrgAudit` use it today. Other list routes still have
their older shapes (`listPulls` takes `before`, `getHistory` returns `next`, some
lists are capped without a cursor). Moving them over has to be additive under this policy: accept
`cursor` alongside the old parameter and return `next_cursor` alongside the old
field, then deprecate the old names.
