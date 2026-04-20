// =============================================================
//  CORTÉX — AUTH MIDDLEWARE (SOVEREIGN / PRODUCTION SAFE)
// =============================================================

import jwt from "jsonwebtoken";

// =============================================================
//  STRICT SECRET — NO FALLBACKS (SOVEREIGN MODE)
// =============================================================
const jwtSecret = process.env.JWT_SECRET;

if (!jwtSecret) {
  throw new Error("JWT_SECRET is not defined. System cannot start.");
}

// =============================================================
//  ROLE PERMISSIONS MATRIX
// =============================================================
const rolePermissions = {
  super_admin: [
    "upload_documents",
    "upload_persistent",
    "upload_ephemeral",
    "delete_documents",
    "manage_users",
    "view_documents"
  ],
  admin: [
    "upload_documents",
    "upload_persistent",
    "upload_ephemeral",
    "delete_documents",
    "view_documents"
  ],
  operator: [
    "upload_ephemeral",
    "view_documents"
  ],
  viewer: [
    "view_documents"
  ],
  client: []
};

// =============================================================
//  HELPER — EXTRACT TOKEN SAFELY
// =============================================================
function extractToken(req) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return null;
  }

  return header.replace("Bearer ", "").trim();
}

// =============================================================
//  requireAuth — GLOBAL AUTH CHECK
// =============================================================
export async function requireAuth(req, reply) {
  try {
    const token = extractToken(req);

    if (!token) {
      return reply.code(401).send({
        error: "Missing or invalid authorization header."
      });
    }

    const decoded = jwt.verify(token, jwtSecret);

    // Attach user context
    req.user = decoded;

    return; // ✅ allow request to proceed

  } catch (err) {
    return reply.code(401).send({
      error: "Invalid or expired token.",
      detail: err.message
    });
  }
}

// =============================================================
//  requirePermission — RBAC + NAMESPACE ENFORCEMENT
// =============================================================
export function requirePermission(permission) {
  return async function (req, reply) {
    try {
      const token = extractToken(req);

      if (!token) {
        return reply.code(401).send({
          error: "Missing or invalid authorization header."
        });
      }

      const decoded = jwt.verify(token, jwtSecret);
      req.user = decoded;

      const { role, namespace } = decoded;

      // =========================================================
      //  ROLE PERMISSION CHECK
      // =========================================================
      const allowed = rolePermissions[role]?.includes(permission);

      if (!allowed) {
        return reply.code(403).send({
          error: "Insufficient permission."
        });
      }

      // =========================================================
      //  NAMESPACE ENFORCEMENT (SUPER ADMIN BYPASS)
      // =========================================================
      if (role !== "super_admin") {
        const reqNamespace =
          req.body?.namespace ||
          req.query?.namespace ||
          req.params?.namespace;

        if (reqNamespace && reqNamespace !== namespace) {
          return reply.code(403).send({
            error: "Namespace mismatch — access denied."
          });
        }
      }

      return; // ✅ allow request to proceed

    } catch (err) {
      return reply.code(401).send({
        error: "Invalid or expired token.",
        detail: err.message
      });
    }
  };
}
