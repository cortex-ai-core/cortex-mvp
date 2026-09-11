# Settings API

All requests require `Authorization: Bearer <token>`.

- `super_admin` can manage every organization and its users/memberships.
- `admin` is restricted to the `organizationId` signed into their JWT, cannot
  create/assign `super_admin`, and cannot move users between organizations.
- Other roles receive `403` from management endpoints.

## User settings

`GET /api/settings/user`

Available to any authenticated user. Returns:

```json
{ "user": { "id": "uuid", "email": "...", "role": {}, "organization": {}, "namespaces": [] } }
```

## Organizations

`GET /api/settings/organizations`

Returns `{ "organizations": [...] }`. A super-admin receives all organizations;
an admin receives only their JWT organization. Each item contains `namespaces`.

`POST /api/settings/organizations` (super-admin only)

```json
{ "name": "Organization name", "description": "Optional description" }
```

Returns `201 { "organization": { ... } }`; duplicate names return `409` when
the database has a corresponding unique constraint.

`PATCH /api/settings/organizations/:organizationId`

```json
{ "name": "Optional new name", "description": "Optional description" }
```

Returns `200 { "organization": { ... } }`. An admin may update only their own
organization; a super-admin may update any organization.

`POST /api/settings/organizations/:organizationId/namespaces`

```json
{ "name": "Namespace name", "description": "Optional description" }
```

Returns `201 { "namespace": { ... } }`. A duplicate name within the same
organization returns `409`. The same name may be used in another organization.

`PATCH /api/settings/organizations/:organizationId/namespaces/:namespaceId`

```json
{ "name": "Optional new name", "description": "Optional description" }
```

Returns `200 { "namespace": { ... } }`. The namespace must belong to the path
organization. Admin is limited to their JWT organization; super-admin may use
any organization. Duplicate names within an organization return `409`.

## Roles

`GET /api/settings/roles`

Returns `{ "roles": [...] }`. Super-admin receives every role; admin does not
receive `super_admin` as an assignable role.

## Users

`GET /api/settings/users?namespaceId=<optional-uuid>`

Returns `{ "users": [...] }`. Results are organization-scoped for admin. The
optional namespace must also be within the caller's scope.

`POST /api/settings/users`

```json
{
  "email": "person@example.com",
  "password": "temporary-password",
  "role": "admin",
  "organizationId": "uuid",
  "namespaceIds": ["uuid"]
}
```

Names remain supported as `organization` plus `namespaces`. For admin,
organization input is ignored and the JWT organization is used. Returns
`201 { "user": { ... } }`. Creation rolls back Auth/application records if a
later step fails.

`PATCH /api/settings/users/:userId`

```json
{
  "active": true,
  "roleId": "uuid",
  "organizationId": "uuid"
}
```

Names `role` and `organization` are also accepted. Admin cannot target a user
outside their organization, target/assign `super_admin`, or supply an
organization change. Returns `200 { "user": { ... } }`.

## Namespace membership

`GET /api/settings/namespaces/:namespaceId/users`

Returns `{ "namespace": { ... }, "users": [...] }`, subject to organization
scope.

`PUT /api/settings/users/:userId/namespaces`

```json
{ "namespaceIds": ["uuid", "uuid"] }
```

Replaces the complete membership set and returns
`200 { "userId": "uuid", "namespaces": [...] }`.

The following equivalent routes add one membership idempotently:

- `POST /api/settings/users/:userId/namespaces` with `{ "namespaceId": "uuid" }`
- `POST /api/settings/namespaces/:namespaceId/users` with `{ "userId": "uuid" }`

They return `201` when created or `200` when already assigned.

The following equivalent routes remove one membership:

- `DELETE /api/settings/users/:userId/namespaces/:namespaceId`
- `DELETE /api/settings/namespaces/:namespaceId/users/:userId`

They return `204`. Removing the final namespace is rejected with `409`.
Every mutation verifies both the target user's organization and the namespace's
organization on the server.

