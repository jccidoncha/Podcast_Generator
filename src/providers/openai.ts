import OpenAI from "openai";
import { config as appConfig } from "@/lib/config";
import { isDryRun } from "@/lib/dry-run";
import { logger } from "@/lib/logger";
import { personaFor, type VoicePersona } from "./voice-personas";
import type {
  Density,
  Format,
  Interest,
  Language,
  RankedArticle,
  Script,
  ScriptSegment,
  Speaker,
  Style,
  Tone,
} from "@/pipeline/types";

// Per-section script generation. Splitting the script into intro / N segments /
// outro and calling gpt-4o once per section produces longer, tighter prose
// than one monolithic call: each call has a narrow scope and a small word
// target it can reliably hit.

export type GenerateScriptParams = {
  articles: RankedArticle[];
  tone: Tone;
  style: Style;
  density: Density;
  language: Language;
  format: Format;
  targetLengthMin: number;
  focusTopic?: string | null;
  primaryVoiceId: string;
  secondaryVoiceId: string | null;
  // User's interests with their LLM-generated context strings — used so the
  // script prompt knows that e.g. "shaboozey" is an artist and not a generic
  // topic name.
  interests: Interest[];
};

export type OpenAIProvider = {
  generateScript(params: GenerateScriptParams): Promise<Script>;
};

const log = logger.child({ provider: "openai" });
const MODEL = "gpt-4o";
const WORDS_PER_MIN = 150;

// Schemas — small and focused per section.
const INTRO_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: { text: { type: "string" } },
} as const;

const OUTRO_SCHEMA = INTRO_SCHEMA;

const SEGMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["topic", "lines"],
  properties: {
    topic: { type: "string" },
    lines: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "sourceUrl", "speaker"],
        properties: {
          text: { type: "string" },
          sourceUrl: { type: "string" },
          speaker: { type: "string", enum: ["primary", "secondary"] },
        },
      },
    },
  },
} as const;

export const openaiProvider: OpenAIProvider = {
  async generateScript(params) {
    if (isDryRun() || !appConfig.OPENAI_API_KEY) {
      log.debug({ articles: params.articles.length }, "dry-run: returning canned script");
      return cannedScript(params);
    }

    const primary = personaFor(params.primaryVoiceId);
    const secondary = params.secondaryVoiceId ? personaFor(params.secondaryVoiceId) : null;
    // GPT-4o consistently under-delivers on word targets, and the underdelivery
    // GROWS with length — the model "tires" / converges on a comfortable
    // segment size regardless of target. So we scale the overshoot with
    // duration: short episodes need ~15%, long ones need ~35% to land near
    // target. Linear ramp from 5min → 1.15 to 20min → 1.35, clamped.
    const OVERSHOOT = Math.min(1.4, Math.max(1.15, 1.15 + 0.013 * Math.max(0, params.targetLengthMin - 5)));
    const targetWords = Math.round(params.targetLengthMin * WORDS_PER_MIN * OVERSHOOT);
    const introWords = Math.round(targetWords * 0.07);
    const outroWords = Math.round(targetWords * 0.08);
    const segmentBudget = targetWords - introWords - outroWords;

    // Plan segments: one segment per "topic group" (article) within the
    // style's segment count. Each gets its own slice of the word budget.
    const segmentPlans = planSegments(params.articles, params.style, segmentBudget);
    if (segmentPlans.length === 0) {
      throw new Error("openai: no segments to generate (no articles?)");
    }

    const client = new OpenAI({ apiKey: appConfig.OPENAI_API_KEY });

    log.info(
      {
        model: MODEL,
        targetWords,
        introWords,
        outroWords,
        segmentCount: segmentPlans.length,
        perSegmentWords: segmentPlans.map((p) => p.targetWords),
        format: params.format,
        style: params.style,
        primary: primary.name,
        secondary: secondary?.name ?? null,
        focusTopic: params.focusTopic ?? null,
      },
      "generating script per-section",
    );

    // Phase 1 (parallel): intro and all segments at once. Intro only needs
    // the segment TOPICS (which we have from the plan), not the actual
    // content — so it doesn't have to wait.
    const [introText, segments] = await Promise.all([
      generateIntro(client, params, primary, secondary, segmentPlans, introWords),
      Promise.all(
        segmentPlans.map((plan) =>
          generateSegment(client, params, primary, secondary, plan),
        ),
      ),
    ]);

    // Phase 2: outro AFTER segments — it summarizes what was actually said,
    // not what the plan promised. Adds ~5-8s vs full-parallel, but the
    // outro becomes meaningful instead of generic.
    const outroText = await generateOutro(
      client,
      params,
      primary,
      secondary,
      segments,
      outroWords,
    );

    const wordCount =
      countWords(introText) +
      countWords(outroText) +
      segments.reduce(
        (sum, seg) => sum + seg.lines.reduce((n, l) => n + countWords(l.text), 0),
        0,
      );
    const estimatedDurationMs = (wordCount / WORDS_PER_MIN) * 60_000;

    log.info(
      {
        wordCount,
        targetWords,
        adherencePct: ((wordCount / targetWords) * 100).toFixed(0),
        estimatedDurationMs,
      },
      "script complete",
    );

    return { intro: introText, segments, outro: outroText, estimatedDurationMs };
  },
};

