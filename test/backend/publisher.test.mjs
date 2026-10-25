import { test, expect } from 'bun:test';
import { Store } from '../../backend/store.mjs';
import { loadConfig } from '../../backend/config.mjs';
import { Publisher, buildPublication } from '../../backend/publisher.mjs';
import { R2Storage, createR2Client } from '../../backend/r2.mjs';

const context = 'oficial:ele2026:6258:2:1:sp';
const countryKey = `${context}:br:-`;
const municipalKey = `${context}:sp:71072`;
const r2 = {
  accountId: '0'.repeat(32), accessKeyId: 'test-only-access', secretAccessKey: 'test-only-secret',
  bucket: 'eleicao', prefix: 'resultados', publicBaseUrl: 'https://eleicoes.agendasalao.com',
  intervalMs: 1000, heartbeatMs: 10000, timeoutMs: 1000, retentionMs: 20000,
};

class MemoryStorage {
  objects = new Map();
  calls = [];
  hook = null;
  async putJson(key, body, immutable, signal) {
    signal?.throwIfAborted();
    this.calls.push({ type: 'put', key, body, immutable });
    await this.hook?.(key);
    this.objects.set(key, body);
  }
  async delete(key, signal) {
    signal?.throwIfAborted();
    this.calls.push({ type: 'delete', key });
    this.objects.delete(key);
  }
}

function harness() {
  let time = 1000000;
  const now = () => time;
  const store = new Store(':memory:', { now });
  const storage = new MemoryStorage();
  const publisher = new Publisher({ config: { ...r2 }, store, storage, now });
  store.seed(context, [
    { kind: 'country', uf: 'br' }, { kind: 'state', uf: 'sp' },
    { kind: 'municipality', uf: 'sp', tse: '71072', ibge: '3550308' },
  ]);
  for (const task of store.due(context)) store.success(task.key, { total: 100, generation: '25/10/2026 18:00:00', complete: false }, time + 15000);
  store.setMeta('configuration:2:sp', { election: { code: '6258', round: '2', date: '25/10/2026' } });
  const tick = (instance = publisher) => instance.tick(context, { coverage: store.snapshot(context), blockedUntil: store.getMeta('blocked-until') });
  const manifest = () => JSON.parse(storage.objects.get(publisher.status().manifestKey));
  return { store, storage, publisher, now, tick, manifest, advance: (ms) => { time += ms; } };
}

test('R2 é opt-in, exige credenciais e rejeita endpoint S3 como endereço público', () => {
  expect(loadConfig({}).r2).toBeNull();
  expect(() => loadConfig({ R2_ENABLED: 'true' })).toThrow();
  const env = { R2_ENABLED: 'true', R2_ACCOUNT_ID: r2.accountId,
    R2_ACCESS_KEY_ID: r2.accessKeyId, R2_SECRET_ACCESS_KEY: r2.secretAccessKey };
  expect(loadConfig(env).r2.bucket).toBe('eleicao');
  expect(loadConfig({ ...env, R2_PUBLIC_BASE_URL: r2.publicBaseUrl }).r2.publicBaseUrl).toBe(r2.publicBaseUrl);
  for (const extra of [{ R2_PUBLIC_BASE_URL: `https://${r2.accountId}.r2.cloudflarestorage.com` },
    { R2_PUBLIC_BASE_URL: 'https://user:password@example.test' }, { R2_PREFIX: '../private' },
    { R2_BUCKET: 'bad/bucket' }, { R2_TIMEOUT_MS: '60000' }]) {
    expect(() => loadConfig({ ...env, ...extra })).toThrow();
  }
});

test('versões dependem do conteúdo, mantendo consulta e erro no status separado', () => {
  const h = harness();
  try {
    const first = buildPublication(context, h.store.exportRecords(context), r2.prefix);
    h.advance(1000);
    const old = h.store.record(municipalKey);
    h.store.success(municipalKey, old.result, h.now() + 1000);
    h.store.failure(municipalKey, 'Fonte indisponível', h.now() + 1000);
    const second = buildPublication(context, h.store.exportRecords(context), r2.prefix);
    expect(second.revision).toBe(first.revision);
    expect(() => buildPublication('simulado:ele2026:6258:2:1:sp', h.store.exportRecords(context), r2.prefix)).toThrow();
  } finally { h.store.close(); }
});

