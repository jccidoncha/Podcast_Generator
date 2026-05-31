import Link from "next/link";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-10 flex items-end justify-between">
        <div>
          <p className="text-xs uppercase tracking-wider text-amber-600 dark:text-amber-400">
            Internal · product health
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">
            Product metrics
          </h1>
          <p className="mt-2 max-w-xl text-sm text-neutral-500">
            Usage + output-quality dashboard for the team. Most cards are live
            DB queries; a few are still mocked and labeled.
          </p>
        </div>
        <Link
          href="/"
          className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          ← Listener
        </Link>
      </header>
      <main>{children}</main>
    </div>
  );
}
