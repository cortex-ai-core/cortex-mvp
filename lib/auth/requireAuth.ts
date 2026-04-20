// lib/auth/requireAuth.ts
import { redirect } from "next/navigation";
import { getSession } from "./getSession";

export async function requireAuth() {
  const session = await getSession();

  if (!session) {
    redirect("/login");
  }

  return session;
}

