export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl px-6 py-12">
      <header className="mb-10">
        <p className="text-xs uppercase tracking-wider text-neutral-500">
          Personal Podcast
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          Let&apos;s set up your podcast
        </h1>
      </header>
      <main>{children}</main>
    </div>
  );
}
