// =============================================================
//  CORTÉX — AUTH ROUTES (SOVEREIGN LOGIN)
// =============================================================

import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is not defined.");
}

// -------------------------------------------------------------
// 🔐 LOGIN ROUTE
// -------------------------------------------------------------
export default async function authRoutes(fastify) {

  fastify.post("/api/auth/login", async (req, reply) => {
    try {
      const { username, password } = req.body;

      // ======================================================
      // 👑 CORE (YOU — SUPER ADMIN)
      // ======================================================
      if (username === "king" && password === "king123") {
        return {
          token: jwt.sign(
            {
              userId: "king",
              role: "super_admin",
              namespace: "core"
            },
            JWT_SECRET,
            { expiresIn: "7d" }
          )
        };
      }

      // ======================================================
      // 🌴 HAWAII (CLIENT PILOT)
      // ======================================================
      if (username === "hawaii" && password === "hawaii") {
        return {
          token: jwt.sign(
            {
              userId: "hawaii_user",
              role: "super_admin", // 🔥 UPDATED
              namespace: "hawaii"
            },
            JWT_SECRET,
            { expiresIn: "7d" }
          )
        };
      }

      // ======================================================
      // 🧠 ADVISORY (INTERNAL)
      // ======================================================
      if (username === "advisory" && password === "advisory") {
        return {
          token: jwt.sign(
            {
              userId: "advisory_user",
              role: "super_admin", // 🔥 UPDATED
              namespace: "advisory"
            },
            JWT_SECRET,
            { expiresIn: "7d" }
          )
        };
      }

      // ======================================================
      // 🎯 RECRUITING (INTERNAL)
      // ======================================================
      if (username === "recruiting" && password === "recruiting") {
        return {
          token: jwt.sign(
            {
              userId: "recruiting_user",
              role: "super_admin", // 🔥 UPDATED
              namespace: "recruiting"
            },
            JWT_SECRET,
            { expiresIn: "7d" }
          )
        };
      }

      // ======================================================
      // 🔐 CYBERSECURITY (INTERNAL)
      // ======================================================
      if (username === "cyber" && password === "cyber") {
        return {
          token: jwt.sign(
            {
              userId: "cyber_user",
              role: "super_admin", // 🔥 UPDATED
              namespace: "cybersecurity"
            },
            JWT_SECRET,
            { expiresIn: "7d" }
          )
        };
      }

      // ======================================================
      // 📊 DATA MANAGEMENT (INTERNAL)
      // ======================================================
      if (username === "data" && password === "data") {
        return {
          token: jwt.sign(
            {
              userId: "data_user",
              role: "super_admin", // 🔥 UPDATED
              namespace: "datamanagement"
            },
            JWT_SECRET,
            { expiresIn: "7d" }
          )
        };
      }

      // ======================================================
      // ❌ INVALID LOGIN
      // ======================================================
      return reply.code(401).send({
        error: "Invalid credentials"
      });

    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({
        error: "Login failed"
      });
    }
  });

}
