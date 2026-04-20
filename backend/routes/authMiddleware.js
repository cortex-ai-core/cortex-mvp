// backend/lib/authMiddleware.js
// =============================================================
// Supabase JWT verification + role + namespace enforcement
// =============================================================

export function requireAuth(role = null) {
  return async function (req, reply) {
    try {
      const header = req.headers["authorization"];

      if (!header) {
        return reply.code(401).send({ error: "Missing authorization header." });
      }

      const token = header.replace("Bearer ", "").trim();

      // 🔥 Use Supabase to validate token
      const { data, error } = await req.server.supabase.auth.getUser(token);

      if (error || !data?.user) {
        return reply.code(401).send({ error: "Invalid or expired token." });
      }

      const user = data.user;

      // Attach user

  req.user = {
  userId: user.id, // ✅ ALIGN WITH FRONTEND
  email: user.email,
  role: user.user_metadata?.role || null,
  namespace: user.user_metadata?.namespace || null,
};



      // Optional role enforcement
      if (role && req.user.role !== role) {
        return reply.code(403).send({ error: "Forbidden (role)" });
      }

    } catch (err) {
      return reply.code(401).send({ error: "Invalid or expired token." });
    }
  };
}
