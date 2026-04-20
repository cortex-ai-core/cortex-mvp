// app/(dashboard)/layout.tsx
import { ReactNode } from "react";
import { getSession } from "@/lib/auth/getSession";
import Sidebar from "@/components/Sidebar";

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  // Auth check on server render
  const session = await getSession();

  return (
    <div className="flex min-h-screen bg-gray-50">
      {/* Sidebar only renders for authenticated users */}
      <Sidebar user={session?.user ?? null} />

      {/* Main content */}
      <main className="flex-1 px-8 py-6">
        {children}
      </main>
    </div>
  );
}

