import { resolve } from 'node:path';

export const UFS = new Set('ac al ap am ba ce df es go ma mt ms mg pa pb pr pe pi rj rn rs ro rr sc sp se to'.split(' '));

export function loadConfig(env = process.env) {
  function integer(name, fallback, min, max) {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${name} deve ser inteiro entre ${min} e ${max}.`);
    }
    return value;
  }
  const uf = (env.COLLECTOR_UF ?? 'all').toLowerCase();
  if (uf !== 'all' && !UFS.has(uf)) throw new Error('COLLECTOR_UF deve ser all ou uma UF brasileira.');
  const round = env.COLLECTOR_ROUND ?? 'all';
  if (!['all', '1', '2'].includes(round)) throw new Error('COLLECTOR_ROUND deve ser all, 1 ou 2.');
  const offices = (env.COLLECTOR_OFFICES ?? 'all').split(',').map((value) => value.trim());
  if (!(offices.length === 1 && offices[0] === 'all') && offices.some((value) => !/^[1-9]\d{0,3}$/.test(value))) throw new Error('COLLECTOR_OFFICES inválido.');
  if (env.COLLECTOR_DB === '') throw new Error('COLLECTOR_DB não pode ser vazio.');
  const r2Enabled = env.R2_ENABLED ?? 'false';
  if (!['true', 'false'].includes(r2Enabled)) throw new Error('R2_ENABLED deve ser true ou false.');
  let r2 = null;
  if (r2Enabled === 'true') {
    if (!/^[a-f0-9]{32}$/i.test(env.R2_ACCOUNT_ID ?? '')) throw new Error('Configure R2_ACCOUNT_ID.');
    if (!env.R2_ACCESS_KEY_ID?.trim() || !env.R2_SECRET_ACCESS_KEY?.trim()) throw new Error('Configure as credenciais R2 no servidor.');
    const bucket = env.R2_BUCKET ?? 'eleicao';
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('R2_BUCKET inválido.');
    const prefix = env.R2_PREFIX ?? 'resultados';
    if (!/^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/.test(prefix)) throw new Error('R2_PREFIX inválido.');
    let publicBaseUrl = null;
    if (env.R2_PUBLIC_BASE_URL) {
      let url;
      try { url = new URL(env.R2_PUBLIC_BASE_URL); } catch { throw new Error('R2_PUBLIC_BASE_URL inválida.'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.hostname.endsWith('.r2.cloudflarestorage.com')) {
        throw new Error('R2_PUBLIC_BASE_URL deve ser um endereço HTTPS público, sem credenciais ou parâmetros; não use o endpoint S3.');
      }
      publicBaseUrl = url.href.replace(/\/$/, '');
    }
    r2 = {
      accountId: env.R2_ACCOUNT_ID, bucket, prefix, publicBaseUrl,
      accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      intervalMs: integer('R2_PUBLISH_INTERVAL_MS', 15000, 1000, 86400000),
      heartbeatMs: integer('R2_HEARTBEAT_INTERVAL_MS', 60000, 1000, 86400000),
      timeoutMs: integer('R2_TIMEOUT_MS', 15000, 100, 30000),
      retentionMs: integer('R2_RETENTION_HOURS', 48, 1, 720) * 3600000,
    };
  }
  return {
    uf, round, cycle: 'ele2026', environment: 'oficial', office: offices.length === 1 ? offices[0] : 'all', offices, r2,
    apiOrigins: (env.API_ALLOWED_ORIGINS ?? 'http://localhost:8000,http://127.0.0.1:8000,https://corridaeleicao.vercel.app,https://eleicoes.agendasalao.com').split(',').map((value) => value.trim()).filter(Boolean),
    dbPath: resolve(env.COLLECTOR_DB ?? '.collector/results.sqlite'),
    rps: integer('COLLECTOR_RPS', 40, 1, 50),
    concurrency: integer('COLLECTOR_CONCURRENCY', 8, 1, 16),
    batchSize: integer('COLLECTOR_BATCH_SIZE', 500, 1, 10000),
    timeoutMs: integer('COLLECTOR_TIMEOUT_MS', 8000, 100, 60000),
    maxBytes: integer('COLLECTOR_MAX_BYTES', 5242880, 1024, 20971520),
    regionalIntervalMs: integer('COLLECTOR_REGIONAL_INTERVAL_MS', 30000, 1000, 86400000),
    municipalIntervalMs: integer('COLLECTOR_MUNICIPAL_INTERVAL_MS', 300000, 1000, 86400000),
    otherMunicipalIntervalMs: integer('COLLECTOR_OTHER_MUNICIPAL_INTERVAL_MS', 3600000, 1000, 86400000),
    completeIntervalMs: integer('COLLECTOR_COMPLETE_INTERVAL_MS', 600000, 1000, 86400000),
    configIntervalMs: integer('COLLECTOR_CONFIG_INTERVAL_MS', 300000, 1000, 86400000),
    port: integer('PORT', 3000, 1, 65535),
  };
}
