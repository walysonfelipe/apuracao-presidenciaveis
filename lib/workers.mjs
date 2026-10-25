const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function integer(env, name, fallback, min, max) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} deve ser inteiro entre ${min} e ${max}.`);
  return value;
}

// Mini workers keep every state warm: each one repeatedly takes a small slice (WORKER_SLICE items)
// of the most overdue chunk. All of them share the global TSE request budget.
export function startWorkers(results, env = process.env) {
  const enabled = env.BACKGROUND_WORKERS ?? (env.NODE_ENV === 'production' ? 'true' : 'false');
  if (enabled !== 'true') return null;
  const count = integer(env, 'WORKERS', 4, 1, 16);
  const slice = integer(env, 'WORKER_SLICE', 40, 1, 1000);
  const mode = env.WORKER_ROUNDS || 'latest';
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      let worked = false;
      try {
        const rounds = await results.activeRounds(mode);
        worked = rounds.length ? await results.work({ rounds, slice }) : false;
        await results.flush();
      } catch {
        // Keep the loop alive; the next pass retries with the same budget and backoff.
      }
      if (!worked) await sleep(1000);
    }
  };
  const loops = Array.from({ length: count }, loop);
  const stop = async () => {
    stopped = true;
    await results.flush(true).catch(() => {});
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  console.log(JSON.stringify({ event: 'workers-started', workers: count, slice, rounds: mode }));
  return { stop, loops };
}