## Personas and PCL

Personas are named definitions (spec 4.4); their rules live in `pcl` as an
append-only version history, and the highest version is the one in force.
A persona with no `organization_id` is shared by every organization and can be
changed only by a super-admin. Admin sees shared personas plus their own
organization's. All routes need the `manage_personas` or `manage_pcl`
permission, which `admin` and `super_admin` hold. Every write logs an event
line (`persona_created`, `pcl_version_created`, `persona_activated`,
`persona_deactivated`, `user_persona_assigned`, `namespace_persona_assigned`)
and clears the chat resolver's cache, so the next turn sees the change.

`GET /api/settings/personas`

Returns `{ "personas": [ { id, key, name, description, is_active, shared,
organization, current_version: { version, created_by, created_at } | null,
users, namespaces } ] }` where `users` and `namespaces` count assignments.

`POST /api/settings/personas`

```json
{ "key": "talent_intelligence", "name": "Talent Intelligence",
  "description": "Optional", "configuration": { "schema": 1, "...": "..." } }
```

Creates the persona in the caller's organization with a validated version 1.
Super-admin may add `"shared": true` or `"organizationId": "uuid"`. Returns
`201 { "persona", "version", "warnings" }`; an invalid configuration returns
`400 { "error", "errors", "warnings" }` and creates nothing; a duplicate key
returns `409`.

`PATCH /api/settings/personas/:id`

```json
{ "name": "Optional new name", "description": "Optional description" }
```

Name and description only. Returns `200 { "persona" }`.

`GET /api/settings/personas/:id/versions`

Returns `{ "persona", "versions": [ { id, version, configuration, created_by,
created_at } ] }`, newest first. With `rag_queries.pcl` this is the audit of
which rules were in force for any answer.

`POST /api/settings/personas/:id/versions`

Body is a configuration object (or `{ "configuration": { ... } }`). Validates
it; on pass inserts version + 1 and returns `201 { "persona", "version",
"warnings" }`; on fail returns `400 { "error", "errors", "warnings" }` and
inserts nothing, so the previous version stays in force. Rolling back is
posting an older version's configuration again.

Configuration keys (all optional; unknown keys are refused): `schema` (1),
`identity: { text }`, `response: { style, length }`, the list sections
`operating_instructions`, `evaluation_rules`, `evidence_requirements`,
`decision_rules`, `formatting`, `output_structure`, `workflow`,
`domain_instructions`, `required`, `prohibited`, `terminology: { prefer: {},
protect: [] }`, `lock_style`. Limits: 400 characters per item, 2,000 per
section, 6,000 rendered in total. Phrases that try to cross the boundary
between presentation and evidence ("ignore the sources", "general
knowledge", "namespace", "role", ...) are refused and named.

`POST /api/settings/personas/:id/activate` and `/deactivate`

Returns `200 { "persona" }`. Deactivating a persona that is a namespace
default returns `409 { "error", "namespaces" }` naming the namespaces.

`PATCH /api/settings/users/:userId/persona`

```json
{ "persona_id": "uuid" }
```

`null` clears the assignment. The persona must be active and shared or in
the user's organization. Writes only `user_settings.persona_id`; returns
`200 { "user": { ...role, organization, namespaces unchanged }, "persona" }`.
Admin scope rules are the same as for personalization.

`PATCH /api/settings/namespaces/:id/persona`

```json
{ "persona_id": "uuid" }
```

Sets the namespace's default persona (`null` clears it). Returns
`200 { "namespace": { ..., "default_persona" } }`.

`GET /api/settings/personas/preview?userId=<uuid>[&namespaceId=<uuid>][&toneMode=<style>]`

What that user would get on their next chat turn: `{ user, source, reason,
persona, persona_source, version, style, style_source, personalization,
rendered, provenance }`. `rendered` holds the prompt blocks (`persona`,
`structureRules`, `task`, `rules`, `terminology`, `personalization`).
