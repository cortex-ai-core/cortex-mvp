"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

export default function Sidebar({ user }) {
  const router = useRouter();

  return (
    <aside className="w-64 h-screen bg-white border-r border-gray-200 px-6 py-10 flex flex-col gap-10">
      
      {/* Brand */}
      <div>
        <h1 className="text-3xl font-black tracking-tight">Cortéx</h1>
        <p className="text-sm text-gray-500 mt-1">Sollucio Tier-4 AI Market Map™</p>
      </div>

      {/* New Chat Button */}
      <button
        onClick={() => router.push("/chat?new=true")}
        className="w-full rounded-2xl bg-black text-white py-3.5 text-base font-semibold tracking-wide hover:opacity-90 transition"
      >
        + New Chat
      </button>

      {/* File Actions */}
      <div className="flex flex-col gap-2">
        <Link href="/upload" className="text-sm font-medium text-gray-800 hover:text-black hover:underline">
          Upload File
        </Link>
        <Link href="/documents" className="text-sm font-medium text-gray-800 hover:text-black hover:underline">
          Select File
        </Link>
      </div>

      {/* Ephemeral Mode */}
      <div className="pt-4 border-t border-gray-200">
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            className="h-4 w-4 rounded accent-black"
            onChange={(e) => {
              if (e.target.checked) localStorage.setItem("ephemeral", "true");
              else localStorage.removeItem("ephemeral");
            }}
            defaultChecked={
              typeof window !== "undefined" &&
              localStorage.getItem("ephemeral") === "true"
            }
          />
          <span className="text-sm font-medium text-gray-900">
            Ephemeral Mode
          </span>
        </label>
      </div>

      {/* Navigation */}
      <nav className="flex flex-col gap-4 pt-4 border-t border-gray-200">
        <Link href="/dashboard" className="text-sm font-medium text-gray-900 hover:text-black">
          Dashboard
        </Link>
        <Link href="/chat" className="text-sm font-medium text-gray-900 hover:text-black">
          Chat
        </Link>
        <Link href="/admin" className="text-sm font-medium text-gray-900 hover:text-black">
          Admin
        </Link>
        <Link href="/documents" className="text-sm font-medium text-gray-900 hover:text-black">
          Documents
        </Link>
      </nav>

      {/* Logout */}
      {user && (
        <button
          onClick={async () => {
            await fetch("/auth/logout", { method: "POST" });
            router.push("/login");
          }}
          className="mt-auto text-sm text-red-600 hover:underline"
        >
          Logout
        </button>
      )}
    </aside>
  );
}

