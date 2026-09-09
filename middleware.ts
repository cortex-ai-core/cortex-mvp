// middleware.ts
import { NextResponse } from "next/server";

export async function middleware(req: any) {
  const res = NextResponse.next();

  const pathname = req.nextUrl.pathname;

  // Public routes
  const isPublic =
    pathname.startsWith("/login") ||
    pathname.startsWith("/auth") ||
    pathname.startsWith("/favicon") ||
    pathname.startsWith("/icon") ||
    pathname.startsWith("/_next") ||
    pathname === "/";

  // TEMPORARY: bypass auth enforcement during stabilization
  // TODO: reintroduce modern Supabase SSR middleware auth flow

  if (!isPublic) {
    return res;
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
