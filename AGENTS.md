# Repository Guidelines

## Project Structure & Module Organization

The static browser game lives in `frontend/`, including pages, styles, browser scripts, images and geographic data. `backend/` contains the Bun collector, SQLite persistence, R2 publisher, server environment example, dependencies and Dockerfile. All TSE parsing and electoral rules belong exclusively to the backend; the frontend consumes normalized API data and never queries TSE directly. `docs/` holds architecture and concept documentation; tests are grouped under `test/frontend/` and `test/backend/`.

## Build, Test, and Development Commands

From the repository root, run `npm run dev:frontend` and open `http://localhost:8000`. `npm run build:frontend` copies public frontend files into `dist/frontend/`; serve and publish only that generated directory. Run `bun run install:backend` to install server dependencies, then `bun run collector` to collect real TSE data. Backend secrets belong in `backend/.env` or Render variables. Run `npm run test:frontend`, `bun run test:collector`, and `npm run test:browser` (requires Chrome) as appropriate. No linter is configured.

## Coding Style & Naming Conventions

Use two spaces for indentation in HTML, CSS, and JavaScript. Keep JavaScript browser-compatible and CSS selectors lowercase and descriptive. Treat TSE data as external input, handle unavailable files, and keep demo results visibly labeled. Use Markdown with descriptive headings and relative links for project documentation. No formatter or linter is configured.

## Testing Guidelines

Place browser/map checks in `test/frontend/` and collector/publisher checks in `test/backend/`. Use local responses for load and failure tests, without multiplying requests to the TSE. Document relevant commands and keep frontend and backend deploy paths consistent after moves.

## Commit & Pull Request Guidelines

Git history is not available in this checkout, so no established commit-message convention can be confirmed. Write concise, imperative commit subjects (for example, `Document game setup`). Pull requests should explain the change and its rationale, list relevant checks, and include screenshots when a change affects a visual interface. Link related issues when available.

## Security & Configuration

Do not commit credentials, tokens, or machine-specific configuration. If the project gains environment-based settings, provide a safe example file with placeholder values and document required variables without including secrets.