test('publica dados e status antes do manifesto, com cobertura explícita de uma UF', async () => {
  const h = harness();
  try {
    await h.tick();
    expect(h.storage.calls).toHaveLength(5);
    expect(h.storage.calls.slice(0, 2).every((call) => call.immutable)).toBe(true);
    expect(h.storage.calls[2].key).toContain('/status/sp.json');
    expect(h.storage.calls[3].key).toContain('/manifestos/sp.json');
    const manifest = h.manifest();
    expect(manifest.coverage).toEqual({ type: 'uf', uf: 'sp', configured: 3, available: 3 });
    for (const descriptor of Object.values(manifest.datasets)) expect(h.storage.objects.has(descriptor.key)).toBe(true);
    expect(h.publisher.status().manifestUrl).toBe(`${r2.publicBaseUrl}/${h.publisher.status().manifestKey}`);
    const state = JSON.parse(h.storage.objects.get(manifest.datasets.estado.key));
    expect(state.municipalities[0].scope.ibge).toBe('3550308');
    expect(state.municipalities[0].result.total).toBe(100);
    expect(state).not.toHaveProperty('accessKeyId');
  } finally { h.store.close(); }
});

test('sem mudança não reenvia dados nem manifesto; heartbeat mostra consulta e falha', async () => {
  const h = harness();
  try {
    await h.tick();
    const originalRevision = h.manifest().revision;
    h.advance(1000);
    await h.tick();
    expect(h.storage.calls).toHaveLength(5);
    h.store.failure(municipalKey, 'Falha ao consultar a fonte.', h.now() + 30000);
    h.advance(10000);
    await h.tick();
    expect(h.storage.calls).toHaveLength(6);
    const statusCall = h.storage.calls.at(-1);
    expect(statusCall.key).toContain('/status/sp.json');
    const territory = JSON.parse(statusCall.body).territories.find((item) => item.scope.kind === 'municipality');
    expect(territory.availability).toBe('stale');
    expect(territory.checkedAt).toBeLessThan(territory.attemptedAt);
    expect(h.manifest().revision).toBe(originalRevision);
  } finally { h.store.close(); }
});

test('alteração municipal publica apenas o novo estado e o manifesto', async () => {
  const h = harness();
  try {
    await h.tick();
    const original = h.manifest();
    h.advance(1000);
    h.store.success(municipalKey, { total: 101 }, h.now() + 1000);
    await h.tick();
    expect(h.storage.calls).toHaveLength(7);
    expect(h.storage.calls[5].key).toContain('/estados/sp/');
    expect(h.manifest().datasets.brasil.key).toBe(original.datasets.brasil.key);
    expect(h.manifest().datasets.estado.key).not.toBe(original.datasets.estado.key);
  } finally { h.store.close(); }
});

test('upload incompleto mantém manifesto anterior e pode ser retomado', async () => {
  const h = harness();
  try {
    await h.tick();
    const original = h.storage.objects.get(h.publisher.status().manifestKey);
    h.advance(1000);
    h.store.success(municipalKey, { total: 102 }, h.now() + 1000);
    h.storage.hook = (key) => { if (key.includes('/estados/')) throw new Error('provider details must stay private'); };
    await h.tick();
    expect(h.storage.objects.get(h.publisher.status().manifestKey)).toBe(original);
    expect(h.publisher.status().lastError).not.toContain('provider details');
    expect(h.store.getMeta('blocked-until')).toBeNull();
    const count = h.storage.calls.length;
    h.advance(14999);
    await h.tick();
    expect(h.storage.calls).toHaveLength(count);
    h.advance(1);
    h.storage.hook = null;
    await h.tick();
    expect(h.storage.objects.get(h.publisher.status().manifestKey)).not.toBe(original);
    expect(h.publisher.status().lastError).toBeNull();
  } finally { h.store.close(); }
});

test('falha no manifesto retoma após recriar publicador sem reenviar arquivos imutáveis', async () => {
  const h = harness();
  try {
    h.storage.hook = (key) => { if (key.includes('/manifestos/')) throw new Error('unavailable'); };
    await h.tick();
    expect([...h.storage.objects.keys()].some((key) => key.includes('/manifestos/'))).toBe(false);
    const restarted = new Publisher({ config: r2, store: h.store, storage: h.storage, now: h.now });
    h.storage.hook = null;
    h.advance(15000);
    const count = h.storage.calls.filter((call) => call.immutable).length;
    await h.tick(restarted);
    expect(restarted.status().lastPublishedAt).not.toBeNull();
    expect(h.storage.calls.filter((call) => call.immutable)).toHaveLength(count);
  } finally { h.store.close(); }
});

