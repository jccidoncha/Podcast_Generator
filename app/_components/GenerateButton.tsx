"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type RunStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";

type RunPayload = {
  id: string;
  status: RunStatus;
  episodeId: string | null;
  errorMessage: string | null;
};

type Proposal = {
  topic: string;
  headline: string;
  summary: string;
  articleCount: number;
  source: string;
};

type Format = "SOLO" | "CO_HOST" | "DEBATE" | "INTERVIEW";
type Style = "NEWS_ROUNDUP" | "DEEP_DIVE" | "MAGAZINE";

type EpisodeConfig = {
  targetLengthMin: number;
  format: Format;
  style: Style;
};

const POLL_MS = 3_000;
const ETA_SECONDS = 80;

const FORMAT_OPTIONS: Array<{ id: Format; label: string; sub: string }> = [
  { id: "SOLO", label: "Solo", sub: "1 host" },
  { id: "CO_HOST", label: "Co-host", sub: "2 hosts, natural" },
  { id: "DEBATE", label: "Debate", sub: "2 viewpoints" },
  { id: "INTERVIEW", label: "Interview", sub: "host + expert" },
];

const STYLE_OPTIONS: Array<{ id: Style; label: string; sub: string }> = [
  { id: "NEWS_ROUNDUP", label: "Roundup", sub: "cover everything" },
  { id: "DEEP_DIVE", label: "Deep dive", sub: "one big story" },
  { id: "MAGAZINE", label: "Magazine", sub: "themed segments" },
];

const DEFAULT_EPISODE_CONFIG: EpisodeConfig = {
  targetLengthMin: 8,
  format: "CO_HOST",
  style: "NEWS_ROUNDUP",
};

type View = "idle" | "proposing" | "picking" | "running";

// Special sentinel for "Surprise me" — user explicitly opts into no focus.
// We treat it like a real selection so the Generate button activates.
const SURPRISE = "__surprise__";

