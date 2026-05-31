import Link from "next/link";
import { GenerationToast } from "../_components/GenerationToast";

export default function ListenerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-10 flex items-center justify-between">
        <Link href="/" className="text-xl font-semibold tracking-tight">
          Personal Podcast
        </Link>
        <nav className="flex items-center gap-6 text-sm text-neutral-600 dark:text-neutral-400">
          <Link href="/" className="hover:text-neutral-900 dark:hover:text-neutral-100">
            Home
          </Link>
          <Link href="/episodes" className="hover:text-neutral-900 dark:hover:text-neutral-100">
            Episodes
          </Link>
          <Link href="/settings" className="hover:text-neutral-900 dark:hover:text-neutral-100">
            Settings
          </Link>
          <Link
            href="/dashboard"
            className="flex items-center gap-1.5 rounded-full border border-neutral-300 px-3 py-1 text-xs font-medium hover:border-neutral-900 dark:border-neutral-700 dark:hover:border-neutral-100"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
            Internal
          </Link>
        </nav>
      </header>
      <main>{children}</main>
      <GenerationToast />
    </div>
  );
}
