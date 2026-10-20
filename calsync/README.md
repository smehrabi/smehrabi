# CalSync

Mesh calendar synchronization across **Google Workspace** and **Microsoft 365**,
with **per-link privacy levels**. An event created/edited/deleted in any
connected calendar is mirrored into the calendars it's linked with; each
directed link independently controls how much detail is shared.

> Status: **Phase 0 + Phase 1 skeleton.** The data model, provider abstraction,
> and the core sync engine (privacy transforms, loop prevention, idempotent
> apply) are in place with unit tests. Live Nylas wiring, auth, dashboard,
> backfill, and reconciliation are the next phases (see the plan).

## How sync works

- Every event has an **origin** calendar (full detail). Copies pushed to linked
  calendars are **mirrors**.
- A **SyncLink** is a *directed edge* (`source → target`) carrying one
  **privacy level**:
  - **full** — title, time, location, description
  - **title_only** — title + time
  - **busy_only** — opaque "Busy" + time
  Bidirectional sync = two links. Privacy is **per link**, never per event.
- **Attendees are always stripped** — a mirror never re-invites anyone.
- **Mirrors never re-propagate.** Three independent guards make mesh loops
  impossible:
  1. mirrors carry a `cs_managed` metadata tag,
  2. we look up incoming events against `EventLink.mirrorProviderEventId`,
  3. a **content-hash** no-op drops our own write-echo,
  plus per-target-calendar **write serialization** so the echo arrives after the
  hash is stored.

## Architecture

| Piece | What it is |
|---|---|
| `web` process (`src/main.ts`) | Fastify/NestJS HTTP + signature-verified webhook ingress; returns 200 fast and enqueues. |
| `worker` process (`src/worker.ts`) | BullMQ consumers: parse webhooks → `ChangeEvent` rows → run the engine. |
| `src/providers/calendar-provider.port.ts` | Vendor-neutral `CalendarProvider` interface + `CanonicalEvent`. Engine never imports a vendor SDK. |
| `src/providers/nylas.provider.ts` | Nylas v3 driver (chosen aggregator). Swappable for a Cronofy driver. |
| `src/sync/sync-engine.service.ts` | The core algorithm: loop guards, privacy transforms, idempotent create/update/delete. |
| `prisma/schema.prisma` | PostgreSQL data model (tenant, connected_account, calendar, sync_link, event_link, change_event, webhook_delivery). |

## Local development

```bash
cd calsync
cp .env.example .env            # fill in NYLAS_* from your sandbox app
docker compose up -d            # Postgres + Redis
npm install
npm run prisma:generate
npm run prisma:migrate          # creates the schema
npm test                        # runs the engine unit tests

# two processes:
npm run dev:web                 # http://localhost:3000  (webhook: POST /webhooks/nylas)
npm run dev:worker              # queue consumers
```

Expose the web process over HTTPS (e.g. an `ngrok`/`cloudflared` tunnel in dev)
and register that URL as your Nylas webhook endpoint for `event.created`,
`event.updated`, `event.deleted`.

## What's intentionally not here yet

- App auth / multi-tenant sign-up (Phase 3) — tables carry `tenantId` already.
- Backfill on link creation + reconciliation sweep (Phase 2).
- Recurring-with-exceptions hardening + timezone golden-file matrix (Phase 2).
- Dashboard UI, billing, admin (Phases 3–5).

See the full phased plan for the roadmap and verification checklist.
