"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ScriptWithTimings, TimedLine } from "@/pipeline/types";

type Props = {
  audioUrl: string;
  script: ScriptWithTimings | null;
};

type Row =
  | { kind: "line"; line: TimedLine; key: string }
  | { kind: "segmentHeader"; topic: string; key: string };

// Spotify-style transcript:
//   - hidden <audio ref> drives playback
//   - currentMs updates from `timeupdate` + RAF tick for smooth highlights
//   - activeKey is derived once per change (not per ms) so smooth-scroll
//     doesn't fight itself
//   - scrolling MANUALLY pauses auto-follow; a floating button re-enables it
export function EpisodePlayer({ audioUrl, script }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const programmaticScrollAt = useRef<number>(0);

  const [currentMs, setCurrentMs] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    let rafId: number;
    const update = () => {
      setCurrentMs(audio.currentTime * 1000);
      if (!audio.paused) rafId = requestAnimationFrame(update);
    };
    const onPlay = () => {
      rafId = requestAnimationFrame(update);
    };
    const onPause = () => {
      if (rafId) cancelAnimationFrame(rafId);
      setCurrentMs(audio.currentTime * 1000);
    };
    const onSeeked = () => setCurrentMs(audio.currentTime * 1000);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("seeked", onSeeked);
    audio.addEventListener("timeupdate", onSeeked);
    return () => {
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("seeked", onSeeked);
      audio.removeEventListener("timeupdate", onSeeked);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, []);

  const rows = useMemo<Row[]>(() => {
    if (!script) return [];
    const out: Row[] = [{ kind: "line", line: script.intro, key: "intro" }];
    script.segments.forEach((seg, si) => {
      out.push({ kind: "segmentHeader", topic: seg.topic, key: `seg-${si}-h` });
      seg.lines.forEach((line, li) => {
        out.push({ kind: "line", line, key: `seg-${si}-${li}` });
      });
    });
    out.push({ kind: "line", line: script.outro, key: "outro" });
    return out;
  }, [script]);

  // Derive the active line key from currentMs. Updating state only on CHANGE
  // is the whole point — scrollIntoView fires once per transition, not on
  // every audio tick.
  const activeKey = useMemo<string | null>(() => {
    for (const row of rows) {
      if (row.kind !== "line") continue;
      if (currentMs >= row.line.startMs && currentMs < row.line.endMs) {
        return row.key;
      }
    }
    return null;
  }, [rows, currentMs]);

  const scrollToActive = useCallback(() => {
    const container = containerRef.current;
    if (!container || !activeKey) return;
    const el = container.querySelector<HTMLElement>(`[data-line-key="${activeKey}"]`);
    if (!el) return;
    programmaticScrollAt.current = Date.now();
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeKey]);

  // Auto-follow: scroll only when the active line CHANGES, and only if
  // autoScroll is still on.
  useEffect(() => {
    if (!autoScroll || !activeKey) return;
    scrollToActive();
  }, [activeKey, autoScroll, scrollToActive]);

  // Detect manual scroll → turn off auto-follow. Ignore the scroll events
  // that scrollIntoView itself triggers (≤700ms after a programmatic scroll).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onScroll = () => {
      if (Date.now() - programmaticScrollAt.current < 700) return;
      if (autoScroll) setAutoScroll(false);
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, [autoScroll]);

  const seek = useCallback((ms: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = ms / 1000;
    void audio.play();
    // Manually pressing a line is intent to follow — turn auto-scroll back on.
    setAutoScroll(true);
  }, []);

  const resumeFollow = useCallback(() => {
    setAutoScroll(true);
    // Schedule a scroll on next tick so the effect picks up the toggle.
    requestAnimationFrame(() => scrollToActive());
  }, [scrollToActive]);

  if (!script) {
    return (
      <div>
        <audio ref={audioRef} controls className="w-full">
          <source src={audioUrl} type="audio/mpeg" />
          Audio not available.
        </audio>
        <p className="mt-6 text-sm text-neutral-500">
          Transcript not available for this episode (generated before transcript
          support was added).
        </p>
      </div>
    );
  }

  return (
    <div>
      <audio ref={audioRef} controls className="w-full">
        <source src={audioUrl} type="audio/mpeg" />
        Audio not available.
      </audio>

      <div className="mt-6 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Transcript</h2>
        <span className="text-xs text-neutral-500">
          {autoScroll ? "Following audio" : "Scrolling free"}
        </span>
      </div>

      <div className="relative mt-3">
        <div
          ref={containerRef}
          className="max-h-[28rem] overflow-y-auto rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
        >
          {rows.map((row) => {
            if (row.kind === "segmentHeader") {
              return (
                <div
                  key={row.key}
                  className="mt-6 mb-2 text-xs font-medium uppercase tracking-wider text-neutral-500 first:mt-0"
                >
                  {row.topic}
                </div>
              );
            }
            const isActive = row.key === activeKey;
            return (
              <TranscriptLine
                key={row.key}
                rowKey={row.key}
                line={row.line}
                isActive={isActive}
                onClick={() => seek(row.line.startMs)}
              />
            );
          })}
        </div>

        {!autoScroll && activeKey && (
          <button
            type="button"
            onClick={resumeFollow}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-neutral-900 px-4 py-1.5 text-xs font-medium text-white shadow-lg hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            ↓ Jump to current
          </button>
        )}
      </div>

      <p className="mt-2 text-xs text-neutral-500">
        Click any line to jump to that moment.
      </p>
    </div>
  );
}

function TranscriptLine({
  rowKey,
  line,
  isActive,
  onClick,
}: {
  rowKey: string;
  line: TimedLine;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-line-key={rowKey}
      onClick={onClick}
      className={`group block w-full rounded-md px-3 py-2 text-left text-sm transition ${
        isActive
          ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
          : "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900"
      }`}
    >
      <span
        className={`mr-2 inline-block text-xs font-semibold ${
          isActive ? "text-white/80 dark:text-neutral-900/80" : "text-neutral-500"
        }`}
      >
        {line.speakerName}
      </span>
      <span>{line.text}</span>
      <span
        className={`ml-2 inline-block align-middle text-[10px] tabular-nums ${
          isActive
            ? "text-white/60 dark:text-neutral-900/60"
            : "text-neutral-400 opacity-0 group-hover:opacity-100"
        }`}
      >
        {formatMs(line.startMs)}
      </span>
    </button>
  );
}

function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
