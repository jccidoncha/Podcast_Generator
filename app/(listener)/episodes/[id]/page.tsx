import { notFound } from "next/navigation";
import { prisma } from "@/db/client";
import { EpisodePlayer } from "@app/_components/EpisodePlayer";
import type { ScriptWithTimings } from "@/pipeline/types";

type Props = {
  params: Promise<{ id: string }>;
};

export const dynamic = "force-dynamic";

export default async function EpisodeDetailPage({ params }: Props) {
  const { id } = await params;

  const episode = await prisma.episode.findUnique({
    where: { id },
    include: { sources: true, run: true },
  });

  if (!episode) return notFound();

  const script = parseScript(episode.scriptJson);

  const downloadFilename = buildDownloadFilename(episode.createdAt, episode.run?.focusTopic ?? null);

  return (
    <section>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Episode of {new Date(episode.createdAt).toLocaleString()}
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            {Math.round(episode.durationMs / 60_000)} min · {episode.sources.length} sources · cost ${(episode.costCents / 100).toFixed(2)}
          </p>
        </div>
        <a
          href={episode.audioUrl}
          download={downloadFilename}
          className="inline-flex shrink-0 items-center gap-2 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
          aria-label="Download episode as MP3"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          Download
        </a>
      </div>

      <div className="mt-6">
        <EpisodePlayer audioUrl={episode.audioUrl} script={script} />
      </div>

      <h2 className="mt-10 text-lg font-semibold">Sources</h2>
      <ul className="mt-3 space-y-2 text-sm">
        {episode.sources.map((s) => (
          <li key={s.id}>
            <a
              href={s.url}
              target="_blank"
              rel="noreferrer"
              className="text-neutral-700 underline hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100"
            >
              {s.title || s.url}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function parseScript(json: unknown): ScriptWithTimings | null {
  if (!json || typeof json !== "object") return null;
  const candidate = json as Partial<ScriptWithTimings>;
  if (candidate.version !== "v1" || !candidate.intro || !candidate.segments) {
    return null;
  }
  return json as ScriptWithTimings;
}

// "podcast-2026-05-31.mp3" or "podcast-2026-05-31-shaboozey.mp3" when a focus
// was set. ASCII-only, lowercase, single-word — safe across all OSes.
function buildDownloadFilename(createdAt: Date, focusTopic: string | null): string {
  const date = createdAt.toISOString().slice(0, 10);
  const slug = focusTopic
    ? "-" +
      focusTopic
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40)
    : "";
  return `podcast-${date}${slug}.mp3`;
}
