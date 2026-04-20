// middleware.ts
import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/auth-helpers-nextjs";

export async function middleware(req) {
  const res = NextResponse.next();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { req, res }
  );

  const {
    data: { session },
  } = await supabase.auth.getSession();

  const pathname = req.nextUrl.pathname;

  // Public routes
  const isPublic =
    pathname.startsWith("/login") ||
    pathname.startsWith("/auth") ||
    pathname.startsWith("/favicon") ||
    pathname.startsWith("/icon") ||
    pathname.startsWith("/_next") ||
    pathname === "/";

  // If user is NOT logged in and route is protected
  if (!session && !isPublic) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  // If user IS logged in and tries to access /login → send to dashboard
  if (session && pathname === "/login") {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  return res;
}

export const config = {
  matcher: [
    /*
     * Apply middleware to all routes except:
     * - static files
     * - images
     * - next internal assets
     */
    "/((?!_next/static|_next/image|favicon.ico).*)"
  ]
};

