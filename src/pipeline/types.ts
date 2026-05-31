export type Tone = "conversational" | "formal" | "energetic";
export type Style = "news_roundup" | "deep_dive" | "magazine";
export type Density = "headline" | "detailed";
export type Language = "en" | "es";
export type Format = "solo" | "co_host" | "debate" | "interview";
export type Speaker = "primary" | "secondary";

export type Interest = {
  id: string;
  topic: string;
  weight: number;
  // One-sentence LLM-generated description ("Shaboozey: American country rap
  // artist"). Used by the script prompt so the model knows how to frame the
  // topic, instead of treating "shaboozey" as an abstract concept.
  context: string | null;
};

export type PodcastConfig = {
  userId: string;
  voice: string;
  secondaryVoice: string | null;
  targetLengthMin: number;
  tone: Tone;
  cadenceCron: string;
  style: Style;
  density: Density;
  language: Language;
  format: Format;
};

export type RunContext = {
  runId: string;
  userId: string;
  interests: Interest[];
  config: PodcastConfig;
  now: Date;
  // Optional: when the user picked a specific topic to focus this episode on
  // (via the Generate-with-topic flow). Threads through rank + script.
  focusTopic?: string | null;
};

export type Article = {
  url: string;
  title: string;
  source: string;
  publishedAt: Date;
  snippet: string;
  body?: string;
  topic: string;
};

export type RankedArticle = Article & {
  score: number;
};

export type ScriptLine = {
  text: string;
  sourceUrl: string;
  // The voice that should read this line. For format=solo all lines are
  // "primary"; for other formats they alternate. Synthesize uses the
  // PodcastConfig to map primary → config.voice, secondary → config.secondaryVoice.
  speaker: Speaker;
};

export type ScriptSegment = {
  topic: string;
  // every line carries the source url it's grounded in; this is what the
  // groundedness eval (CLAUDE.md §9) checks against.
  lines: ScriptLine[];
};

export type Script = {
  intro: string;
  segments: ScriptSegment[];
  outro: string;
  estimatedDurationMs: number;
};

export type EpisodeMeta = {
  episodeId: string;
  runId: string;
  audioUrl: string;
  durationMs: number;
  costCents: number;
  sources: Array<{ url: string; title: string }>;
};

// Script as stored on Episode.scriptJson for the transcript UI. Carries
// per-line timestamps (ms relative to the start of the mp3) so the player
// can highlight + click-to-seek like Spotify lyrics.
export type TimedLine = {
  text: string;
  sourceUrl: string; // empty string for intro/outro
  speaker: Speaker;
  speakerName: string; // display name resolved from voice id (Rachel, Adam, …)
  startMs: number;
  endMs: number;
};

export type TimedSegment = {
  topic: string;
  lines: TimedLine[];
};

export type ScriptWithTimings = {
  version: "v1";
  intro: TimedLine;
  segments: TimedSegment[];
  outro: TimedLine;
  totalDurationMs: number;
};