// -------------------------------------------------------------------- planning

type SegmentPlan = {
  articles: RankedArticle[];
  targetWords: number;
  topic: string;
};

function planSegments(
  articles: RankedArticle[],
  style: Style,
  segmentBudget: number,
): SegmentPlan[] {
  if (articles.length === 0) return [];
  switch (style) {
    case "deep_dive": {
      // Take the top 1-2 articles, give each a big chunk of the budget.
      const picks = articles.slice(0, Math.min(2, articles.length));
      const per = Math.round(segmentBudget / picks.length);
      return picks.map((a) => ({
        articles: [a],
        targetWords: per,
        topic: segmentTopicFor(a),
      }));
    }
    case "magazine": {
      // Group articles by topic, up to 3 thematic segments.
      const byTopic = new Map<string, RankedArticle[]>();
      for (const a of articles) {
        const list = byTopic.get(a.topic) ?? [];
        list.push(a);
        byTopic.set(a.topic, list);
      }
      const groups = [...byTopic.entries()].slice(0, 3);
      const per = Math.round(segmentBudget / groups.length);
      return groups.map(([topic, arts]) => ({ articles: arts, targetWords: per, topic }));
    }
    case "news_roundup":
    default: {
      // One segment per article, each with its OWN per-article topic (not
      // the user's broad interest). This stops the model from talking about
      // the same hot story in every segment.
      const per = Math.round(segmentBudget / articles.length);
      return articles.map((a) => ({
        articles: [a],
        targetWords: per,
        topic: segmentTopicFor(a),
      }));
    }
  }
}

// A segment's topic should describe THIS segment's article specifically —
// not the user's broad interest. If multiple segments share `topic = "F1"`
// the model conflates them and pulls in unrelated F1 stories. Using the
// article's title (trimmed) as the topic forces narrow scope.
function segmentTopicFor(a: RankedArticle): string {
  // Trim outlet suffix like " - The Race" and cap length.
  const cleaned = a.title.replace(/\s+[-–—]\s+[^-–—]+$/, "").trim();
  return cleaned.length > 0 && cleaned.length <= 80 ? cleaned : a.title.slice(0, 80);
}

// --------------------------------------------------------------------- system

function systemPrompt(language: Language): string {
  const langName = language === "es" ? "Spanish" : "English";
  return [
    "You are a podcast scriptwriter.",
    `Write in ${langName}.`,
    "Engaging, conversational prose grounded ONLY in the provided source articles.",
    "Never invent facts. Never invent URLs.",
    "Always respect the requested word budget — being under-budget is failure.",
  ].join(" ");
}

// ----------------------------------------------------------------------- intro

