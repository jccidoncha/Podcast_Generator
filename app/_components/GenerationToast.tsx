"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type RunStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";

type RunPayload = {
  id: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  errorMessage?: string | null;
  episodeId: string | null;
};

const POLL_MS = 5_000;
const SEEN_KEY = "generation-toast:seenRunIds";
const MOUNT_KEY = "generation-toast:mountedAt";

// Global toast that surfaces ANY new run — manual or scheduled. Lifecycle:
//   1. Detect a PENDING/RUNNING run started after this page mounted → toast
//      "Generating new episode…" with a small spinner.
//   2. Follow that run by polling /api/runs/:id until it reaches SUCCEEDED
//      or FAILED.
//   3. SUCCEEDED → upgrade the toast to "New episode ready" + Listen link.
//      FAILED → show error toast.
//
// Dedupe: we keep a list of run IDs we've already shown (in localStorage) so
// the same run never re-toasts after a page navigation or reload.
export function GenerationToast() {
  const [tracked, setTracked] = useState<RunPayload | null>(null);
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    // Hydrate seen set + mount time (mount time scopes "new" to this session).
    try {
      seenRef.current = new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]"));
    } catch {
      seenRef.current = new Set();
    }
    if (!sessionStorage.getItem(MOUNT_KEY)) {
      sessionStorage.setItem(MOUNT_KEY, new Date().toISOString());
    }
    const mountedAt = new Date(sessionStorage.getItem(MOUNT_KEY) ?? new Date().toISOString());

    let cancelled = false;
    let currentId: string | null = null;

    async function tick() {
      if (cancelled) return;

      // If we're following a specific run, poll just that one.
      if (currentId) {
        const res = await fetch(`/api/runs/${currentId}`, { cache: "no-store" }).catch(() => null);
        if (!res || !res.ok) return;
        const run = (await res.json()) as RunPayload;
        if (cancelled) return;
        setTracked(run);
        if (run.status === "SUCCEEDED" || run.status === "FAILED") {
          markSeen(run.id);
          currentId = null;
        }
        return;
      }

      // Otherwise look for a new run started after we mounted.
      const res = await fetch(`/api/runs?limit=3`, { cache: "no-store" }).catch(() => null);
      if (!res || !res.ok) return;
      const { runs } = (await res.json()) as { runs: RunPayload[] };
      if (cancelled || !runs?.length) return;

      // Sort newest first (the API already does, but be defensive) and pick
      // the most recent one that's (a) not yet seen and (b) started after
      // page mount. The mount-time gate prevents toasts for old runs the
      // user saw in a previous session.
      const candidate = runs
        .filter((r) => !seenRef.current.has(r.id) && new Date(r.startedAt) >= mountedAt)
        .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0];
      if (!candidate) return;

      setTracked(candidate);
      if (candidate.status === "PENDING" || candidate.status === "RUNNING") {
        currentId = candidate.id;
      } else {
        // Already terminal — mark seen so we don't toast it again, but still
        // surface it once (e.g. user came back to tab after success).
        markSeen(candidate.id);
      }
    }

    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  function markSeen(runId: string) {
    seenRef.current.add(runId);
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify([...seenRef.current].slice(-50)));
    } catch {
      // localStorage full / blocked — fine, in-memory dedupe still works.
    }
  }

  function dismiss() {
    if (tracked) markSeen(tracked.id);
    setTracked(null);
  }

  if (!tracked) return null;

  const isWorking = tracked.status === "PENDING" || tracked.status === "RUNNING";
  const isReady = tracked.status === "SUCCEEDED" && tracked.episodeId;
  const isFailed = tracked.status === "FAILED";

  return (
    <div className="fixed bottom-6 right-6 z-50 max-w-sm rounded-lg border border-neutral-200 bg-white p-4 shadow-lg dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex items-start gap-3">
        {isWorking && <Spinner />}
        <div className="flex-1">
          {isWorking && (
            <>
              <p className="text-sm font-medium">Generating new episode…</p>
              <p className="mt-1 text-xs text-neutral-500">
                {tracked.status === "PENDING" ? "Queued. Pipeline starts shortly." : "Running. Usually ~60-90s."}
              </p>
            </>
          )}
          {isReady && (
            <>
              <p className="text-sm font-medium">New episode ready</p>
              <p className="mt-1 text-xs text-neutral-500">Generated just now.</p>
            </>
          )}
          {isFailed && (
            <>
              <p className="text-sm font-medium text-red-600 dark:text-red-400">Generation failed</p>
              <p className="mt-1 text-xs text-neutral-500">
                {tracked.errorMessage?.slice(0, 120) ?? "Unknown error. Check worker logs."}
              </p>
            </>
          )}
        </div>
      </div>
      <div className="mt-3 flex items-center gap-3">
        {isReady && tracked.episodeId && (
          <Link
            href={`/episodes/${tracked.episodeId}`}
            onClick={dismiss}
            className="text-sm font-medium text-neutral-900 underline dark:text-neutral-100"
          >
            Listen now
          </Link>
        )}
        <button
          type="button"
          onClick={dismiss}
          className="text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="mt-0.5 h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-900 dark:border-neutral-700 dark:border-t-neutral-100"
    />
  );
}
