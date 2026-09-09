import jwt from "jsonwebtoken";
import { createClient } from "@supabase/supabase-js";

const requiredEnv = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not defined.`);
  return value;
};

const slug = (value) => typeof value === "string" ? value.trim().toLowerCase() : "";

export default async function authRoutes(fastify) {
  const anonKey = process.env.SUPABASE_ANON_KEY?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!anonKey) throw new Error("SUPABASE_ANON_KEY is not defined.");

  const auth = createClient(requiredEnv("SUPABASE_URL"), anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // POST /api/auth/login
  // Authenticates an email/password with Supabase Auth, loads the matching
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
      const { data, error } = await auth.auth.signInWithPassword({ email, password });
      if (error || !data.user) {
        return reply.code(401).send({ error: "Invalid credentials." });
      }

      const { data: profile, error: profileError } = await fastify.supabase
        .from("user")
        .select(`
          id, auth_user_id, email, active,
          role:role_id(id,name),
          organization:organization_id(id,name)
        `)
        .eq("auth_user_id", data.user.id)
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
      if (!namespaceNames.length) {
        return reply.code(403).send({ error: "Account has no authorized namespace." });
      }

      const selectedNamespace = slug(body.namespace) || namespaceNames[0];
      if (!namespaceNames.includes(selectedNamespace)) {
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
        namespace: selectedNamespace,
        namespaces: namespaceIds,
        organizations,
      };

      return {
        token: jwt.sign(claims, requiredEnv("JWT_SECRET"), { expiresIn: "7d" }),
        user: { ...claims, namespaceNames },
      };
    } catch (err) {
      req.log.error({ err }, "Login failed");
      return reply.code(500).send({ error: "Login failed." });
    }
  });
}