async function generateIntro(
  client: OpenAI,
  p: GenerateScriptParams,
  primary: VoicePersona,
  secondary: VoicePersona | null,
  segments: SegmentPlan[],
  targetWords: number,
): Promise<string> {
  const dateLabel = new Date().toLocaleDateString(p.language === "es" ? "es-ES" : "en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const previews = segments
    .map((s, i) => `${i + 1}. ${formatTopicWithContext(s.topic, p.interests)}: ${s.articles[0].title}`)
    .join("\n");

  const interestProfile = p.interests
    .filter((i) => i.context)
    .map((i) => `  - "${i.topic}" — ${i.context}`)
    .join("\n");

  const speakerLine = secondary
    ? `TWO speakers: ${primary.name} (the host, ${primary.flavor}) and ${secondary.name} (the co-host, ${secondary.flavor}). The intro is spoken by ${primary.name} ONLY. ${primary.name} should greet listeners, introduce themselves by name, and introduce ${secondary.name} by name before previewing the stories.`
    : `Single narrator: ${primary.name} (${primary.flavor}). ${primary.name} greets listeners and introduces themselves by name before previewing the stories.`;

  const focusLine = p.focusTopic
    ? `\nThis episode is focused on "${p.focusTopic}". Mention that in the intro.`
    : "";

  const interestLine = interestProfile
    ? `\n\nLISTENER'S INTEREST PROFILE (use the correct framing — e.g. if "shaboozey" is an artist, refer to them as an artist, not as a "topic"):\n${interestProfile}`
    : "";

  const NAMING_RULE = `The "text" field is what ${primary.name} says aloud. Do NOT prefix the text with "${primary.name}:" or any tag — the speaker is implied. The text reads as-is.`;

  const user = `Write the INTRO for a podcast episode.

CONTEXT
- Date: ${dateLabel}
- Tone: ${p.tone}
- ${speakerLine}${focusLine}${interestLine}

STORIES THIS EPISODE WILL COVER
${previews}

LENGTH BUDGET
- Target: ${targetWords} words. Going more than 20% under is failure.
- Cap: ${Math.round(targetWords * 1.3)} words.

STYLE
- Welcoming and natural. Not stiff. Hooky.
- Mention the host by name early ("I'm ${primary.name}"), but as part of the spoken text, not as a label.
${secondary ? `- Introduce ${secondary.name} explicitly ("…and I'm joined by ${secondary.name}, who…").` : ""}
- Tease 2-3 of the stories briefly (don't spoil details).
- End with a transition into the first story.
- ${NAMING_RULE}

CRITICAL — DO NOT NAME THE PODCAST
- This podcast has NO name. Do NOT say "Welcome to <name>", do NOT invent a name, and ABSOLUTELY do NOT write any bracketed placeholder like "[Podcast Name]", "[Show Title]", "<name here>", etc.
- Open by greeting the listener directly and introducing yourself: e.g. "Hey there — I'm ${primary.name}${secondary ? `, joined today by ${secondary.name}` : ""}, and today we're getting into…".

Return JSON { "text": "<the intro>" }. No prose around the JSON.`;

  const raw = await callForString(client, systemPrompt(p.language), user, INTRO_SCHEMA, "intro");
  return stripPlaceholders(stripSpeakerPrefix(raw));
}

// Strip bracketed/angle-bracketed template placeholders the model sometimes
// leaks ("[Podcast Name]", "<Show Title>", "{podcast}", etc.) — if the model
// emits these literally they get read aloud by TTS, which is the worst
// possible failure mode. Conservative: only matches square/angle/curly
// brackets containing text that looks like a placeholder ("name", "title",
// "show", "podcast", "host", "date" + optional descriptive words).
const PLACEHOLDER_RE =
  /\s*[\[\<\{][^\]\>\}]*?\b(?:podcast|show|episode|host|name|title|date|here|insert)\b[^\]\>\}]*?[\]\>\}]/gi;
function stripPlaceholders(text: string): string {
  return text.replace(PLACEHOLDER_RE, "").replace(/\s{2,}/g, " ").trim();
}

// ---------------------------------------------------------------------- outro

