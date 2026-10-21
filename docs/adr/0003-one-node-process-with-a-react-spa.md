# 0003. One Node.js process serving a React single-page app

- Status: Accepted (2026-10-21)
- Date: 2026-10-21
- Deciders: adricasi

## Context
One household, ≤ 3 devices, ~15 h of builder time plus agent sessions working in parallel. The UI needs provisional → Gemma odds swaps, bottom sheets, a stamp animation and polling. The repo is already scaffolded as strict TypeScript on Node.js (ESM, Vitest). Scheduled settlements must survive restarts (NFR-003).

## Options considered
1. **One Node process (Fastify) + React SPA built with Vite.** Server owns API, pairing, photos, scheduler loop and SQLite; the SPA is served as static files. Pros: one process to run, rich client, agents know React well, shared zod schemas between client and server. Cons: a build step, ~150 KB of JS.
2. **Same server, server-rendered HTML with htmx.** Pros: least JS, no client data layer. Cons: odds swaps, sheets and animations get fiddly; less reuse of the design components.
3. **Next.js full-stack.** Pros: one framework. Cons: heavier, background scheduler awkward outside a long-lived server, more surface for no local gain.

## Decision
We will run a single Fastify server on Node.js 24 (pinned: `.nvmrc`, `engines` `>=24 <25`, CI `node-version: 24`, so native modules don't break when `lts/*` moves) that serves a Vite-built React SPA and the JSON API, stores data in SQLite through better-sqlite3, and runs an in-process scheduler loop that reads due work from the database. Shared types and validation use zod.

## Consequences
- Positive: one command to start; the scheduler is stateless (state in SQLite), so restarts lose nothing; client and server share schemas.
- Negative / risks: better-sqlite3 is a native module (prebuilt binaries cover Linux x64; fallback is a local build); the SPA needs a CSP and no `dangerouslySetInnerHTML`.
- Follow-ups: dependency additions go through `npm audit` and are pinned in the lockfile.
