import { createClient } from "@supabase/supabase-js";
import jwt from "jsonwebtoken";
import { backendProvider, required } from "./config.js";
import { createS3Storage } from "./storage.js";
import { createLocalStorage } from "./localStorage.js";

// Retain the existing Supabase/PostgREST query API, including joins and RPCs.
// AWS uses a private PostgREST process pointed at RDS, not Supabase's servers.
export function createDatabaseClient(env = process.env, fetchImpl = globalThis.fetch) {
  if (backendProvider(env) === "supabase") {
    return createClient(required(env, "SUPABASE_URL"),
      env.SUPABASE_SERVICE_KEY || required(env, "SUPABASE_SERVICE_ROLE_KEY"), { global: { fetch: fetchImpl } });
  }
  const url = new URL(required(env, "RDS_REST_URL"));
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("RDS_REST_URL must be the PostgREST origin, without a path or credentials.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("RDS_REST_URL must use HTTPS (localhost HTTP is allowed for testing).");
  }
  const secret = required(env, "RDS_REST_JWT_SECRET", 32);
  if (secret === required(env, "AWS_CORTEX_JWT_SECRET", 32)) {
    throw new Error("The PostgREST and application JWT secrets must be different.");
  }
  const databaseFetch = (input, init = {}) => {
    const target = new URL(typeof input === "string" ? input : input.url || String(input));
    if (target.origin !== url.origin || !target.pathname.startsWith("/rest/v1/")) {
      throw new Error("AWS database client only supports PostgREST requests.");
    }
    target.pathname = target.pathname.slice("/rest/v1".length);
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${jwt.sign({ role: "cortex_backend" }, secret, {
      algorithm: "HS256", expiresIn: "5m", audience: "cortex:database",
    })}`);
    headers.delete("apikey");
    const timeout = AbortSignal.timeout(35000);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return fetchImpl(target, { ...init, headers, signal });
  };
  const client = createClient(url.origin, "aws-server-only", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: databaseFetch },
  });
  return {
    from: client.from.bind(client), rpc: client.rpc.bind(client),
    storage: env.CORTEX_ENV === 'local' ? createLocalStorage(env) : createS3Storage(env),
  };
}