async function generateOutro(
  client: OpenAI,
  p: GenerateScriptParams,
  primary: VoicePersona,
  secondary: VoicePersona | null,
  segments: ScriptSegment[],
  targetWords: number,
): Promise<string> {
  const speakerLine = secondary
    ? `TWO speakers (${primary.name} primary, ${secondary.name} secondary), but the outro is spoken by ${primary.name} ONLY. ${primary.name} can thank ${secondary.name} for joining.`
    : `Single narrator: ${primary.name}.`;

  // Build a short, faithful summary of what each segment actually covered.
  // This is what makes the outro relevant — it references the real content,
  // not just the planned topic names.
  const segmentSummaries = segments
    .map((s, i) => {
      // Pick a handful of representative line texts (skip the very short
      // reactions like "Right.", "Yeah.").
      const meatyLines = s.lines
        .filter((l) => l.text.split(/\s+/).length >= 8)
        .slice(0, 3)
        .map((l) => l.text);
      return `${i + 1}. ${s.topic}
   key beats:
   - ${meatyLines.join("\n   - ")}`;
    })
    .join("\n");

  // CRITICAL — same anti-leak rule as segments. The outro is one speaker so
  // it shouldn't prefix with names either.
  const NAMING_RULE = `The "text" field is what's spoken aloud. Do NOT prefix with names like "${primary.name}:" or labels — the text reads aloud as-is.`;

  const user = `Write the OUTRO for a podcast episode that just covered the segments below.

CONTEXT
- Tone: ${p.tone}
- ${speakerLine}

WHAT THE EPISODE ACTUALLY COVERED
${segmentSummaries}

LENGTH BUDGET
- Target: ${targetWords} words. Going more than 20% under is failure.
- Cap: ${Math.round(targetWords * 1.3)} words.

STYLE
- Recap the most concrete thing(s) from above. Reference at least ONE specific point that was actually made (a number, a name, a story line).
- ${secondary ? `Thank ${secondary.name} by name.` : ""}
- Sign off naturally ("That's it for today", "See you tomorrow", etc.) — fit the tone.
- DO NOT add new facts or stories that weren't covered above.
- ${NAMING_RULE}

Return JSON { "text": "<the outro>" }. No prose around the JSON.`;

  const raw = await callForString(client, systemPrompt(p.language), user, OUTRO_SCHEMA, "outro");
  return stripPlaceholders(stripSpeakerPrefix(raw));
}

// -------------------------------------------------------------------- segment

