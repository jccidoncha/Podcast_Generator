"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { SUGGESTED_INTERESTS } from "./_data/suggested-interests";

type VoiceId = "rachel" | "adam" | "aria";

type Config = {
  voice: VoiceId;
  secondaryVoice: VoiceId | null;
  targetLengthMin: number;
  tone: "CONVERSATIONAL" | "FORMAL" | "ENERGETIC";
  cadenceCron: string;
  style: "NEWS_ROUNDUP" | "DEEP_DIVE" | "MAGAZINE";
  density: "HEADLINE" | "DETAILED";
  language: "EN" | "ES";
  format: "SOLO" | "CO_HOST" | "DEBATE" | "INTERVIEW";
};

const DEFAULTS: Config = {
  voice: "rachel",
  secondaryVoice: null,
  targetLengthMin: 8,
  tone: "CONVERSATIONAL",
  cadenceCron: "0 8 * * *",
  style: "NEWS_ROUNDUP",
  density: "DETAILED",
  language: "EN",
  format: "SOLO",
};

const STEPS = ["Welcome", "Interests", "Format", "Voice"] as const;

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [interestsText, setInterestsText] = useState("");
  const [config, setConfig] = useState<Config>(DEFAULTS);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const interests = useMemo(
    () =>
      interestsText
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    [interestsText],
  );

  function addChip(topic: string) {
    if (interests.some((i) => i.toLowerCase() === topic.toLowerCase())) return;
    setInterestsText((prev) => (prev.trim() ? `${prev}, ${topic}` : topic));
  }

  function canContinue(): boolean {
    if (step === 1) return interests.length >= 1;
    return true;
  }

  async function finish() {
    setSubmitting(true);
    setError(null);

    const [cfgRes, intRes] = await Promise.all([
      fetch("/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(config),
      }),
      fetch("/api/interests", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          interests: interests.map((topic) => ({ topic, weight: 1 })),
        }),
      }),
    ]);

    if (!cfgRes.ok || !intRes.ok) {
      setError("Couldn't save. Try again.");
      setSubmitting(false);
      return;
    }

    // Kick off the first generation, then land on home with the spinner.
    const runRes = await fetch("/api/runs", { method: "POST" });
    if (!runRes.ok) {
      setError("Saved your settings, but couldn't trigger the first episode.");
      setSubmitting(false);
      return;
    }
    const { id } = (await runRes.json()) as { id: string };
    router.push(`/?firstRun=${id}`);
  }

  return (
    <div className="space-y-8">
      <ProgressDots current={step} total={STEPS.length} />

      {step === 0 && <Welcome onContinue={() => setStep(1)} />}

      {step === 1 && (
        <InterestsStep
          text={interestsText}
          onChange={setInterestsText}
          onChipClick={addChip}
          selected={interests}
        />
      )}

      {step === 2 && <FormatStep config={config} onChange={setConfig} />}

      {step === 3 && <VoiceStep config={config} onChange={setConfig} />}

      {step > 0 && (
        <div className="flex items-center justify-between border-t border-neutral-200 pt-6 dark:border-neutral-800">
          <button
            type="button"
            onClick={() => setStep((s) => s - 1)}
            className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            ← Back
          </button>
          {step < STEPS.length - 1 ? (
            <button
              type="button"
              disabled={!canContinue()}
              onClick={() => setStep((s) => s + 1)}
              className="rounded-md bg-neutral-900 px-5 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
            >
              Continue →
            </button>
          ) : (
            <button
              type="button"
              disabled={submitting}
              onClick={finish}
              className="rounded-md bg-neutral-900 px-5 py-2 text-sm font-semibold text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
            >
              {submitting ? "Creating…" : "Create my first podcast"}
            </button>
          )}
        </div>
      )}

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

function ProgressDots({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-2">
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          className={`h-1.5 w-10 rounded-full ${
            i <= current ? "bg-neutral-900 dark:bg-neutral-100" : "bg-neutral-200 dark:bg-neutral-800"
          }`}
        />
      ))}
    </div>
  );
}

