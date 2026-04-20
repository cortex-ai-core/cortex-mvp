// lib/auth/getUser.ts
import { createServerSupabase } from "@/lib/supabase/serverClient";

export async function getUser() {
  const supabase = createServerSupabase();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  return user;
}