async function generateSegment(
  client: OpenAI,
  p: GenerateScriptParams,
  primary: VoicePersona,
  secondary: VoicePersona | null,
  plan: SegmentPlan,
): Promise<ScriptSegment> {
  const speakerRules = speakerDirective(p.format, primary, secondary);
  const articleBlock = renderArticles(plan.articles);
  const densityHint = densityDescription(p.density);
  const perLine = perLineWordTarget(p.format);
  const linesPerSegment = Math.max(3, Math.round(plan.targetWords / perLine.avg));

  const focusReminder = p.focusTopic
    ? `\nThis segment must clearly relate to "${p.focusTopic}". If the source article below is NOT about that, you have made a mistake earlier — stop and return a brief segment that explicitly notes there's no fresh news on that topic today.`
    : "";

  const lineShape =
    p.format === "solo"
      ? `Each line is a PARAGRAPH of ${perLine.min}-${perLine.max} words.`
      : `Each line is ONE SHORT TURN by one speaker, ${perLine.min}-${perLine.max} words (1-2 sentences max).`;

  const topicContext = lookupTopicContext(plan.topic, p.interests);
  const topicLine = topicContext
    ? `SEGMENT TOPIC: ${plan.topic}\nWHAT THIS TOPIC IS: ${topicContext}\nFrame the segment accordingly. Refer to ${plan.topic} as what it is (e.g. an artist, a sport, a company) — never as "a topic called ${plan.topic}" or "the world of ${plan.topic}".`
    : `SEGMENT TOPIC: ${plan.topic}`;

  const user = `Write ONE SEGMENT of a podcast script.

${topicLine}

USER PREFERENCES
- Tone: ${p.tone}
- Density: ${p.density} — ${densityHint}
- Language: ${p.language}
- Format: ${p.format} — ${speakerRules}${focusReminder}

LENGTH BUDGET (HARD)
- Target: ${plan.targetWords} words.
- Minimum: ${Math.floor(plan.targetWords * 0.85)} words — anything below is a failure.
- Maximum: ${Math.ceil(plan.targetWords * 1.15)} words.

STRUCTURE
- ${lineShape}
- At least ${linesPerSegment} lines totaling >= ${plan.targetWords} words.
- ${p.format === "solo" ? "" : `Alternate speakers naturally. Never the same speaker twice in a row unless one is a 3-5 word reaction ("Right.", "Wait — really?").`}

MID-EPISODE CONTEXT (CRITICAL)
- The episode INTRO has ALREADY happened: listeners have been greeted, hosts have introduced themselves, and the story lineup has been previewed.
- This is a MID-EPISODE segment. Do NOT open with a greeting ("Hey everyone", "Welcome back", "Hi listeners"), a show-introduction ("welcome to the show", "today on the podcast"), a self-introduction ("I'm ${primary.name}"), or an episode preview.
- Start DIRECTLY on the substance: a hook line about THIS story (a punchy fact, a question, a "So…" / "Alright, so…" / "Onto…" transition into the story).

GROUNDING (STRICT — this is the #1 quality lever)
- This segment talks about ONE story: the one in the article(s) below. Do NOT bring in any other recent news, even if it's related to the same broader topic. Specifically: do NOT mix in events from other articles in this episode.
- Every line MUST cite a sourceUrl from the article(s) below — and the line's CONTENT must actually be supported by THAT article's BODY.
- NEVER invent URLs. NEVER cite an article whose body doesn't contain what you're saying.
- Draw substance from the BODY (the full text below), not just the SNIPPET.
- If the article is thin or off-topic, write a SHORTER segment rather than padding with unrelated facts.

GROUNDING IN THE NEWS (HARD — this is where scripts hallucinate most)
Your training data is months out of date. The article body is the source of truth for this segment — every CURRENT or FACTUAL claim comes from there, not from what you "know" about the topic.

The distinction that matters: NAMES vs CLAIMS.
- NAMES: fine to use names of people, teams, companies, products, places that are NOT in the article body — for natural conversation, comparison, or color. ("Reminds me of Hamilton's situation a few years back" / "the kind of thing Apple has done before").
- CLAIMS about those names: this is where things break. Any specific FACT you assert about an entity must come from one of two places:
  (a) the article body, OR
  (b) the deep historical record — outcomes that are SETTLED IN TIME and won't have changed (founding year of a long-established company, well-documented historical events with fixed dates, birthplace, the fact that someone is "a major figure in their field").

CLAIMS YOU MUST NOT MAKE FROM TRAINING DATA — these change constantly and your priors are stale:
- Who currently employs / coaches / partners with / is married to whom
- Who is currently on which team / in which role / at which company
- What anyone is currently working on, recently said, or recently did
- Current standings, current rankings, current contract status
- Current records and career totals (championships won, sales figures, follower counts — these tick over)
- Recent decisions, recent announcements, recent moves

ALL of those must come from the article body or not be said. The article is the cutoff date for all current-state claims in this segment.

THE NEWS IS THE STORY
The whole point of this segment is what THIS article reports. Lead with the article's facts, build the conversation around what the article says happened / will happen / is at stake. Other names are welcome as comparison or analogy, but they don't carry their own current-state baggage — only the article does.

SELF-CHECK BEFORE EACH LINE
For each factual claim in the sentence, ask: "Where did I get this — the article body, or my own knowledge?" If from your own knowledge AND it's a current/recent fact (not a settled historical one), cut it or replace it with what the article actually says.

SOURCE ARTICLE(S)
${articleBlock}

Return JSON { "topic": "<topic>", "lines": [{ "text": ..., "sourceUrl": ..., "speaker": "primary"|"secondary" }, ...] }. No prose around the JSON.`;

  let segment = await callForSegment(client, p, user);

  // Safety: strip any "Rachel: " / "[Host] " prefix the model may have leaked.
  segment = sanitizeSegment(segment);

  // Length: 2 sequential retries max. Each retry keeps the previous draft as
  // floor and adds; only accepted if STRICTLY longer.
  const minWords = Math.floor(plan.targetWords * 0.85);
  let currentWords = segment.lines.reduce((n, l) => n + countWords(l.text), 0);
  const MAX_RETRIES = 2;
  for (let attempt = 1; attempt <= MAX_RETRIES && currentWords < minWords; attempt++) {
    const retried = await retrySegmentForLength(
      client,
      p,
      plan,
      primary,
      secondary,
      segment,
      currentWords,
      minWords,
    );
    if (!retried) break;
    // Sanitize BEFORE counting so leaked "A: " / "Name:" prefixes don't
    // inflate the word count and trick us into accepting a fake-longer retry.
    const cleanedRetry = sanitizeSegment(retried);
    const retryWords = cleanedRetry.lines.reduce((n, l) => n + countWords(l.text), 0);
    if (retryWords > currentWords) {
      log.info(
        { topic: plan.topic, before: currentWords, after: retryWords, minWords, attempt },
        "segment expanded on retry",
      );
      segment = cleanedRetry;
      currentWords = retryWords;
    } else {
      log.warn(
        { topic: plan.topic, before: currentWords, retryWords, attempt },
        "segment retry produced fewer words — keeping previous",
      );
      break; // shrinking → another retry won't help, give up
    }
  }

  return segment;
}

