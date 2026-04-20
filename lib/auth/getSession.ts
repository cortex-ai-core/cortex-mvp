// lib/auth/getSession.ts
import { createServerSupabase } from "@/lib/supabase/serverClient";

export async function getSession() {
  const supabase = createServerSupabase();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  return session;
}

