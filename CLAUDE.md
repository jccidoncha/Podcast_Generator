# CLAUDE.md

Guidance for Claude Code (and humans) working in this repository.

## 1. Project overview

**Personal Podcast Generator** — a tool that learns a user's interests, gathers
fresh news about those topics on a schedule, and produces an engaging audio
episode covering them.

The product has three user-facing surfaces:

1. **Listener UI** — where a user sets interests, customizes the podcast (voice,
   length, tone, frequency), and listens to / downloads generated episodes.
2. **Generation pipeline** — backend that fetches news, writes a script, and
   synthesizes audio on a schedule.
3. **Internal metrics dashboard** — shows product-health/usage metrics. Mocked
   data is acceptable here.

## 2. Architecture & key decisions

> ⚠️ The brief did not specify a stack. These are the assumed defaults, recorded
> as decisions with their tradeoffs so they can be challenged deliberately
> rather than drifted into. If you change a decision, update its entry here so
> this file stays the source of truth.

Each entry: **Decision → why → tradeoff → revisit when**.

### 2.1 App shell: Next.js (App Router) for UI + dashboard + API
- **Why:** one language/repo covers the listener UI, the internal dashboard, and
  the HTTP API, with shared TypeScript types end-to-end. Fast to build.
- **Tradeoff:** couples three concerns in one deploy; request handlers have short
  timeouts, so they are *not* suitable for the long-running generation work
  (hence the separate worker below).
- **Revisit when:** the UI and API need to scale or deploy independently, or the
  team splits frontend/backend ownership.

### 2.2 Generation runs in a separate worker process
- **Why:** episode generation is long-running (LLM + TTS take seconds to
  minutes), needs retries, and runs on a schedule — a poor fit for serverless
  request/response handlers.
- **Tradeoff:** a second runtime to deploy and monitor; intermediate state must
  be persisted so the worker and the web app stay in sync.
- **Revisit when:** generation latency drops enough to fit a request, or you move
  to a managed jobs platform.

### 2.3 Scheduling: `node-cron` for MVP, BullMQ + Redis later
- **Why (`node-cron`):** zero extra infra, trivial to start.
- **Tradeoff:** in-process and stateless — no durable queue, no automatic
  retries, jobs lost on restart, doesn't fan out across instances, single point
  of failure.
- **Revisit when (→ BullMQ + Redis):** you need retries with backoff, concurrency
  control, job persistence, or multiple workers. Cost: running and operating
  Redis. A managed cloud scheduler is a third option if you'd rather not own a
  queue.

### 2.4 News sourcing: multi-source collect → MMR rank → Jina enrich
- **Why:** the production pipeline does NOT rely on a single source. It runs a
  three-stage chain (`/src/pipeline/{collect,rank,enrich}.ts`):
  1. **Collect** — broad shortlist from RSS feeds (`/src/providers/rss.ts`,
     ~8 reliable feeds) and NewsAPI keyword search per interest
     (`/src/providers/news.ts`, optional, kicks in only when `NEWS_API_KEY`
     is set). Typical yield: 50–150 candidates per run.
  2. **Rank** — embeddings (`text-embedding-3-small`) + MMR with λ=0.7 to pick
     the top N relevant *and* diverse articles. Implemented in
     `/src/providers/embeddings.ts` and `/src/pipeline/rank.ts`. Avoids
     selecting 5 articles about the same incident.
  3. **Enrich** — fetch full article text via Jina Reader (free, no key,
     `/src/providers/enricher.ts`) for the top N. This is the substance the
     script stage cites; without it, the script can only paraphrase snippets.
- **Tradeoff (multiple network deps):** RSS feeds break, Jina Reader rate-
  limits. Each per-source call is `Promise.allSettled` so one failure doesn't
  kill the run.
- **Tradeoff (non-determinism):** rankings are stable for the same inputs but
  the input set changes minute-to-minute as feeds publish. Evals score against
  a frozen fixture set (CLAUDE.md §9.3).
- **OpenAI research agent** (`/src/providers/researcher.ts`) is **retained but
  not wired** as the gather stage. It was the first iteration; the multi-source
  chain is cheaper and produces more material. The agent remains available for
  future refinements (e.g. a fallback when RSS is dry).
- **Revisit when:** rank quality drops (consider rerankers like Cohere),
  enrichment becomes a bottleneck (parallelize more, or move to a paid scraper
  like Firecrawl with full DOM), or feed mix becomes stale (rotate the list).

### 2.5 Data: PostgreSQL (Supabase) + Prisma
- **Why:** the domain is relational (users → interests, runs → episodes →
  sources). Prisma gives typed queries and managed migrations. For the
  technical-test scope we use **Supabase** as the managed Postgres provider
  (zero infra to set up, free tier, standard Postgres connection string in
  `DATABASE_URL`). In a real prod we'd swap to RDS / Cloud SQL / self-hosted
  Postgres — the change is just the connection string.