async function callForSegment(
  client: OpenAI,
  p: GenerateScriptParams,
  user: string,
): Promise<ScriptSegment> {
  const completion = await client.chat.completions.create({
    model: MODEL,
    response_format: {
      type: "json_schema",
      json_schema: { name: "PodcastSegment", strict: true, schema: SEGMENT_SCHEMA },
    },
    messages: [
      { role: "system", content: systemPrompt(p.language) },
      { role: "user", content: user },
    ],
  });
  const raw = completion.choices[0]?.message.content;
  if (!raw) throw new Error("openai: empty segment response");
  return JSON.parse(raw) as {
    topic: string;
    lines: Array<{ text: string; sourceUrl: string; speaker: Speaker }>;
  };
}

function sanitizeSegment(seg: ScriptSegment): ScriptSegment {
  return {
    ...seg,
    lines: seg.lines.map((l, i) => {
      let text = stripSpeakerPrefix(l.text);
      // The first line is the highest-risk spot for a "welcome back" leak —
      // strip a leading greeting sentence if present so we don't deliver a
      // second intro mid-episode.
      if (i === 0) text = stripGreetingOpener(text);
      return { ...l, text };
    }),
  };
}

// If a segment's opening sentence is a podcast-style greeting / re-introduction
// ("Hey everyone, welcome back to the show!"), strip it. Conservative: only
// removes the FIRST sentence and only if it matches a greeting pattern. Leaves
// the rest of the line intact.
const GREETING_OPENER_RE =
  /^\s*(?:hey|hi|hello|alright|okay|ok|welcome)[^.!?]*?(?:\b(?:welcome\s+(?:back\s+)?(?:to\s+)?(?:the\s+)?(?:show|podcast|episode)|everyone|everybody|folks|listeners|guys|friends)\b[^.!?]*)?[.!?]\s+/i;
function stripGreetingOpener(text: string): string {
  if (text.length < 8) return text;
  const stripped = text.replace(GREETING_OPENER_RE, "");
  // Only accept if we actually removed a greeting AND meaningful content remains.
  if (stripped.length >= 12 && stripped !== text) return stripped;
  return text;
}

async function retrySegmentForLength(
  client: OpenAI,
  p: GenerateScriptParams,
  plan: SegmentPlan,
  primary: VoicePersona,
  secondary: VoicePersona | null,
  previous: ScriptSegment,
  previousWords: number,
  minWords: number,
): Promise<ScriptSegment | null> {
  const articleBlock = renderArticles(plan.articles);
  const speakerRules = speakerDirective(p.format, primary, secondary);
  // Render the previous draft as a JSON-style array of {speaker, text} objects
  // so the model sees the speaker as a STRUCTURED FIELD, not as a "Name:"
  // prefix inside text — otherwise it copies "Name:" / "A:" / "B:" into the
  // text field of its output, which TTS then reads aloud literally.
  const previousAsJson = JSON.stringify(
    previous.lines.map((l) => ({ speaker: l.speaker, text: l.text })),
    null,
    2,
  );

  const wordsNeeded = minWords - previousWords;
  const newLinesNeeded = Math.max(3, Math.ceil(wordsNeeded / 20));

  const user = `Your previous draft of this segment ran short (${previousWords} words; we need ≥${minWords}, target ${plan.targetWords}). You need to EXTEND it by adding ${newLinesNeeded}+ new lines (~${wordsNeeded} more words) of substance from the article body.

This is NOT about rephrasing what's there. The previous draft stays AS-IS; you APPEND new material that wasn't covered.

Previous draft (as JSON — every line object must appear in your output unchanged. The "speaker" field is structural; the "text" field is the spoken words — NEVER copy speaker info INTO the text field):
${previousAsJson}

SEGMENT TOPIC: ${plan.topic}

FORMAT RULES
${speakerRules}

WHAT TO ADD — every item below must come FROM THE ARTICLE BODY, not from your training data
- A specific NUMBER, percentage, dollar/budget figure, or date written in the article body.
- A QUOTE or paraphrased reaction the article attributes to a named person — using ONLY people the article body actually names.
- A MECHANISM / "how it works" detail the article body explains.
- PRIOR-EVENT context the article itself references (e.g. "the article notes this follows last year's…").
- IMPLICATIONS / NEXT STEPS the article body explicitly calls out.
- A skeptical/cautious counter-take only if the article body presents one.

Then continue the conversation naturally — speakers REACT to the new material with short interjections ("Huh.", "Wait, ${secondary?.name ?? "really"}?", "That's the part that—").

HARD RULES (in priority order — earlier rules override later ones)
1. THE ARTICLE IS THE SOURCE OF TRUTH for every current or factual claim. Names from outside the article are OK to use for comparison or color, but no current-state claim about them (who they're with now, what they're doing now, recent activity, current standings, current career totals) — that information in your training is months stale. Settled historical facts (founding year, well-documented past events, birthplace, "major figure in the field") are OK. Current state and recent activity must come from the article body.
2. NEVER invent facts. Every new line's substance must come from the article body or be a settled historical fact.
3. Output MUST contain every line from the previous draft above (verbatim).
4. SUBJECT TO rules 1+2: add as many new lines as the article body actually supports, aiming for ${newLinesNeeded}+ new lines and total words > ${previousWords}. If the article is genuinely thin and you cannot honestly add ${newLinesNeeded} grounded lines, add fewer — a slightly-too-short grounded segment is better than a target-length hallucinated one.
5. New lines must cite a sourceUrl from the article(s) below.
6. Maintain speaker alternation (no two same-speaker lines in a row unless one is a 3-5 word reaction).

SOURCE ARTICLE(S)
${articleBlock}

Return JSON { "topic": "<topic>", "lines": [...] }. No prose around the JSON.`;

  try {
    return await callForSegment(client, p, user);
  } catch (err) {
    log.warn(
      { topic: plan.topic, err: String(err).slice(0, 200) },
      "segment retry call failed",
    );
    return null;
  }
}

