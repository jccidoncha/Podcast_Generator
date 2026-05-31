"use client";

import { useEffect, useState } from "react";

type Config = {
  voice: string;
  secondaryVoice: string | null;
  targetLengthMin: number;
  tone: "CONVERSATIONAL" | "FORMAL" | "ENERGETIC";
  style: "NEWS_ROUNDUP" | "DEEP_DIVE" | "MAGAZINE";
  density: "HEADLINE" | "DETAILED";
  language: "EN" | "ES";
  format: "SOLO" | "CO_HOST" | "DEBATE" | "INTERVIEW";
  // Schedule
  scheduleEnabled: boolean;
  scheduleHour: number; // 0-23
  scheduleMinute: number; // 0-59
  scheduleDays: number[]; // 0=Sun..6=Sat
  scheduleTimezone: string;
};

type Interest = { topic: string; weight: number; context: string | null };

// Browser-detected IANA TZ — works in all evergreen browsers and Node 18+.
const BROWSER_TZ =
  typeof Intl !== "undefined"
    ? Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
    : "UTC";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const DEFAULT_CONFIG: Config = {
  voice: "rachel",
  secondaryVoice: null,
  targetLengthMin: 8,
  tone: "CONVERSATIONAL",
  style: "NEWS_ROUNDUP",
  density: "DETAILED",
  language: "EN",
  format: "SOLO",
  scheduleEnabled: false,
  scheduleHour: 8,
  scheduleMinute: 0,
  scheduleDays: [1, 2, 3, 4, 5], // Mon-Fri
  scheduleTimezone: BROWSER_TZ,
};

const VOICE_OPTIONS = [
  { value: "rachel", label: "Rachel" },
  { value: "adam", label: "Adam" },
  { value: "aria", label: "Aria" },
];

const FORMAT_LABELS: Record<Config["format"], string> = {
  SOLO: "Solo narrator",
  CO_HOST: "Co-host (natural dialogue)",
  DEBATE: "Debate (two viewpoints)",
  INTERVIEW: "Interview (host + expert)",
};

type DraftInterest = { topic: string; weight: number; context: string };

