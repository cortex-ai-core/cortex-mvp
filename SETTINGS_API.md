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
