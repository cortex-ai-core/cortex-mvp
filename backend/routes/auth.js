import jwt from "jsonwebtoken";
import { sessionConfig } from "../lib/services/config.js";

const slug = (value) => typeof value === "string" ? value.trim().toLowerCase() : "";

export default async function authRoutes(fastify) {
  const auth = fastify.authentication;
  const session = sessionConfig();

  // POST /api/auth/login
  // Authenticates with the configured provider, loads the matching
  // application role, organization, and namespace memberships, then issues
  // the Cortéx JWT consumed by the frontend and protected API routes.
  fastify.post("/api/auth/login", async (req, reply) => {
    const body = req.body || {};
    const email = slug(body.email || body.username);
    const password = typeof body.password === "string" ? body.password : "";
    if (!email || !password) {
      return reply.code(400).send({ error: "Email and password are required." });
    }

    try {
      const { data, error } = await auth.signInWithPassword({ email, password });
      if (error || !data.user) {
        return reply.code(error?.status || 401).send({ error: error?.message || "Invalid credentials." });
      }

      const { data: profile, error: profileError } = await fastify.supabase
        .from("user")
        .select(`
          id, auth_user_id, email, active,
          role:role_id(id,name),
          organization:organization_id(id,name)
        `)
        .eq(auth.profileColumn, data.user.id)
        .maybeSingle();
      if (profileError) throw profileError;
      if (!profile?.active || !profile.role || !profile.organization) {
        return reply.code(403).send({ error: "Account is not authorized for Cortéx." });
      }

      const { data: memberships, error: membershipError } = await fastify.supabase
        .from("namespace_users")
        .select("namespace:namespace_id(id,name,organization_id)")
        .eq("user_id", profile.id)
        .order("created_at", { ascending: true });
      if (membershipError) throw membershipError;

      const namespaceRecords = (memberships || [])
        .map((membership) => membership.namespace)
        .filter((item) => item?.organization_id === profile.organization.id);
      const namespaceNames = namespaceRecords.map((item) => slug(item.name));
      const namespaceIds = namespaceRecords.map((item) => item.id);
      if (!namespaceIds.length) {
        return reply.code(403).send({ error: "Account has no authorized namespace." });
      }

      // The namespace id is the only key. A caller may pick one by id
      // (preferred) or, for older clients, by name; otherwise the first
      // membership is used.
      const requestedId = typeof body.namespaceId === "string" ? body.namespaceId.trim() : "";
      const requestedName = slug(body.namespace);
      let selected = null;
      if (requestedId) selected = namespaceRecords.find((item) => item.id === requestedId) || null;
      else if (requestedName) selected = namespaceRecords.find((item) => slug(item.name) === requestedName) || null;
      else selected = namespaceRecords[0];
      if (!selected) {
        return reply.code(403).send({ error: "Namespace access denied." });
      }

      const organizations = [{
        id: profile.organization.id,
        name: profile.organization.name,
        namespaces: namespaceRecords.map(({ id, name }) => ({ id, name })),
      }];
      const claims = {
        userId: profile.id,
        email: profile.email,
        role: profile.role.name,
        organization: profile.organization.name,
        organizationId: profile.organization.id,
        namespaceId: selected.id,
        namespace: selected.name,        // display only; never a lookup key
        namespaces: namespaceIds,
        organizations,
      };

      return {
        token: jwt.sign(claims, session.secret, { expiresIn: "7d", ...session.options }),
        user: { ...claims, namespaceNames },
      };
    } catch (err) {
      req.log.error({ err }, "Login failed");
      return reply.code(500).send({ error: "Login failed." });
    }
  });
}
