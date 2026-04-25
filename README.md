# Focus3

Anti-procrastination & life prioritization app. Helps neurodivergent and overwhelmed users surface the **three things that matter today** across seven life themes (work, fitness, finance, diet, medication, development, household, personal), with Google Calendar integration and printable weekly planner support.

This branch (`claude/focus3-app-setup-xohwm`) lays down the initial scaffold:

- **Frontend MVP** — Vite + React + TypeScript + Tailwind, localStorage-persisted task model, Tier 1–4 heuristic prioritization engine, Top Three dashboard, mode switch (Both/Work/Personal).
- **Backend stub** — Express + Anthropic SDK route at `POST /api/prioritize` that proxies to Claude when `ANTHROPIC_API_KEY` is set. Frontend currently uses its local heuristic; the backend is wired for the next iteration.
- **Roadmap (not yet built)** — Google Calendar OAuth, PDF planner generation, Tesseract OCR scan-to-app, recurrence engine, multi-user auth, deployment configs.

## Repo layout

```
.
├── frontend/            Vite + React + Tailwind app
│   ├── src/
│   │   ├── components/  TaskForm, TaskList, TopThree, ModeSwitch, ThemeBadge
│   │   ├── lib/         storage.ts, useTasks.ts, prioritize.ts
│   │   ├── types/       task.ts (single source of truth for Task shape)
│   │   ├── App.tsx
│   │   └── main.tsx
│   └── ...
├── backend/             Express + Anthropic SDK
│   └── src/
│       ├── server.ts
│       └── routes/prioritize.ts
└── package.json         npm workspaces root
```

## Getting started

```bash
# Install all workspaces
npm install

# Frontend (http://localhost:5173)
npm run dev:frontend

# Backend (http://localhost:8787) — optional; copy backend/.env.example → backend/.env first
npm run dev:backend
```

The frontend proxies `/api/*` to `http://localhost:8787` via Vite.

## Prioritization engine

`frontend/src/lib/prioritize.ts` implements the Tier 1–4 logic from the product spec:

1. **Tier 1 — Must do now.** Daily medication, deadlines ≤48h, critical urgency.
2. **Tier 2 — Moves you forward.** Tasks that unlock others, finance cutoffs ≤7d, fitness/learning consistency, deadlines ≤7d for >30 min tasks.
3. **Tier 3 — Balance.** Avoidance flagging when dodged ≥2 weeks and due <2 weeks.
4. **Tier 4 — Background.** Everything else.

After scoring, a theme-balance pass prevents three tasks from the same theme dominating the Top Three unless every other theme is empty.

The Claude-powered version (server-side) uses the same tier definitions and asks Claude to return strict JSON. Frontend will fall back to the local heuristic when the backend is unreachable.

## Privacy

- Tasks live in `localStorage` only by default (`focus3:tasks:v1`).
- `private` tasks must never appear in PDFs or shared views.
- `semi-private` tasks may appear in PDFs but should be redacted in the export step (not yet implemented).
- API keys live in `backend/.env` and are never sent to the client.