test('retém arquivos atuais e só remove versões antigas registradas pelo publicador', async () => {
  const h = harness();
  h.publisher.config.retentionMs = 2000;
  try {
    h.storage.objects.set('foto.png', 'unrelated-file');
    await h.tick();
    const original = h.manifest();
    h.advance(3000);
    h.store.success(municipalKey, { total: 103 }, h.now() + 1000);
    await h.tick();
    expect(h.storage.objects.has(original.datasets.estado.key)).toBe(false);
    expect(h.storage.objects.has(original.datasets.brasil.key)).toBe(true);
    expect(h.storage.objects.has(h.manifest().datasets.estado.key)).toBe(true);
    expect(h.storage.objects.get('foto.png')).toBe('unrelated-file');
  } finally { h.store.close(); }
});

test('destinos diferentes possuem journal independente', async () => {
  const h = harness();
  try {
    await h.tick();
    const storage = new MemoryStorage();
    const other = new Publisher({ config: { ...r2, bucket: 'outro-bucket' }, store: h.store, storage, now: h.now });
    await other.tick(context, {}, undefined);
    expect(storage.calls).toHaveLength(5);
  } finally { h.store.close(); }
});

test('não publica conjunto sem resultados válidos nem executa dois ticks simultâneos', async () => {
  const h = harness();
  try {
    expect(await h.publisher.tick('oficial:ele2026:6257:1:1:sp', {}, undefined)).toMatchObject({ lastPublishedAt: null });
    expect(h.storage.calls).toHaveLength(0);
    let release;
    h.storage.hook = () => { h.storage.hook = null; return new Promise((resolve) => { release = resolve; }); };
    const pending = h.tick();
    await h.tick();
    expect(h.storage.calls).toHaveLength(1);
    release();
    await pending;
    expect(h.storage.calls).toHaveLength(5);
  } finally { h.store.close(); }
});

test('snapshot não muda durante uploads e coleta bloqueada continua publicando status', async () => {
  const h = harness();
  try {
    h.store.setMeta('blocked-until', h.now() + 600000);
    h.storage.hook = (key) => {
      if (key.includes('/brasil/')) h.store.success(municipalKey, { total: 999 }, h.now() + 1000);
    };
    await h.tick();
    let state = JSON.parse(h.storage.objects.get(h.manifest().datasets.estado.key));
    expect(state.municipalities[0].result.total).toBe(100);
    h.storage.hook = null;
    h.advance(1000);
    await h.tick();
    state = JSON.parse(h.storage.objects.get(h.manifest().datasets.estado.key));
    expect(state.municipalities[0].result.total).toBe(999);
    expect(h.store.getMeta('blocked-until')).toBeGreaterThan(h.now());
  } finally { h.store.close(); }
});

test('SDK recebe região auto, endpoint e cabeçalhos corretos sem URLs assinadas', async () => {
  const client = createR2Client(r2);
  try {
    expect(await client.config.region()).toBe('auto');
    expect((await client.config.endpoint()).hostname).toBe(`${r2.accountId}.r2.cloudflarestorage.com`);
  } finally { client.destroy(); }
  const calls = [];
  const storage = new R2Storage(r2, { send: async (command) => { calls.push(command); } });
  await storage.putJson('immutable.json', '{}', true);
  await storage.putJson('manifesto.json', '{}', false);
  await storage.delete('retired.json');
  expect(calls[0].input).toMatchObject({ Bucket: 'eleicao', ContentType: 'application/json; charset=utf-8', CacheControl: 'public, max-age=31536000, immutable' });
  expect(calls[1].input.CacheControl).toContain('s-maxage=5');
  expect(calls[2].input.Key).toBe('retired.json');
});

test('encerramento e timeout interrompem o transporte R2', async () => {
  const storage = new R2Storage({ ...r2, timeoutMs: 10 }, {
    send: async (_command, { abortSignal }) => new Promise((_resolve, reject) => {
      if (abortSignal.aborted) return reject(abortSignal.reason);
      abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
    }),
  });
  await expect(storage.putJson('test.json', '{}', true)).rejects.toThrow('Timeout');
  const controller = new AbortController();
  controller.abort(new Error('stopped'));
  await expect(storage.putJson('test.json', '{}', true, controller.signal)).rejects.toThrow('stopped');
});
