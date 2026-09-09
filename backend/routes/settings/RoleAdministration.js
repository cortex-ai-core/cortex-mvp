import { requireSettingsManager } from "./shared.js";

export default async function roleAdministration(fastify) {
  // GET /api/settings/roles
  // Returns the role catalogue used by User Management. Access is restricted
  // to super administrators because roles control application permissions.
  fastify.get("/api/settings/roles", async (req, reply) => {
    const scope = requireSettingsManager(req, reply);
    if (!scope) return;
    let query = fastify.supabase
      .from("role")
      .select("id,name,description,created_at")
      .order("name");
    if (!scope.isSuperAdmin) query = query.neq("name", "super_admin");
    const { data, error } = await query;
    if (error) return reply.code(500).send({ error: "Unable to load roles." });
    return { roles: data };
  });
}
