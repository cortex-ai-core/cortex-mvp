import jwt from "jsonwebtoken";
import { createClient } from "@supabase/supabase-js";

const ALLOWED_ROLES = new Set([
  "super_admin", "admin", "operator", "viewer", "client",
]);

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not defined.`);
  return value;
}

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeSlug(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function issueApplicationToken(profile, selectedNamespace, namespaces) {
  return jwt.sign(
    {
      userId: profile.id,
      email: profile.email,
      role: profile.role.name,
      organization: profile.organization.name,
      namespace: selectedNamespace,
      namespaces,
    },
    requiredEnv("JWT_SECRET"),
    { expiresIn: "7d" }
  );
}

export default async function authRoutes(fastify) {
  const supabaseUrl = requiredEnv("SUPABASE_URL");
  const supabaseAnonKey =
    process.env.SUPABASE_ANON_KEY?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();

  if (!supabaseAnonKey) throw new Error("SUPABASE_ANON_KEY is not defined.");

  const authClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  fastify.post("/api/auth/login", async (req, reply) => {
    try {
      const body = req.body || {};
      // Accept `username` until Ian's form is renamed to email.
      const email = normalizeEmail(body.email || body.username);
      const password = typeof body.password === "string" ? body.password : "";

      if (!email || !password) {
        return reply.code(400).send({ error: "Email and password are required." });
      }

      const { data, error } = await authClient.auth.signInWithPassword({
        email,
        password,
      });

      if (error || !data.user) {
        return reply.code(401).send({ error: "Invalid credentials." });
      }

      const { data: profile, error: profileError } = await fastify.supabase
        .from("user")
        .select(`
          id,
          auth_user_id,
          email,
          active,
          role:role_id(id,name),
          organization:organization_id(id,name)
        `)
        .eq("auth_user_id", data.user.id)
        .maybeSingle();

      if (profileError) {
        req.log.error({ err: profileError }, "Application user lookup failed");
        return reply.code(500).send({ error: "Unable to load account." });
      }

      if (!profile || !profile.active || !profile.role || !profile.organization) {
        return reply.code(403).send({ error: "Account is not authorized for Cortéx." });
      }

      const { data: memberships, error: membershipError } = await fastify.supabase
        .from("namespace_users")
        .select("namespace:namespace_id(id,name,organization_id)")
        .eq("user_id", profile.id)
        .order("created_at", { ascending: true });

      if (membershipError) {
        req.log.error({ err: membershipError }, "Namespace membership lookup failed");
        return reply.code(500).send({ error: "Unable to load account namespaces." });
      }

      const namespaces = (memberships || [])
        .map((membership) => membership.namespace)
        .filter((item) => item?.organization_id === profile.organization.id)
        .map((item) => item.name);

      if (namespaces.length === 0) {
        return reply.code(403).send({ error: "Account has no authorized namespace." });
      }

      const selectedNamespace = normalizeSlug(body.namespace) || namespaces[0];
      if (!namespaces.includes(selectedNamespace)) {
        return reply.code(403).send({ error: "Namespace access denied." });
      }

      return {
        token: issueApplicationToken(profile, selectedNamespace, namespaces),
        user: {
          userId: profile.id,
          email: profile.email,
          role: profile.role.name,
          organization: profile.organization.name,
          namespace: selectedNamespace,
          namespaces,
        },
      };
    } catch (err) {
      req.log.error({ err }, "Login failed");
      return reply.code(500).send({ error: "Login failed." });
    }
  });

  fastify.post("/api/admin/users", async (req, reply) => {
    if (req.user?.role !== "super_admin") {
      return reply.code(403).send({ error: "Super administrator access required." });
    }

    const body = req.body || {};
    const email = normalizeEmail(body.email);
    const password = typeof body.password === "string" ? body.password : "";
    const role = normalizeSlug(body.role);
    const organization = typeof body.organization === "string"
      ? body.organization.trim()
      : "";
    const requestedNamespaces = Array.isArray(body.namespaces)
      ? body.namespaces.map(normalizeSlug).filter(Boolean)
      : [normalizeSlug(body.namespace)].filter(Boolean);

    if (!email || !password || !role || !organization || requestedNamespaces.length === 0) {
      return reply.code(400).send({
        error: "Email, password, role, organization, and at least one namespace are required.",
      });
    }

    if (!ALLOWED_ROLES.has(role)) {
      return reply.code(400).send({ error: "Invalid role." });
    }

    if (password.length < 8) {
      return reply.code(400).send({ error: "Password must be at least 8 characters." });
    }

    let createdUserId = null;

    try {
      const { data: created, error: createError } =
        await fastify.supabase.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
        });

      if (createError || !created.user) {
        return reply.code(400).send({
          error: createError?.message || "Unable to create Supabase user.",
        });
      }

      createdUserId = created.user.id;

      const { data: roleRecord, error: roleError } = await fastify.supabase
        .from("role")
        .select("id,name")
        .ilike("name", role)
        .maybeSingle();

      const { data: organizationRecord, error: organizationError } =
        await fastify.supabase
          .from("organization")
          .select("id,name")
          .ilike("name", organization)
          .maybeSingle();

      if (roleError || !roleRecord || organizationError || !organizationRecord) {
        await fastify.supabase.auth.admin.deleteUser(createdUserId);
        return reply.code(400).send({
          error: !roleRecord
            ? "The requested role does not exist."
            : "The requested organization does not exist.",
        });
      }

      const uniqueNamespaces = [...new Set(requestedNamespaces)];
      const { data: namespaceRecords, error: namespaceError } =
        await fastify.supabase
          .from("namespace")
          .select("id,name,organization_id")
          .in("name", uniqueNamespaces)
          .eq("organization_id", organizationRecord.id);

      if (namespaceError || namespaceRecords?.length !== uniqueNamespaces.length) {
        await fastify.supabase.auth.admin.deleteUser(createdUserId);
        return reply.code(400).send({
          error: "One or more namespaces do not exist in that organization.",
        });
      }

      const { data: profile, error: profileError } = await fastify.supabase
        .from("user")
        .insert({
          auth_user_id: createdUserId,
          email,
          role_id: roleRecord.id,
          organization_id: organizationRecord.id,
          active: true,
        })
        .select(`
          id,
          auth_user_id,
          email,
          active,
          created_at,
          role:role_id(id,name),
          organization:organization_id(id,name)
        `)
        .single();

      if (profileError) {
        await fastify.supabase.auth.admin.deleteUser(createdUserId);
        req.log.error({ err: profileError }, "Application user creation failed");
        return reply.code(500).send({ error: "Unable to create application user." });
      }

      const { error: membershipError } = await fastify.supabase
        .from("namespace_users")
        .insert(namespaceRecords.map((record) => ({
          user_id: profile.id,
          namespace_id: record.id,
        })));

      if (membershipError) {
        await fastify.supabase.from("user").delete().eq("id", profile.id);
        await fastify.supabase.auth.admin.deleteUser(createdUserId);
        req.log.error({ err: membershipError }, "Namespace assignment failed");
        return reply.code(500).send({ error: "Unable to assign namespaces." });
      }

      return reply.code(201).send({
        user: {
          ...profile,
          namespaces: namespaceRecords.map((record) => record.name),
        },
      });
    } catch (err) {
      if (createdUserId) {
        try {
          await fastify.supabase.auth.admin.deleteUser(createdUserId);
        } catch {}
      }
      req.log.error({ err }, "Administrator user creation failed");
      return reply.code(500).send({ error: "Unable to create user." });
    }
  });
}