// ----------------------------------------------------------------- shared infra

async function callForString(
  client: OpenAI,
  system: string,
  user: string,
  schema: typeof INTRO_SCHEMA,
  name: string,
): Promise<string> {
  const completion = await client.chat.completions.create({
    model: MODEL,
    response_format: {
      type: "json_schema",
      json_schema: { name, strict: true, schema },
    },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  const raw = completion.choices[0]?.message.content;
  if (!raw) throw new Error(`openai: empty ${name} response`);
  const parsed = JSON.parse(raw) as { text: string };
  return parsed.text;
}

function speakerDirective(
  format: Format,
  primary: VoicePersona,
  secondary: VoicePersona | null,
): string {
  if (format === "solo" || !secondary) {
    return `Single narrator (${primary.name}). Every line speaker="primary".`;
  }
  const a = primary.name;
  const b = secondary.name;

  // CRITICAL — the "speaker" field in each line carries WHO is talking. The
  // "text" field is ONLY what they say aloud. The model MUST NOT prefix the
  // text with names like "Rachel:" or include speaker tags — that ends up
  // being read out by TTS and ruins the episode. We also strip any leaking
  // prefix in post-parse as a safety net.
  const NAMING_RULE = `CRITICAL: the "speaker" JSON field carries who's talking. The "text" field is the spoken words ONLY — NEVER prefix the text with names like "${a}:" or "${b}:", NEVER include "[Host]" or "[Co-host]" tags. The text must read aloud naturally without those labels.`;

  switch (format) {
    case "co_host":
      return [
        `NATURAL, INTERACTIVE dialogue between ${a} (primary, host) and ${b} (secondary, co-host).`,
        `They REACT TO EACH OTHER. ${b} interrupts, asks short questions, completes thoughts.`,
        `Acceptable reaction lines (just the words, no name prefix): "Right, and—", "Wait, hold on.", "Yeah, exactly.", "Hmm.".`,
        `Don't write monologues. Real podcasts have one speaker stopping mid-thought when the other reacts.`,
        NAMING_RULE,
      ].join(" ");
    case "debate":
      return [
        `Respectful DEBATE between ${a} (optimistic / favorable) and ${b} (skeptical / cautionary).`,
        `They REACT to each other's points specifically.`,
        `Acceptable lines (just the words, no name prefix): "But you're missing—", "Sure, except—", "I disagree, because—".`,
        `Each turn references what the other JUST said. Don't let them deliver pre-written speeches.`,
        `Both views must be grounded in the article body. NEVER invent positions.`,
        NAMING_RULE,
      ].join(" ");
    case "interview":
      return [
        `INTERVIEW: ${a} (host) asks short questions, ${b} (expert) answers.`,
        `${a}'s questions are 10-25 words. ${b}'s answers are 20-50 words.`,
        `Alternate strictly: question → answer → follow-up → answer. Natural reactions like "Got it — so...", "Interesting, and what about..." (just the words).`,
        NAMING_RULE,
      ].join(" ");
    default:
      return `${a} alternates with ${b}. ${NAMING_RULE}`;
  }
}

// Safety net: strip speaker-label prefixes that may leak into the spoken text
// despite the prompt rules. Catches:
//   "Rachel: ..."          → name + colon
//   "Rachel Adams: ..."    → two-word name + colon
//   "[Host] ..."           → bracketed tag
//   "A: ..." / "B: ..."    → single-letter shorthand (the retry's previous
//                            format leaked these)
//   "Speaker 1: ..."       → numbered speaker tags
// Conservative: requires a colon and only matches at the start of the line, so
// it won't eat content like "I:" or "A: B: C" inside a sentence.
const NAME_PREFIX_RE =
  /^\s*(?:\[[^\]]+\]|[A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]+)?|Speaker\s*\d+)\s*:\s+/;
