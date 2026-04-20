"use client";

import { createContext, ReactNode } from "react";

export const SessionContext = createContext(null);

export function SessionProvider({
  initialSession,
  children,
}: {
  initialSession: any;
  children: ReactNode;
}) {
  return (
    <SessionContext.Provider value={initialSession}>
      {children}
    </SessionContext.Provider>
  );
}

