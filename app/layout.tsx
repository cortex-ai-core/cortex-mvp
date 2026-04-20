// app/layout.tsx
import "./globals.css";
import { ReactNode } from "react";
import { getSession } from "@/lib/auth/getSession";
import { SessionProvider } from "./SessionProvider";

export const metadata = {
  title: "Cortéx",
  description: "The King's sovereign intelligence engine",
};

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  // Load server-side session
  const session = await getSession();

  return (
    <html lang="en">
      <body>
        {/* SessionProvider is now a client component */}
        <SessionProvider initialSession={session}>
          {children}
        </SessionProvider>
      </body>
    </html>
  );
}

