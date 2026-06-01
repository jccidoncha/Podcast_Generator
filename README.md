# Personal Podcast Generator

Fetches fresh news on your interests, writes a co-host script grounded in the source articles, synthesizes the audio with ElevenLabs, and serves the episode in a Spotify-style player with click-to-seek transcript. Generate on demand or on a per-user daily schedule.

> 📐 For architecture, design decisions, quality story, evals, and diagrams, read **[solution.md](./solution.md)**.
> 🤝 For contributor / agent guidance (conventions, gotchas, where things live), read **[CLAUDE.md](./CLAUDE.md)**.

---

## Quick start

### 1. Prerequisites
- **Node.js 20+** (tested on 22 and 26)
- **pnpm** (enforced via `packageManager` + `engine-strict`; using npm/yarn will diverge the lockfile)
- A **Supabase** project (free tier is fine), an **OpenAI** API key, and an **ElevenLabs** API key

### 2. Install & configure
```bash
pnpm install
cp .env.example .env
```

Fill in `.env`:
- `DATABASE_URL` — Supabase **transaction-mode pooler** (port 6543), **with** `?pgbouncer=true&connection_limit=1` appended. Without those params you'll see `P1017 Server has closed the connection` after idle periods.
- `DIRECT_URL` — Supabase **session-mode pooler** (port 5432). Used by Prisma migrations only.
- `OPENAI_API_KEY` — for embeddings + script + interest extraction.
- `ELEVENLABS_API_KEY` — for TTS.
- `DRY_RUN=true` while you experiment — providers return canned data and no API spend happens. Set to `false` for real generation.

`.env.example` documents every variable inline. See **solution.md → "Stack & why" → Database row** for why those pooler params matter.

### 3. Migrate + seed the database
```bash
pnpm exec prisma migrate dev    # creates all tables in your Supabase
pnpm db:seed                    # creates the demo user, default config, 2 starter interests
```

`migrate dev` creates the tables (users, interests, configs, runs, episodes, sources) and generates the Prisma client. `db:seed` is **idempotent** — `upsert` based, safe to re-run; it preserves interests you've already edited.

Without the seed step you'd get a 404 from `/api/config` and a foreign-key error from `POST /api/runs` because the hard-coded `demo-user` row wouldn't exist yet.

### 4. Run the two processes
In separate terminals:
```bash
pnpm dev       # Next.js — UI, dashboard, API routes  → http://localhost:3000
pnpm worker    # Long-lived worker — cron + pending poller + janitor
```

Open `http://localhost:3000`. First visit redirects to **/onboarding** — describe your interests in natural language, pick voice + format + length, and click "Create my first podcast". The worker picks up the queued run and the homepage's toast notifies you when the episode is ready (≈60-90s depending on script length).

---

## Common scripts

| Command                          | What it does                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                       | Next.js dev server (UI + API + dashboard) on port 3000.                                                        |
| `pnpm worker`                    | Long-lived worker process. Restart it after editing `.env` — `node-cron` reads the cron string once at boot.   |
| `pnpm build` / `pnpm start`      | Production build + serve.                                                                                      |
| `pnpm typecheck`                 | `tsc --noEmit` — strict TypeScript, no `any`.                                                                  |
| `pnpm lint`                      | ESLint.                                                                                                        |
| `pnpm test`                      | Unit tests (Vitest, mocked providers — no real API calls).                                                     |
| `pnpm eval`                      | Quality eval suite (Layer A deterministic + Layer B groundedness + Layer C LLM-as-judge). See solution.md §Quality. |
| `pnpm exec prisma migrate dev`   | Apply schema changes in dev.                                                                                   |
| `pnpm db:seed`                   | Idempotent seed — creates demo user + default config + starter interests. Run once after migrating a fresh DB. |
| `pnpm exec prisma studio`        | Browse the DB.                                                                                                 |

---

## Project layout

```
/app                Next.js App Router — listener UI, dashboard, API route handlers
/worker             Long-lived worker process: cron + pending poller + janitor
/src
  /pipeline         Stages: collect → rank → enrich → script → synthesize → persist
  /providers        Vendor isolation — OpenAI, ElevenLabs, Jina, RSS, Google News
  /evals            Eval harness + Layer A/B/C checks + rubrics
  /lib              Config, logger, shared utils
  /db               Prisma client (with transient-error retry) + helpers
/prisma             schema.prisma + migrations
/public/audio       Generated mp3s (local FS in dev; S3 in prod)
/tests              Unit + integration tests mirroring src structure
```

A full architectural walkthrough (system diagram, sequence diagram, pipeline detail) is in **[solution.md](./solution.md)**.

---

## Operating gotchas (read once)

- **Editing `.env`** does **not** restart `pnpm worker` automatically (tsx watch only follows `.ts` files). Restart the worker by hand after any env change.
- **Prisma schema changes** require `pnpm exec prisma migrate dev` AND a restart of any process that already imported `@prisma/client` (Next dev server, worker). Otherwise you'll get `Unknown argument` errors on the new fields.
- **`DRY_RUN=true`** is the default in `.env.example` to prevent accidental TTS spend. Set `DRY_RUN=false` only when you want real audio.
- **`public/audio/`** is gitignored and ephemeral. Don't `rm -rf` it during dev — old `Episode` rows in the DB reference filenames there. If you do, the episode page will render an "audio not available" message instead of a broken player.

---

## What's intentionally out of scope (MVP)

Auth (single hard-coded `demo-user`), S3 audio storage (local FS in dev — the `StorageProvider` abstraction is in place for the swap), real listen-through / download tracking (mocked on the dashboard with a `MOCK` badge), BullMQ + Redis (Postgres-as-queue is sufficient), multi-worker horizontal scaling.

The rationale for each — and what the upgrade path looks like — is in **solution.md → "What's intentionally out of scope"**.
