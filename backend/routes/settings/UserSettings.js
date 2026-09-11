import { findUser, membershipsFor, withNamespaces } from "./shared.js";

import { readPreferences, writePreferences, validPreferencesPatch } from "../../lib/userPreferences.js";

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
    try {
      return { preferences: await readPreferences(fastify, user.id) };
    } catch {
      return reply.code(500).send({ error: "Unable to load preferences." });
    }
  });

  fastify.patch("/api/settings/user/preferences", async (req, reply) => {
    const user = await currentUser(req, reply);
    if (!user) return;
    if (!validPreferencesPatch(req.body)) {
      return reply.code(400).send({ error: "Provide a valid response_style or personalization (up to 4,000 characters)." });
    }
    try {
      return { preferences: await writePreferences(fastify, user.id, req.body) };
    } catch {
      return reply.code(500).send({ error: "Unable to save preferences." });
    }
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
