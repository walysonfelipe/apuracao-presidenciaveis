# Repository Guidelines

## Project Structure & Module Organization

This is a single Next.js (App Router) app for the presidential race map only: Brasil, states and municipalities. `app/page.jsx` is the only page; `app/api/resultados/[turno]/[uf]/route.js` is the only API. `components/election-map.jsx` holds the client map. `lib/` holds server code: TSE parsing and validation (`tse.mjs`), the chunk cache and request budget (`results.mjs`) optional R2 persistence (`storage.mjs`) and background mini workers (`workers.mjs`, started by `instrumentation.js`). All TSE parsing belongs in `lib/`; the browser consumes only our API (or its copy published to the public R2 domain) and never queries TSE directly. Map geometries live in `public/data/mapa/`; docs in `docs/`; tests in `test/`.

## Build, Test, and Development Commands

Run `npm install`, then `npm run dev` and open `http://localhost:3000`. `npm run build` and `npm start` run production. `npm test` runs the Node test suite with local responses. No linter or formatter is configured.

## Coding Style & Naming Conventions

Use two spaces for indentation. Write JavaScript (`.jsx` for components, `.mjs` for `lib/`), no TypeScript. Keep CSS selectors lowercase and descriptive in `app/globals.css`. Treat TSE data as external input: validate it, keep the last good result on failure, and never turn failures into zero votes. Use Markdown with descriptive headings and relative links for documentation.

## Testing Guidelines

Place tests in `test/*.test.mjs` using `node:test`. Use local responses and fake storage for load and failure tests, without multiplying requests to the TSE.

## Commit & Pull Request Guidelines

Write concise, imperative commit subjects (for example, `Document map setup`). Pull requests should explain the change and its rationale, list relevant checks, and include screenshots when a change affects the visual interface.

## Security & Configuration

Do not commit credentials, tokens, or machine-specific configuration. Server settings, including R2 credentials, go in `.env.local` (see `.env.example`) and are never exposed to the client.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