function stripSpeakerPrefix(text: string): string {
  if (text.length < 3) return text;
  // Loop in case the model stacked tags ("Rachel: A: hello").
  let cleaned = text;
  for (let i = 0; i < 3; i++) {
    const next = cleaned.replace(NAME_PREFIX_RE, "");
    if (next === cleaned) break;
    cleaned = next;
  }
  return cleaned;
}

function perLineWordTarget(format: Format): { min: number; max: number; avg: number } {
  if (format === "solo") return { min: 40, max: 80, avg: 60 };
  if (format === "interview") return { min: 12, max: 50, avg: 28 };
  return { min: 12, max: 40, avg: 22 }; // co_host, debate
}

function densityDescription(density: Density): string {
  return density === "headline"
    ? "headline + 1-2 sentences per article"
    : "full context: what happened, why it matters, what's next";
}

function renderArticles(articles: RankedArticle[]): string {
  return articles
    .map((a, i) => {
      const body = (a.body ?? "").slice(0, 5000);
      return [
        `[${i + 1}] TOPIC: ${a.topic}`,
        `    TITLE: ${a.title}`,
        `    URL: ${a.url}`,
        `    SOURCE: ${a.source}`,
        `    SNIPPET: ${a.snippet}`,
        body ? `    BODY: ${body}` : `    BODY: (not enriched)`,
      ].join("\n");
    })
    .join("\n\n");
}

function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

// Lookup the LLM-generated context for a topic. Compares case-insensitively
// because the topic string travels through several stages (rank assigns
// `Interest.topic` verbatim, but the model + filters may downcase along the
// way). Returns null when the user added the topic before context backfill.
function lookupTopicContext(topic: string, interests: Interest[]): string | null {
  const target = topic.toLowerCase().trim();
  for (const i of interests) {
    if (i.topic.toLowerCase().trim() === target && i.context) return i.context;
  }
  return null;
}

// Render the topic with an inline context hint for the intro preview line.
// "shaboozey (American country/hip-hop artist)" reads naturally and tells the
// model the topic's nature in the same pass.
function formatTopicWithContext(topic: string, interests: Interest[]): string {
  const ctx = lookupTopicContext(topic, interests);
  return ctx ? `${topic} (${ctx.replace(/\.$/, "")})` : topic;
}

// ----------------------------------------------------------------- dry-run stub

function cannedScript(p: GenerateScriptParams): Script {
  const intro =
    "Welcome back to your personal podcast. Here's what's worth your time today.";
  const outro = "That's all for today. Catch you tomorrow.";

  const byTopic = new Map<string, RankedArticle[]>();
  for (const a of p.articles) {
    const list = byTopic.get(a.topic) ?? [];
    list.push(a);
    byTopic.set(a.topic, list);
  }

  const segments = [...byTopic.entries()].map(([topic, items]) => ({
    topic,
    lines: items.map((a, i) => ({
      text: `In ${topic}: ${a.title}. ${a.snippet}`,
      sourceUrl: a.url,
      speaker: (p.format === "solo" || i % 2 === 0 ? "primary" : "secondary") as Speaker,
    })),
  }));

  const wordCount =
    countWords(intro) +
    countWords(outro) +
    segments.reduce(
      (sum, s) => sum + s.lines.reduce((n, l) => n + countWords(l.text), 0),
      0,
    );
  return {
    intro,
    segments,
    outro,
    estimatedDurationMs: (wordCount / WORDS_PER_MIN) * 60_000,
  };
}
