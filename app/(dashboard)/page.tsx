// app/(dashboard)/page.tsx
export default function DashboardPage() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-black tracking-tight">Dashboard</h1>
      <p className="text-gray-600 text-sm">
        Welcome to Cortéx. Select an option from the sidebar to begin.
      </p>
    </div>
  );
}