function Welcome({ onContinue }: { onContinue: () => void }) {
  return (
    <section className="space-y-6">
      <p className="text-lg text-neutral-700 dark:text-neutral-300">
        We&apos;ll build you a daily podcast from the news you actually care about. Takes
        about a minute to set up.
      </p>
      <button
        type="button"
        onClick={onContinue}
        className="rounded-md bg-neutral-900 px-5 py-2 text-sm font-semibold text-white dark:bg-neutral-100 dark:text-neutral-900"
      >
        Get started →
      </button>
    </section>
  );
}

function InterestsStep({
  text,
  onChange,
  onChipClick,
  selected,
}: {
  text: string;
  onChange: (v: string) => void;
  onChipClick: (topic: string) => void;
  selected: string[];
}) {
  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">What are you into?</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Topics, beats, anything. Comma-separated. Pick at least one.
        </p>
      </div>

      <textarea
        rows={3}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        placeholder="AI policy, space exploration, F1…"
        className="w-full rounded-md border border-neutral-300 bg-transparent p-3 text-sm dark:border-neutral-700"
      />

      <div className="space-y-4">
        <p className="text-xs uppercase tracking-wider text-neutral-500">Suggestions</p>
        {SUGGESTED_INTERESTS.map((cat) => (
          <div key={cat.name}>
            <p className="mb-2 text-xs font-medium text-neutral-500">{cat.name}</p>
            <div className="flex flex-wrap gap-2">
              {cat.topics.map((topic) => {
                const isSelected = selected.some(
                  (s) => s.toLowerCase() === topic.toLowerCase(),
                );
                return (
                  <button
                    key={topic}
                    type="button"
                    onClick={() => onChipClick(topic)}
                    disabled={isSelected}
                    className={`rounded-full border px-3 py-1 text-xs transition ${
                      isSelected
                        ? "border-neutral-300 bg-neutral-100 text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900"
                        : "border-neutral-300 hover:border-neutral-900 dark:border-neutral-700 dark:hover:border-neutral-100"
                    }`}
                  >
                    {isSelected ? "✓ " : "+ "}
                    {topic}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function FormatStep({
  config,
  onChange,
}: {
  config: Config;
  onChange: (c: Config) => void;
}) {
  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Pick a format</h2>
        <p className="mt-1 text-sm text-neutral-500">
          You can change all of this later in Settings.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label={`Target length: ${config.targetLengthMin} min`}>
          <input
            type="range"
            min={3}
            max={20}
            value={config.targetLengthMin}
            onChange={(e) =>
              onChange({ ...config, targetLengthMin: Number(e.target.value) })
            }
            className="w-full"
          />
        </Field>

        <Field label="Style">
          <Select
            value={config.style}
            onChange={(v) => onChange({ ...config, style: v as Config["style"] })}
            options={[
              { value: "NEWS_ROUNDUP", label: "News roundup (cover everything)" },
              { value: "DEEP_DIVE", label: "Deep dive (one big story)" },
              { value: "MAGAZINE", label: "Magazine (themed segments)" },
            ]}
          />
        </Field>

        <Field label="Tone">
          <Select
            value={config.tone}
            onChange={(v) => onChange({ ...config, tone: v as Config["tone"] })}
            options={[
              { value: "CONVERSATIONAL", label: "Conversational" },
              { value: "FORMAL", label: "Formal" },
              { value: "ENERGETIC", label: "Energetic" },
            ]}
          />
        </Field>

        <Field label="Density">
          <Select
            value={config.density}
            onChange={(v) => onChange({ ...config, density: v as Config["density"] })}
            options={[
              { value: "HEADLINE", label: "Headline only" },
              { value: "DETAILED", label: "Detailed context" },
            ]}
          />
        </Field>

        <Field label="Language">
          <Select
            value={config.language}
            onChange={(v) => onChange({ ...config, language: v as Config["language"] })}
            options={[
              { value: "EN", label: "English" },
              { value: "ES", label: "Español" },
            ]}
          />
        </Field>
      </div>
    </section>
  );
}

const VOICES: Array<{ id: VoiceId; label: string; flavor: string }> = [
  { id: "rachel", label: "Rachel", flavor: "Warm, narrative, female" },
  { id: "adam", label: "Adam", flavor: "Calm, confident, male" },
  { id: "aria", label: "Aria", flavor: "Bright, modern, female" },
];

const FORMAT_OPTIONS: Array<{ id: Config["format"]; label: string; flavor: string }> = [
  { id: "SOLO", label: "Solo narrator", flavor: "One voice, classic news read." },
  { id: "CO_HOST", label: "Co-host", flavor: "Two voices in natural dialogue." },
  { id: "DEBATE", label: "Debate", flavor: "Two viewpoints on each story." },
  { id: "INTERVIEW", label: "Interview", flavor: "Host + expert Q&A." },
];

function VoiceStep({
  config,
  onChange,
}: {
  config: Config;
  onChange: (c: Config) => void;
}) {
  function pickFormat(f: Config["format"]) {
    const secondaryDefault: VoiceId =
      VOICES.find((v) => v.id !== config.voice)?.id ?? "adam";
    onChange({
      ...config,
      format: f,
      secondaryVoice: f === "SOLO" ? null : config.secondaryVoice ?? secondaryDefault,
    });
  }

  function pickPrimary(id: VoiceId) {
    onChange({
      ...config,
      voice: id,
      // keep secondary != primary
      secondaryVoice:
        config.format === "SOLO"
          ? null
          : config.secondaryVoice === id
            ? (VOICES.find((v) => v.id !== id)?.id ?? "adam")
            : config.secondaryVoice,
    });
  }

  function pickSecondary(id: VoiceId) {
    onChange({ ...config, secondaryVoice: id });
  }

  return (
    <section className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold">Format & voices</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Solo is one narrator. Multi-speaker formats pair two voices so the podcast
          feels like a conversation.
        </p>
      </div>

      <div>
        <p className="mb-2 text-xs uppercase tracking-wider text-neutral-500">Format</p>
        <div className="grid grid-cols-2 gap-3">
          {FORMAT_OPTIONS.map((f) => (
            <label
              key={f.id}
              className={`cursor-pointer rounded-lg border p-3 transition ${
                config.format === f.id
                  ? "border-neutral-900 dark:border-neutral-100"
                  : "border-neutral-200 hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600"
              }`}
            >
              <input
                type="radio"
                name="format"
                value={f.id}
                checked={config.format === f.id}
                onChange={() => pickFormat(f.id)}
                className="sr-only"
              />
              <p className="text-sm font-medium">{f.label}</p>
              <p className="mt-0.5 text-xs text-neutral-500">{f.flavor}</p>
            </label>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-2 text-xs uppercase tracking-wider text-neutral-500">
          {config.format === "SOLO" ? "Voice" : "Primary voice (host)"}
        </p>
        <VoiceRadioList
          voices={VOICES}
          selected={config.voice}
          onPick={pickPrimary}
        />
      </div>

      {config.format !== "SOLO" && (
        <div>
          <p className="mb-2 text-xs uppercase tracking-wider text-neutral-500">
            Secondary voice (
            {config.format === "DEBATE"
              ? "opposing view"
              : config.format === "INTERVIEW"
                ? "expert"
                : "co-host"}
            )
          </p>
          <VoiceRadioList
            voices={VOICES.filter((v) => v.id !== config.voice)}
            selected={config.secondaryVoice}
            onPick={pickSecondary}
          />
        </div>
      )}
    </section>
  );
}

function VoiceRadioList({
  voices,
  selected,
  onPick,
}: {
  voices: Array<{ id: VoiceId; label: string; flavor: string }>;
  selected: VoiceId | null;
  onPick: (id: VoiceId) => void;
}) {
  return (
    <div className="space-y-3">
      {voices.map((v) => (
        <label
          key={v.id}
          className={`flex items-center gap-4 rounded-lg border p-4 transition ${
            selected === v.id
              ? "border-neutral-900 dark:border-neutral-100"
              : "border-neutral-200 hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600"
          }`}
        >
          <input
            type="radio"
            checked={selected === v.id}
            onChange={() => onPick(v.id)}
            className="h-4 w-4"
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{v.label}</p>
            <p className="text-xs text-neutral-500">{v.flavor}</p>
          </div>
          <audio controls preload="none" className="h-8">
            <source src={`/voice-samples/${v.id}.mp3`} type="audio/mpeg" />
          </audio>
        </label>
      ))}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium">{label}</label>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-md border border-neutral-300 bg-transparent p-2 text-sm dark:border-neutral-700"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
