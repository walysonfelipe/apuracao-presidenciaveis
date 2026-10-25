// Runs once when the Next.js server starts; background workers need a long-running `next start`.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { getResults } = await import('./lib/instance.mjs');
  const { startWorkers } = await import('./lib/workers.mjs');
  startWorkers(getResults());
}