export default function SettingsPage() {
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);
  const [description, setDescription] = useState("");
  const [draft, setDraft] = useState<DraftInterest[]>([]);
  const [loading, setLoading] = useState(true);
  const [extracting, setExtracting] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [savingInterests, setSavingInterests] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      const cfgRes = await fetch("/api/config");
      if (cfgRes.ok) {
        const cfg = await cfgRes.json();
        setConfig({
          voice: cfg.voice,
          secondaryVoice: cfg.secondaryVoice ?? null,
          targetLengthMin: cfg.targetLengthMin,
          tone: cfg.tone,
          style: cfg.style,
          density: cfg.density,
          language: cfg.language,
          format: cfg.format ?? "SOLO",
          scheduleEnabled: !!cfg.scheduleEnabled,
          scheduleHour: cfg.scheduleHour ?? 8,
          scheduleMinute: cfg.scheduleMinute ?? 0,
          scheduleDays: Array.isArray(cfg.scheduleDays) ? cfg.scheduleDays : [1, 2, 3, 4, 5],
          scheduleTimezone: cfg.scheduleTimezone || BROWSER_TZ,
        });
      }
      const intRes = await fetch("/api/interests");
      if (intRes.ok) {
        const { interests } = (await intRes.json()) as { interests: Interest[] };
        // Load existing interests as the editable draft so users see what's
        // currently saved without having to re-describe everything.
        setDraft(
          interests.map((i) => ({
            topic: i.topic,
            weight: i.weight,
            context: i.context ?? "",
          })),
        );
      }
      setLoading(false);
    }
    load();
  }, []);

  async function extractFromDescription() {
    if (!description.trim()) return;
    setExtracting(true);
    setMessage("Extracting (this can take ~15-30s while we look up names)…");

    // Web_search-backed extraction is slow. AbortController gives us 60s on
    // the client; if the call hangs longer we bail out gracefully instead
    // of letting React surface a raw "Failed to fetch".
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);

    try {
      const res = await fetch("/api/interests/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        setMessage(`Extract failed (${res.status}). ${body.slice(0, 200)}`);
        return;
      }
      const { interests } = (await res.json()) as {
        interests: DraftInterest[];
      };
      if (interests.length === 0) {
        setMessage(
          "No interests detected. Try a longer description with concrete names or topics.",
        );
        return;
      }
      // Merge with existing draft: append, dedupe by topic (case-insensitive).
      setDraft((prev) => {
        const byTopic = new Map(prev.map((d) => [d.topic.toLowerCase(), d]));
        for (const inew of interests) {
          if (!byTopic.has(inew.topic.toLowerCase())) {
            byTopic.set(inew.topic.toLowerCase(), inew);
          }
        }
        return [...byTopic.values()];
      });
      setDescription("");
      setMessage(`Added ${interests.length} interest(s). Review and save below.`);
    } catch (err) {
      // Most common: AbortError (timeout) or TypeError "Failed to fetch" when
      // the dev server dropped the connection mid-request.
      const name = (err as { name?: string }).name;
      if (name === "AbortError") {
        setMessage(
          "Extract timed out after 60s. Try a shorter description, or try again.",
        );
      } else {
        setMessage(
          `Extract failed — ${(err as Error).message}. Is the worker/server running?`,
        );
      }
    } finally {
      clearTimeout(timer);
      setExtracting(false);
    }
  }

  function updateDraft(idx: number, patch: Partial<DraftInterest>) {
    setDraft((prev) => prev.map((d, i) => (i === idx ? { ...d, ...patch } : d)));
  }

  function removeDraft(idx: number) {
    setDraft((prev) => prev.filter((_, i) => i !== idx));
  }

  async function saveInterests() {
    setSavingInterests(true);
    setMessage(null);
    const payload = {
      interests: draft.map((d) => ({
        topic: d.topic,
        weight: d.weight,
        context: d.context.trim() || undefined,
      })),
    };
    const res = await fetch("/api/interests", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    setSavingInterests(false);
    if (res.ok) {
      setMessage("Interests saved.");
    } else {
      setMessage(`Save failed (${res.status}).`);
      console.error(await res.text());
    }
  }

  async function saveConfig(e: React.FormEvent) {
    e.preventDefault();
    setSavingConfig(true);
    setMessage(null);
    const res = await fetch("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    });
    setSavingConfig(false);
    if (res.ok) setMessage("Format saved.");
    else {
      setMessage(`Save failed (${res.status}).`);
      console.error(await res.text());
    }
  }

  if (loading) {
    return <p className="text-sm text-neutral-500">Loading…</p>;
  }

  return (
    <section>
      <h1 className="text-2xl font-semibold tracking-tight">Podcast settings</h1>
      <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
        Changes apply to the next scheduled episode.
      </p>

      {/* Interests — natural-language input + extracted preview */}
      <div className="mt-8 space-y-4">
        <div>
          <h2 className="text-base font-semibold">Your interests</h2>
          <p className="mt-1 text-sm text-neutral-500">
            Describe what you want to hear about in your own words. We&apos;ll pull
            out the topics, look up what each one is, and let you review.
          </p>
        </div>

        <div>
          <textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder='e.g. "Me va el indie rock, sobre todo Vetusta Morla y Shaboozey. Sigo la F1 con cariño a Alonso. También me interesa la política de adaptación climática en Europa."'
            className="w-full rounded-md border border-neutral-300 bg-transparent p-2 text-sm dark:border-neutral-700"
          />
          <div className="mt-2 flex items-center gap-3">
            <button
              type="button"
              onClick={extractFromDescription}
              disabled={extracting || !description.trim()}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
            >
              {extracting ? "Extracting…" : "+ Extract & add"}
            </button>
            <span className="text-xs text-neutral-500">
              Adds to your list. Doesn&apos;t replace.
            </span>
          </div>
        </div>

        {draft.length > 0 && (
          <div>
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-medium">Your interests ({draft.length})</p>
              <button
                type="button"
                onClick={saveInterests}
                disabled={savingInterests}
                className="rounded-md bg-neutral-900 px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
              >
                {savingInterests ? "Saving…" : "Save interests"}
              </button>
            </div>
            <ul className="space-y-2">
              {draft.map((d, idx) => (
                <li
                  key={`${d.topic}-${idx}`}
                  className="group rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex-1 space-y-1">
                      <input
                        type="text"
                        value={d.topic}
                        onChange={(e) => updateDraft(idx, { topic: e.target.value })}
                        className="w-full bg-transparent text-sm font-semibold text-neutral-900 outline-none focus:border-b focus:border-neutral-400 dark:text-neutral-100"
                      />
                      <input
                        type="text"
                        value={d.context}
                        onChange={(e) => updateDraft(idx, { context: e.target.value })}
                        placeholder="(what this is — used to frame stories about it)"
                        className="w-full bg-transparent text-xs text-neutral-600 outline-none focus:border-b focus:border-neutral-400 dark:text-neutral-400"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => removeDraft(idx)}
                      className="rounded p-1 text-neutral-400 opacity-0 transition group-hover:opacity-100 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
                      title="Remove"
                      aria-label={`Remove ${d.topic}`}
                    >
                      ✕
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Format — separate save so saving format doesn't touch interests */}
      <form className="mt-12 space-y-6 border-t border-neutral-200 pt-8 dark:border-neutral-800" onSubmit={saveConfig}>
        <div>
          <h2 className="text-base font-semibold">Format & voice</h2>
          <p className="mt-1 text-sm text-neutral-500">How the episode is delivered.</p>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Format">
            <select
              value={config.format}
              onChange={(e) => {
                const f = e.target.value as Config["format"];
                setConfig({
                  ...config,
                  format: f,
                  // when going non-solo for the first time, default secondary to a non-conflicting voice
                  secondaryVoice:
                    f === "SOLO"
                      ? null
                      : config.secondaryVoice ?? VOICE_OPTIONS.find((v) => v.value !== config.voice)?.value ?? "adam",
                });
              }}
              className={selectCls}
            >
              {(Object.keys(FORMAT_LABELS) as Config["format"][]).map((k) => (
                <option key={k} value={k}>
                  {FORMAT_LABELS[k]}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Target length (min)">
            <input
              type="number"
              min={3}
              max={30}
              value={config.targetLengthMin}
              onChange={(e) =>
                setConfig({ ...config, targetLengthMin: Number(e.target.value) })
              }
              className={selectCls}
            />
          </Field>

          <Field label={config.format === "SOLO" ? "Voice" : "Primary voice"}>
            <select
              value={config.voice}
              onChange={(e) => {
                const v = e.target.value;
                // keep secondary != primary
                setConfig({
                  ...config,
                  voice: v,
                  secondaryVoice:
                    config.format === "SOLO"
                      ? null
                      : config.secondaryVoice === v
                        ? VOICE_OPTIONS.find((opt) => opt.value !== v)?.value ?? null
                        : config.secondaryVoice,
                });
              }}
              className={selectCls}
            >
              {VOICE_OPTIONS.map((v) => (
                <option key={v.value} value={v.value}>
                  {v.label}
                </option>
              ))}
            </select>
          </Field>

          {config.format !== "SOLO" && (
            <Field label="Secondary voice">
              <select
                value={config.secondaryVoice ?? ""}
                onChange={(e) => setConfig({ ...config, secondaryVoice: e.target.value })}
                className={selectCls}
              >
                {VOICE_OPTIONS.filter((v) => v.value !== config.voice).map((v) => (
                  <option key={v.value} value={v.value}>
                    {v.label}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Field label="Tone">
            <select
              value={config.tone}
              onChange={(e) => setConfig({ ...config, tone: e.target.value as Config["tone"] })}
              className={selectCls}
            >
              <option value="CONVERSATIONAL">Conversational</option>
              <option value="FORMAL">Formal</option>
              <option value="ENERGETIC">Energetic</option>
            </select>
          </Field>

          <Field label="Style">
            <select
              value={config.style}
              onChange={(e) =>
                setConfig({ ...config, style: e.target.value as Config["style"] })
              }
              className={selectCls}
            >
              <option value="NEWS_ROUNDUP">News roundup</option>
              <option value="DEEP_DIVE">Deep dive</option>
              <option value="MAGAZINE">Magazine</option>
            </select>
          </Field>

          <Field label="Density">
            <select
              value={config.density}
              onChange={(e) =>
                setConfig({ ...config, density: e.target.value as Config["density"] })
              }
              className={selectCls}
            >
              <option value="HEADLINE">Headline</option>
              <option value="DETAILED">Detailed</option>
            </select>
          </Field>

          <Field label="Language">
            <select
              value={config.language}
              onChange={(e) =>
                setConfig({ ...config, language: e.target.value as Config["language"] })
              }
              className={selectCls}
            >
              <option value="EN">English</option>
              <option value="ES">Español</option>
            </select>
          </Field>

        </div>

        {/* Schedule — when to auto-generate. Manual generation still works
            regardless of this section's state. */}
        <div className="space-y-4 border-t border-neutral-200 pt-6 dark:border-neutral-800">
          <div>
            <h2 className="text-base font-semibold">Schedule</h2>
            <p className="mt-1 text-sm text-neutral-500">
              Generate an episode automatically at a set time. You can always click
              &quot;Generate now&quot; on the home page too.
            </p>
          </div>

          <label className="flex cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              checked={config.scheduleEnabled}
              onChange={(e) =>
                setConfig({ ...config, scheduleEnabled: e.target.checked })
              }
              className="h-4 w-4 rounded border-neutral-300 dark:border-neutral-700"
            />
            <span className="text-sm font-medium">Auto-generate episodes</span>
          </label>

          {config.scheduleEnabled && (
            <div className="grid grid-cols-2 gap-4">
              <Field label="Time">
                <input
                  type="time"
                  value={`${pad2(config.scheduleHour)}:${pad2(config.scheduleMinute)}`}
                  onChange={(e) => {
                    const [h, m] = e.target.value.split(":").map(Number);
                    setConfig({
                      ...config,
                      scheduleHour: Number.isFinite(h) ? h : 8,
                      scheduleMinute: Number.isFinite(m) ? m : 0,
                    });
                  }}
                  className={selectCls}
                />
              </Field>

              <Field label="Timezone">
                <select
                  value={config.scheduleTimezone}
                  onChange={(e) =>
                    setConfig({ ...config, scheduleTimezone: e.target.value })
                  }
                  className={selectCls}
                >
                  {timezoneOptions(config.scheduleTimezone).map((tz) => (
                    <option key={tz.value} value={tz.value}>
                      {tz.label}
                    </option>
                  ))}
                </select>
              </Field>

              <div className="col-span-2">
                <label className="block text-sm font-medium">Days</label>
                <div className="mt-2 flex flex-wrap gap-2">
                  {DAY_LABELS.map((label, dayNum) => {
                    const active = config.scheduleDays.includes(dayNum);
                    return (
                      <button
                        key={dayNum}
                        type="button"
                        onClick={() =>
                          setConfig({
                            ...config,
                            scheduleDays: active
                              ? config.scheduleDays.filter((d) => d !== dayNum)
                              : [...config.scheduleDays, dayNum].sort(),
                          })
                        }
                        className={`min-w-12 rounded-md border px-3 py-1.5 text-xs font-medium transition ${
                          active
                            ? "border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900"
                            : "border-neutral-300 bg-transparent text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                        }`}
                        aria-pressed={active}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                {config.scheduleEnabled && config.scheduleDays.length === 0 && (
                  <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                    Pick at least one day for the schedule to fire.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={
              savingConfig ||
              (config.scheduleEnabled && config.scheduleDays.length === 0)
            }
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
          >
            {savingConfig ? "Saving…" : "Save settings"}
          </button>
        </div>
      </form>

      {message && (
        <p className="mt-6 text-sm text-neutral-500">{message}</p>
      )}
    </section>
  );
}

const selectCls =
  "mt-2 w-full rounded-md border border-neutral-300 bg-transparent p-2 text-sm dark:border-neutral-700";

// Common IANA timezones offered in the TZ select. We always include the
// browser-detected TZ (marked as "your time") and the user's currently saved
// value, so the dropdown never hides a valid choice.
const COMMON_TZS = [
  "UTC",
  "Europe/Madrid",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Europe/Lisbon",
  "Europe/Rome",
  "Europe/Amsterdam",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Mexico_City",
  "America/Sao_Paulo",
  "America/Buenos_Aires",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Asia/Hong_Kong",
  "Asia/Dubai",
  "Australia/Sydney",
];

function timezoneOptions(currentValue: string): Array<{ value: string; label: string }> {
  const seen = new Set<string>();
  const out: Array<{ value: string; label: string }> = [];
  const push = (value: string, label?: string) => {
    if (seen.has(value)) return;
    seen.add(value);
    out.push({ value, label: label ?? value });
  };
  // 1) browser TZ first, clearly labeled
  if (BROWSER_TZ) push(BROWSER_TZ, `${BROWSER_TZ} (your time)`);
  // 2) the currently saved value, if not the browser TZ — guarantees the
  //    <select> always renders a matching option for the current state.
  if (currentValue && currentValue !== BROWSER_TZ) push(currentValue);
  // 3) common list
  for (const tz of COMMON_TZS) push(tz);
  return out;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium">{label}</label>
      {children}
    </div>
  );
}