- **Tradeoff:** Prisma adds a build/runtime layer and its migration model needs
  discipline; raw SQL is sometimes clearer for analytics queries. Supabase
  ties us to one vendor for the demo, but because everything is plain
  Postgres + Prisma the lock-in is shallow.
- **Connection setup (important):** the `DATABASE_URL` MUST include
  `?pgbouncer=true&connection_limit=1` to play nicely with Supabase's
  transaction-mode pooler. Without it you'll hit `P1017 Server has closed the
  connection` after idle periods. `DIRECT_URL` (session pooler, port 5432) is
  used by Prisma for migrations only. The Prisma client in `src/db/client.ts`
  also wraps every query with a transparent retry on `P1001/P1002/P1008/P1017`
  as a belt-and-braces measure for transient pooler drops.
- **Revisit when:** analytics/dashboard queries outgrow the ORM (consider a
  read replica or a separate analytics store), or when the team wants
  Supabase-specific features (auth, row-level security, realtime) — those
  would push us deeper into the platform on purpose.

### 2.6 Audio storage: local FS in dev, S3-compatible in prod
- **Why:** local keeps dev frictionless; object storage is durable and CDN-able
  in prod.
- **Tradeoff:** local doesn't persist across instances or deploys, so the prod
  path must be exercised early to avoid surprises. The `StorageProvider`
  abstraction (`/src/providers/storage.ts`) already isolates the swap —
  `LocalStorage` wired, `S3Storage` is a stub.
- **Revisit when:** you need signed URLs, CDN delivery, or lifecycle/retention
  policies for old episodes.

### 2.6b Stitched TTS: per-segment synthesis + byte-concat mp3
- **Why:** the synthesize stage splits the script into chunks (intro + each
  segment + outro) and calls ElevenLabs in parallel via
  `elevenlabsProvider.synthesizeMany()`. Cuts TTS latency from ~80s to ~15s on
  a 6-segment, 1100-word script. A failed chunk is logged but the rest still
  ships — partial recovery.
- **Why byte concat (not ffmpeg):** we always request `mp3_44100_128` (CBR,
  same codec/bitrate/sample rate per chunk). CBR mp3 frames are
  self-synchronizing, so `Buffer.concat()` produces a valid mp3 without
  re-encoding. Implemented in `/src/providers/audio-stitch.ts`. No ffmpeg
  dependency.
- **Tradeoff:** if we ever need crossfades, silence padding, or mixed-codec
  segments, we have to introduce `fluent-ffmpeg` + a concat demuxer. For the
  current product (continuous narration) byte-concat is sufficient.
- **Revisit when:** the listener UX needs music beds, transitions, or
  per-segment voice changes.

### 2.7 AI providers: OpenAI (embeddings + script) + ElevenLabs (TTS) + Jina (enrich)
- **Why:** all vendor calls live in `/src/providers` — application code never
  imports a vendor SDK directly. Current roles:
  - **OpenAI**: `text-embedding-3-small` for the rank stage; `gpt-4o` with
    `response_format: json_schema` for the script (paragraph-grade, hard
    word budget, ramified by `style/density/language`).
  - **ElevenLabs**: TTS via `synthesizeMany` (parallel per-chunk) + byte-concat
    stitching (§2.6b). Voice settings live in
    `/src/providers/elevenlabs.ts`.
  - **Jina Reader** (`r.jina.ai`): enrichment, free, no key. Wrapper in
    `/src/providers/enricher.ts`.
- **Tradeoff:** vendor lock-in concentrated on OpenAI (two jobs) and Jina
  (free tier may rate-limit at scale). The provider abstraction is the
  mitigation but adds indirection. If Jina ever fails, the enrich stage
  fallback is to keep snippets only — script still runs, just thinner.
- **Revisit when:** cost or quality pushes you to swap a provider — the
  isolation layer is what makes that a localized change. Cohere reranker for
  rank, or Firecrawl for enrich, are the natural upgrade paths.

### 2.8 Pipeline as discrete, retryable stages (not one big function)
- **Why:** each stage (gather → filter → script → synthesize → persist) has clear
  inputs/outputs, is independently testable, and can be retried at the failing
  step instead of re-running (and re-paying for) the whole episode.
- **Tradeoff:** more orchestration code and intermediate state to persist.
- **Revisit when:** never, really — this is load-bearing for cost control and
  evals.

## 3. The core pipeline

The heart of the product. Each scheduled run for a user does:

1. **Resolve config** — load the user's `PodcastConfig` + `Interest[]` from DB
   (`src/db/context.ts`). Create a `Run(status=PENDING)` row.
2. **Collect** — broad shortlist from RSS feeds (+ NewsAPI per interest if
   key is set). `src/pipeline/collect.ts`.
3. **Rank** — embeddings + MMR (λ=0.7) to keep top-N relevant *and* diverse.
   `src/pipeline/rank.ts`.
4. **Enrich** — Jina Reader fetches full body text for the top-N.
   `src/pipeline/enrich.ts`.
5. **Script** — `gpt-4o` with `json_schema`, hard word budget,
   `style/density/language`-aware prompts, single expansion retry if under
   85% of MIN_WORDS. `src/providers/openai.ts`.
6. **Synthesize** — ElevenLabs `synthesizeMany` parallelizes per-chunk TTS
   (intro + each segment + outro), stitches via byte-concat of CBR mp3 frames
   (§2.6b). Partial failures are tolerated.
7. **Persist** — atomic transaction: `Episode` + `Source[]` + `Run.SUCCEEDED`.
   Idempotent on `runId`. `src/pipeline/persist.ts`.
8. **Surface** — episode appears in `/episodes` (Prisma-backed) immediately.

Stages are separate, testable modules with explicit I/O so failures retry at the
right step.

## 4. Suggested directory structure

```
/app                  # Next.js routes (listener UI + dashboard + API handlers)
  /(listener)         # user-facing podcast UI
  /dashboard          # internal metrics dashboard (mocked data OK)
  /api                # route handlers
