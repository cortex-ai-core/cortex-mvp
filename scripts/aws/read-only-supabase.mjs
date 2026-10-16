// Migration source client: deny every source mutation before sending HTTP.
import { createClient } from "@supabase/supabase-js";

export function createReadOnlySupabase(env, fetchImpl = globalThis.fetch) {
  const origin = "https://wxlsefnxhoufoidiodvx.supabase.co";
  const bucket = env.SUPABASE_STORAGE_BUCKET || "documents";
  if (env.SUPABASE_URL?.replace(/\/$/, "") !== origin || bucket !== "documents") {
    throw new Error("Expected the original Cortex Supabase project and documents bucket.");
  }
  const secret = env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new Error("The existing local Supabase service credential is missing.");
  const readOnlyFetch = (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = (init.method || input.method || "GET").toUpperCase();
    const download = ["GET", "HEAD"].includes(method) &&
      (url.pathname.startsWith(`/storage/v1/object/authenticated/${bucket}/`) ||
       url.pathname.startsWith(`/storage/v1/object/${bucket}/`));
    const list = method === "POST" && url.pathname === `/storage/v1/object/list/${bucket}`;
    const records = method === "GET" && url.pathname === "/rest/v1/documents";
    if (url.origin !== origin || !(download || list || records)) {
      throw new Error("Supabase source operation blocked: only document reads, file listing and downloads are permitted.");
    }
    return fetchImpl(input, { ...init, redirect: "error", signal: AbortSignal.timeout(120000) });
  };
  return createClient(origin, secret, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: readOnlyFetch },
  });
}