export function GenerateButton({ initialRunId }: { initialRunId?: string }) {
  const router = useRouter();
  const [view, setView] = useState<View>(initialRunId ? "running" : "idle");
  const [runId, setRunId] = useState<string | null>(initialRunId ?? null);
  const [status, setStatus] = useState<RunStatus | null>(initialRunId ? "PENDING" : null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [selectedTopic, setSelectedTopic] = useState<string | null>(null);
  const [episodeConfig, setEpisodeConfig] = useState<EpisodeConfig>(DEFAULT_EPISODE_CONFIG);
  const [savedConfig, setSavedConfig] = useState<EpisodeConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tickRef = useRef<NodeJS.Timeout | null>(null);

  const busy =
    view === "running" && (status === "PENDING" || status === "RUNNING");

  // Load the saved PodcastConfig once so the modal pre-fills with those
  // values. Per-episode overrides are computed on save as the diff.
  useEffect(() => {
    fetch("/api/config", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (!cfg) return;
        const next: EpisodeConfig = {
          targetLengthMin: cfg.targetLengthMin,
          format: cfg.format,
          style: cfg.style,
        };
        setSavedConfig(next);
        setEpisodeConfig(next);
      })
      .catch(() => {});
  }, []);

  // Poll the running run for status.
  useEffect(() => {
    if (!runId || status === "SUCCEEDED" || status === "FAILED") return;
    const startedAt = Date.now();
    tickRef.current = setInterval(async () => {
      setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
      const res = await fetch(`/api/runs/${runId}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as RunPayload;
      setStatus(data.status);
      if (data.status === "SUCCEEDED") {
        clearInterval(tickRef.current!);
        router.refresh();
      } else if (data.status === "FAILED") {
        clearInterval(tickRef.current!);
        setError(data.errorMessage ?? "generation failed");
      }
    }, POLL_MS);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [runId, status, router]);

  async function openModal() {
    setError(null);
    setSelectedTopic(null);
    setView("proposing");
    const res = await fetch("/api/runs/propose-topics", { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? `propose failed (${res.status})`);
      setView("idle");
      return;
    }
    const data = (await res.json()) as { proposals: Proposal[] };
    setProposals(data.proposals);
    setView("picking");
  }

  async function generate() {
    if (!selectedTopic) return;
    setError(null);
    setElapsedSec(0);
    setView("running");

    // Only send overrides for fields that differ from the saved config — keep
    // the payload small and intent-revealing.
    const overrides: Record<string, unknown> = {};
    if (savedConfig) {
      if (episodeConfig.targetLengthMin !== savedConfig.targetLengthMin) {
        overrides.overrideTargetLengthMin = episodeConfig.targetLengthMin;
      }
      if (episodeConfig.format !== savedConfig.format) {
        overrides.overrideFormat = episodeConfig.format;
      }
      if (episodeConfig.style !== savedConfig.style) {
        overrides.overrideStyle = episodeConfig.style;
      }
    }
    if (selectedTopic !== SURPRISE) overrides.focusTopic = selectedTopic;

    const res = await fetch("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(overrides),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? `error ${res.status}`);
      setView("idle");
      return;
    }
    const data = (await res.json()) as { id: string; status: RunStatus };
    setRunId(data.id);
    setStatus(data.status);
  }

  const eta = Math.max(0, ETA_SECONDS - elapsedSec);

  return (
    <div className="space-y-4">
      {view === "idle" && (
        <button
          type="button"
          onClick={openModal}
          className="rounded-md bg-neutral-900 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          Generate now
        </button>
      )}

      {view === "proposing" && (
        <div className="flex items-center gap-3 text-sm text-neutral-600 dark:text-neutral-400">
          <Spinner />
          <span>Scanning today&apos;s news…</span>
        </div>
      )}

      {view === "picking" && (
        <div className="space-y-6 rounded-xl border border-neutral-200 bg-neutral-50 p-5 dark:border-neutral-800 dark:bg-neutral-900">
          {/* Topic */}
          <section>
            <div className="mb-3">
              <p className="text-sm font-semibold">1. Pick a focus</p>
              <p className="mt-0.5 text-xs text-neutral-500">
                What today&apos;s episode centers on. Topics pulled live from what&apos;s
                in the news for your interests.
              </p>
            </div>
            <div className="space-y-2">
              {proposals.map((p) => {
                const active = selectedTopic === p.topic;
                return (
                  <button
                    key={p.topic + p.headline}
                    type="button"
                    onClick={() => setSelectedTopic(p.topic)}
                    aria-pressed={active}
                    className={`w-full rounded-lg border p-3 text-left transition ${
                      active
                        ? "border-neutral-900 bg-white ring-2 ring-neutral-900 dark:border-neutral-100 dark:bg-neutral-950 dark:ring-neutral-100"
                        : "border-neutral-200 bg-white hover:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-950 dark:hover:border-neutral-600"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xs uppercase tracking-wider text-neutral-500">
                          {p.topic} · {p.articleCount} {p.articleCount === 1 ? "story" : "stories"}
                        </p>
                        <p className="mt-1 text-sm font-medium">{p.headline}</p>
                      </div>
                      {active && (
                        <span className="shrink-0 text-neutral-900 dark:text-neutral-100">✓</span>
                      )}
                    </div>
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => setSelectedTopic(SURPRISE)}
                aria-pressed={selectedTopic === SURPRISE}
                className={`w-full rounded-lg border p-3 text-left text-sm transition ${
                  selectedTopic === SURPRISE
                    ? "border-neutral-900 bg-white text-neutral-900 ring-2 ring-neutral-900 dark:border-neutral-100 dark:bg-neutral-950 dark:text-neutral-100 dark:ring-neutral-100"
                    : "border-dashed border-neutral-300 bg-transparent text-neutral-600 hover:border-neutral-900 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-neutral-100 dark:hover:text-neutral-100"
                }`}
              >
                <span className="flex items-center justify-between">
                  <span>🎲 Surprise me — cover everything</span>
                  {selectedTopic === SURPRISE && <span>✓</span>}
                </span>
              </button>
            </div>
          </section>

          {/* Per-episode config */}
          <section className="border-t border-neutral-200 pt-5 dark:border-neutral-800">
            <div className="mb-3">
              <p className="text-sm font-semibold">2. Configure this episode</p>
              <p className="mt-0.5 text-xs text-neutral-500">
                Only this episode — your saved defaults don&apos;t change.
              </p>
            </div>

            {/* Format */}
            <div className="mb-4">
              <p className="mb-1.5 text-xs font-medium text-neutral-600 dark:text-neutral-400">
                Format
              </p>
              <div className="grid grid-cols-4 gap-2">
                {FORMAT_OPTIONS.map((f) => {
                  const active = episodeConfig.format === f.id;
                  return (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setEpisodeConfig({ ...episodeConfig, format: f.id })}
                      className={`rounded-md border px-2 py-2 text-center transition ${
                        active
                          ? "border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900"
                          : "border-neutral-200 bg-white text-neutral-700 hover:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300"
                      }`}
                    >
                      <span className="block text-xs font-medium">{f.label}</span>
                      <span className={`block text-[10px] ${active ? "opacity-80" : "text-neutral-500"}`}>
                        {f.sub}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Style */}
            <div className="mb-4">
              <p className="mb-1.5 text-xs font-medium text-neutral-600 dark:text-neutral-400">
                Style
              </p>
              <div className="grid grid-cols-3 gap-2">
                {STYLE_OPTIONS.map((s) => {
                  const active = episodeConfig.style === s.id;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setEpisodeConfig({ ...episodeConfig, style: s.id })}
                      className={`rounded-md border px-2 py-2 text-center transition ${
                        active
                          ? "border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900"
                          : "border-neutral-200 bg-white text-neutral-700 hover:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300"
                      }`}
                    >
                      <span className="block text-xs font-medium">{s.label}</span>
                      <span className={`block text-[10px] ${active ? "opacity-80" : "text-neutral-500"}`}>
                        {s.sub}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Length */}
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <p className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
                  Length
                </p>
                <span className="text-xs tabular-nums text-neutral-500">
                  {episodeConfig.targetLengthMin} min
                </span>
              </div>
              <input
                type="range"
                min={3}
                max={20}
                value={episodeConfig.targetLengthMin}
                onChange={(e) =>
                  setEpisodeConfig({
                    ...episodeConfig,
                    targetLengthMin: Number(e.target.value),
                  })
                }
                className="w-full"
              />
            </div>
          </section>

          <div className="flex items-center justify-between border-t border-neutral-200 pt-4 dark:border-neutral-800">
            <button
              type="button"
              onClick={() => setView("idle")}
              className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={generate}
              disabled={!selectedTopic}
              className="rounded-md bg-neutral-900 px-5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
            >
              {selectedTopic ? "Generate episode →" : "Pick a focus to continue"}
            </button>
          </div>
        </div>
      )}

      {view === "running" && busy && (
        <div className="flex items-center gap-3 text-sm text-neutral-600 dark:text-neutral-400">
          <Spinner />
          <span>
            {status} · ~{eta}s remaining
          </span>
        </div>
      )}

      {view === "running" && status === "SUCCEEDED" && (
        <p className="text-sm text-green-600 dark:text-green-400">
          Done — your new episode is below.
        </p>
      )}

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

function Spinner() {
  return (
    <span
      aria-label="loading"
      className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-neutral-400 border-t-neutral-900 dark:border-neutral-600 dark:border-t-neutral-100"
    />
  );
}