/src
  /pipeline           # collect, rank, enrich, script, synthesize, persist (one file each) + stage.ts (Stage<I,O> interface + runStage)
  /providers          # thin clients: openai, elevenlabs, news apis, scraper
  /evals              # eval harness, rubrics, golden fixtures, judges
  /lib                # shared utils, config loading, logging
  /db                 # prisma client + helpers
/worker               # scheduler entrypoint + job definitions
/prisma               # schema.prisma + migrations
/tests                # unit/integration tests mirroring src structure
```

## 5. Common commands

> **Package manager: pnpm only.** The repo declares `packageManager` in
> `package.json` and `engine-strict=true` in `.npmrc`. Don't use `npm` or
> `yarn` — the lockfile is `pnpm-lock.yaml` and mixing managers will diverge it.

```bash
pnpm dev              # run the Next.js app (UI + dashboard + API)
pnpm worker           # run the scheduler/worker process
pnpm build            # production build
pnpm lint             # eslint
pnpm typecheck        # tsc --noEmit
pnpm test             # run tests
pnpm eval             # run the output-quality eval suite (see section 9)
pnpm exec prisma migrate dev   # apply schema changes in dev
pnpm exec prisma studio        # inspect the DB
```

> If you add or rename a script, update this list.

## 6. Environment & secrets

Keep these in `.env` (gitignored), never commit them. `.env.example` is the
committed template:

```
OPENAI_API_KEY=        # research agent + script generation (§2.4 + §2.7)
ELEVENLABS_API_KEY=    # TTS
# NEWS_API_KEY=        # OPTIONAL legacy fallback — only if you re-wire news.ts
DATABASE_URL=          # Supabase transaction-mode pooler (pgbouncer, app)
DIRECT_URL=            # Supabase session-mode pooler (Prisma migrations)
DRY_RUN=true           # when true, providers return canned data (no real API calls)
WORKER_CRON="*/15 * * * *"
LOG_LEVEL=info
# REDIS_URL=        # only if/when BullMQ is introduced
# S3_* / BUCKET     # only for prod audio storage
```

**Rules for secrets:**
- Never hardcode keys; read them from `process.env` via a single typed config
  module in `/src/lib`.
- Never log full keys or request bodies containing them.
- Keep `.env.example` (empty values) updated whenever a new var is added.

## 7. Conventions

- **Package manager: pnpm only.** See §5. The `packageManager` field +
  `engine-strict=true` enforce this; using `npm`/`yarn` will corrupt the
  lockfile.
- **TypeScript strict**; no `any` unless justified with a comment.
- **Provider isolation:** all third-party calls go through `/src/providers`.
  Application code must not import vendor SDKs directly.
- **Errors:** fail loud at the boundary, return typed results internally. A
  failed pipeline stage logs context (user id, run id, stage) and does not crash
  the worker.
- **Idempotency:** scheduled runs must be safe to retry. Use a run record with a
  status so a re-run doesn't duplicate episodes.
- **Naming:** files `kebab-case`, types/components `PascalCase`,
  functions/vars `camelCase`.
- Prefer small, pure functions for pipeline logic; push side effects to edges.

## 8. Important constraints & gotchas

- **TTS is expensive and slow.** Cap episode length, cache audio, never
  re-synthesize unchanged scripts. Track per-episode cost.
- **LLM cost/limits.** Summarize/trim article text before prompting; never dump
  full HTML. Set token/length budgets.
- **Scraping etiquette.** Respect `robots.txt`, set a real User-Agent,
  rate-limit, prefer official APIs. Scraping is a fallback, not the default.
- **News freshness.** Filter out items older than the user's cadence window so
  episodes don't repeat yesterday's stories.
- **Rate limits.** Retry-with-backoff in provider clients; surface quota errors
  rather than silently shipping empty episodes.

## 9. Evals (output quality)

This is a generative, non-deterministic system: correctness is about *quality*,
not pass/fail. Evals are first-class, live in `/src/evals`, and run via
`npm run eval`. They should be **cheap and deterministic** — run against
**fixed article fixtures** in dry-run (stubbed TTS), so they don't spend API
credits and can gate changes.

### 9.1 What we evaluate

- **News selection** — relevance to the user's interests, freshness within
  cadence, topical diversity, dedup effectiveness, and absence of empty/paywalled
  items.
- **Script (most important)** —
  - **Groundedness/faithfulness:** every claim is supported by a selected source
    article (no hallucinated news). This is the highest-priority eval.
  - **Coverage:** the selected items actually appear in the script.
  - **Structure & length:** intro/segments/outro present; duration within the
    target window.
  - **Tone & engagement:** matches the user's chosen tone; no repetition or
    filler.
- **Audio** — correct duration, no obvious artifacts, acceptable pronunciation
  and pacing. Hardest to automate; relies more on spot checks.
- **End-to-end** — does the finished episode match the requested interests,
  length, and cadence?

### 9.2 How we evaluate

- **Deterministic checks** (cheap, run always): length/duration budget, presence
  of structure, every claim carries a source reference, no duplicate segments,
  reading-level/banned-phrase checks.
- **Groundedness check:** verify script claims against the source article text
  (LLM-assisted entailment or retrieval-overlap scoring).
- **LLM-as-judge** with explicit rubrics for the subjective axes (tone,
  engagement, coverage), scored against a **golden set** of input fixtures.
- **Human spot checks:** sample a few real episodes regularly, especially for
  audio, which automated checks cover poorly.
- **Online signals → dashboard:** listen-through, skips, downloads, and 👍/👎
  feed back as a production quality signal (section 10).

### 9.3 Eval tradeoffs (be honest about these)

- **LLM-as-judge** is scalable and cheap but **noisy and biased** (position
  bias, verbosity bias, self-preference). Mitigate with fixed rubrics, a stable
  judge model/version, and a human-reviewed golden set as ground truth.
- **No reference outputs exist** for generated podcasts, so most script evals are
  **reference-free rubric scoring** plus groundedness — weaker than exact-match,
  but appropriate for open-ended generation.
- **Audio quality** largely resists automation; budget for periodic human review
  rather than pretending a metric covers it.
- **Fixtures drift:** real news changes, so the golden fixture set must be
  refreshed periodically or it stops representing live behavior.

### 9.4 How evals are used

- Run in CI on changes to prompts, pipeline logic, or provider config.
- Treat them as **regression gates:** a meaningful drop in groundedness or
  rubric scores blocks the change.
- Record per-episode eval scores in the DB so quality is trackable over time and
  visible on the dashboard.

## 10. Internal dashboard

Tracks product success. **Mocked data is acceptable**, but structure it so it
could be wired to real tables later. Suggested metrics: active users, episodes
generated, listen-through / downloads, generation success rate, average
generation time, per-episode API cost, and **average output eval scores** over
time. Behind `/dashboard`, clearly labeled internal.

## 11. Testing

- Unit-test each pipeline stage with **mocked provider clients** — no real API
  calls in tests.
- Cover the tricky paths: dedup/filtering, script length budgeting, retry/
  idempotency.
- Keep an end-to-end **dry-run mode** (stubbed audio) so the full flow — and the
  eval suite — can run without spending TTS credits.
- Tests verify *behavior is correct*; evals (section 9) verify *output quality is
  good*. Keep them separate.

## 12. What to do / avoid when building here

- ✅ When adding a feature, update this file if it changes a decision, the
  structure, commands, env vars, or evals.
- ✅ Keep the listener UI and the internal dashboard clearly separated.
- ✅ Make the smallest change that satisfies the requirement; compose existing
  pipeline modules.
- ✅ Add or update an eval when you change prompts or pipeline logic.
- ❌ Don't call vendor SDKs outside `/src/providers`.
- ❌ Don't commit secrets, audio files, or `node_modules`.
- ❌ Don't trigger real OpenAI/ElevenLabs calls in tests, evals, or CI.
- ❌ Don't use `npm` or `yarn`. Use `pnpm` exclusively (see §5).
