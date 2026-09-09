import { findUser, membershipsFor, withNamespaces } from "./shared.js";

const responseStyles = new Set([
  "neutral", "ceo", "king", "advisory", "recruiting",
  "cybersecurity", "datamanagement", "ventures",
]);

export default async function userSettings(fastify) {
  async function currentUser(req, reply) {
    if (!req.user?.userId) {
      reply.code(401).send({ error: "Authentication required." });
      return null;
    }
    const { data: user, error } = await findUser(fastify, req.user.userId);
    if (error) {
      reply.code(500).send({ error: "Unable to load user." });
      return null;
    }
    if (!user?.active) {
      reply.code(403).send({ error: "Account is not active." });
      return null;
    }
    return user;
  }

  fastify.get("/api/settings/user/preferences", async (req, reply) => {
    const user = await currentUser(req, reply);
    if (!user) return;
    const { data, error } = await fastify.supabase
      .from("user_settings")
      .select("response_style")
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) {
      return reply.code(500).send({ error: "Unable to load preferences." });
    }
    return { preferences: data || { response_style: "neutral" } };
  });

  fastify.patch("/api/settings/user/preferences", async (req, reply) => {
    const user = await currentUser(req, reply);
    if (!user) return;
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some((key) => key !== "response_style") ||
        !responseStyles.has(body.response_style)) {
      return reply.code(400).send({ error: "Provide a valid response_style only." });
    }
    const { data, error } = await fastify.supabase
      .from("user_settings")
      .upsert({ user_id: user.id, response_style: body.response_style }, { onConflict: "user_id" })
      .select("response_style")
      .single();
    if (error) {
      return reply.code(500).send({ error: "Unable to save preferences." });
    }
    return { preferences: data };
  });

  // GET /api/settings/user
  // Returns the signed-in user's application profile and every namespace to
  // which that user belongs. Unlike administration routes, any authenticated
  // user can retrieve their own settings.
  fastify.get("/api/settings/user", async (req, reply) => {
    const { data: user, error } = await findUser(fastify, req.user.userId);
    if (error) return reply.code(500).send({ error: "Unable to load user settings." });
    if (!user) return reply.code(404).send({ error: "User not found." });
    const { data: memberships, error: membershipError } =
      await membershipsFor(fastify, [user.id]);
    if (membershipError) {
      return reply.code(500).send({ error: "Unable to load namespace memberships." });
    }
    return { user: withNamespaces([user], memberships)[0] };
  });
}
