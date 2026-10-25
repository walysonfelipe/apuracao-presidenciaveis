import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../backend/config.mjs';
import { Store } from '../../backend/store.mjs';
import { Collector } from '../../backend/collector.mjs';
import { source, fetchJson, retryAfterMs } from '../../backend/source.mjs';

const election = { code: '6258', round: '2' };
const elections = { pl: [{ c: 'ele2026', e: [{ t: '2', cd: '6258', abr: [{ cd: 'br', cp: [{ cd: '1' }] }] }] }] };
const municipalities = { f: 'o', abr: [{ cd: 'sp', mu: [
  { cdi: '3550308', cd: '71072' }, { cdi: '3509502', cd: '62910' }, { cdi: '3500001', cd: '00001' },
] }] };
const sample = (scope = { uf: 'sp' }, overrides = {}) => ({
  ele: '6258', t: '2', f: 'o', tpabr: scope.tse ? 'mu' : scope.uf === 'br' ? 'br' : 'uf',
  cdabr: scope.tse || scope.uf, dg: '25/10/2026', hg: '18:00:00', idg: 'fixture', and: 'p', s: { pst: '25,00' },
  carg: [{ cd: '1', agr: [{ par: [
    { sg: 'PT', cand: [{ n: '13', nmu: 'Candidato A', sqcand: '100', vap: '60' }] },
    { sg: 'PL', cand: [{ n: '22', nmu: 'Candidato B', sqcand: '200', vap: '40' }] },
  ] }] }], ...overrides,
});

function harness(overrides = {}) {
  let time = 1000000;
  let handler = null;
  const now = () => time;
  const config = { ...loadConfig({ COLLECTOR_UF: 'sp', COLLECTOR_ROUND: '2', COLLECTOR_OFFICES: '1', COLLECTOR_RPS: '5', COLLECTOR_REGIONAL_INTERVAL_MS: '15000', COLLECTOR_MUNICIPAL_INTERVAL_MS: '180000', COLLECTOR_COMPLETE_INTERVAL_MS: '60000' }), concurrency: 1, ...overrides };
  const store = new Store(':memory:', { now });
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, at: time, signal: options.signal });
    if (handler) {
      const response = await handler(url, options);
      if (response) return response;
    }
    if (url === source.configUrl) return Response.json(elections);
    if (url.includes('/config/mun-')) return Response.json(municipalities);
    const match = url.match(/\/([a-z]{2})(\d{5})?-c0001-e\d+-u.json$/);
    if (!match) throw new Error(`URL inesperada: ${url}`);
    return Response.json(sample({ uf: match[1], tse: match[2] }));
  };
  const dependencies = { config, store, now, fetchImpl, wait: async (ms) => { time += ms; }, random: () => 0 };
  const collector = new Collector(dependencies);
  return { config, store, collector, requests, dependencies, now,
    advance: (ms) => { time += ms; }, handle: (fn) => { handler = fn; } };
}

test('configuração restringe a UF, turno, concorrência e orçamento de consultas', () => {
  expect(loadConfig({}).uf).toBe('all');
  for (const env of [{ COLLECTOR_UF: '../sp' }, { COLLECTOR_ROUND: '3' }, { COLLECTOR_RPS: '51' },
    { COLLECTOR_RPS: '0' }, { COLLECTOR_CONCURRENCY: '1.5' }, { COLLECTOR_DB: '' }]) {
    expect(() => loadConfig(env)).toThrow();
  }
});

test('adaptador exclusivo do backend valida Brasil, UF e município e preserva zeros', () => {
  for (const scope of [{ uf: 'br' }, { uf: 'sp' }, { uf: 'sp', tse: '00001' }]) {
    expect(source.summarize(sample(scope), election, scope).total).toBe(100);
  }
  expect(source.municipalities(municipalities, 'sp')[2].tse).toBe('00001');
  expect(source.resultUrl(election, { uf: 'sp', tse: '00001' })).toContain('sp00001-c0001');
  for (const override of [{ f: 's' }, { t: '1' }, { ele: '6257' }, { tpabr: 'br' }, { cdabr: 'rj' }, { s: { pst: '101' } }]) {
    expect(() => source.summarize(sample({ uf: 'sp' }, override), election, { uf: 'sp' })).toThrow();
  }
  const fractional = sample();
  fractional.carg[0].agr[0].par[0].cand[0].vap = '1.5';
  expect(() => source.summarize(fractional, election, { uf: 'sp' })).toThrow();
  expect(() => source.municipalities({ ...municipalities, f: 's' }, 'sp')).toThrow();
});

test('coleta Brasil, uma UF e todos os municípios com limite incluindo configurações', async () => {
  const h = harness();
  try {
    const status = await h.collector.runOnce();
    expect(status.coverage).toMatchObject({ configured: 5, available: 5, failed: 0 });
    expect(h.requests).toHaveLength(7);
    expect(h.requests[2].url).toContain('/br/br-');
    for (let i = 1; i < h.requests.length; i++) expect(h.requests[i].at - h.requests[i - 1].at).toBeGreaterThanOrEqual(200);
    await h.collector.runOnce();
    expect(h.requests).toHaveLength(7);
  } finally { h.store.close(); }
});

test('atualiza Brasil e UF durante uma varredura lenta sem abandonar municípios', async () => {
  const h = harness({ rps: 1, regionalIntervalMs: 1000 });
  try {
    const status = await h.collector.runOnce();
    expect(status.coverage.available).toBe(5);
    expect(h.requests.filter((request) => request.url.includes('/br/br-')).length).toBeGreaterThan(1);
  } finally { h.store.close(); }
});

test('resultados completos continuam sendo revisitados com menor frequência', async () => {
  const h = harness();
  h.handle((url) => url.includes('/br/br-') ? Response.json(sample({ uf: 'br' }, { and: 'f' })) : null);
  try {
    await h.collector.runOnce();
    h.advance(16000);
    await h.collector.runOnce();
    expect(h.requests.filter((request) => request.url.includes('/br/br-'))).toHaveLength(1);
    h.advance(60000);
    await h.collector.runOnce();
    expect(h.requests.filter((request) => request.url.includes('/br/br-'))).toHaveLength(2);
  } finally { h.store.close(); }
});

test('falha de validação preserva votos anteriores e não transforma falha em zero', async () => {
  const h = harness();
  try {
    await h.collector.runOnce();
    const key = `${h.collector.context}:br:-`;
    const original = h.store.record(key);
    h.advance(16000);
    h.handle((url) => url.includes('/br/br-') ? Response.json(sample({ uf: 'br' }, { t: '1' })) : null);
    await h.collector.runOnce();
    const after = h.store.record(key);
    expect(after.result).toEqual(original.result);
    expect(after.checked_at).toBe(original.checked_at);
    expect(after.error).not.toBeNull();
    expect(after.attempted_at).toBeGreaterThan(original.checked_at);
  } finally { h.store.close(); }
});

test('404 interrompe a varredura, espera um minuto e exige revalidar a configuração', async () => {
  const h = harness();
  h.handle((url) => url.includes('/br/br-') ? new Response('', { status: 404 }) : null);
  try {
    await h.collector.runOnce();
    expect(h.requests).toHaveLength(3);
    expect(h.store.getMeta(h.collector.configKey).expiresAt).toBe(0);
    h.advance(59999);
    await h.collector.runOnce();
    expect(h.requests).toHaveLength(3);
    h.advance(1);
    h.handle(() => null);
    await h.collector.runOnce();
    expect(h.requests[3].url).toBe(source.configUrl);
    expect(h.collector.status().coverage.available).toBe(5);
  } finally { h.store.close(); }
});

test('bloqueio 429 persiste ao recriar o coletor e respeita Retry-After maior que dez minutos', async () => {
  const h = harness();
  h.handle(() => new Response('', { status: 429, headers: { 'Retry-After': '1200' } }));
  try {
    await h.collector.runOnce();
    expect(h.collector.blockedUntil - h.now()).toBe(1200000);
    const restarted = new Collector(h.dependencies);
    h.advance(1199999);
    await restarted.runOnce();
    expect(h.requests).toHaveLength(1);
    expect(restarted.status().lastError).toBe('TSE: HTTP 429');
  } finally { h.store.close(); }
});

test('configuração ausente também respeita backoff progressivo', async () => {
  const h = harness();
  h.handle(() => { throw new Error('offline'); });
  try {
    await h.collector.runOnce();
    expect(h.collector.blockedUntil - h.now()).toBe(30000);
    h.advance(30000);
    await h.collector.runOnce();
    expect(h.collector.blockedUntil - h.now()).toBe(60000);
  } finally { h.store.close(); }
});

test('SQLite recupera resultados e agenda após fechar e reabrir, isolando turnos', () => {
  const directory = mkdtempSync(join(tmpdir(), 'apuracao-'));
  const path = join(directory, 'results.sqlite');
  let store;
  try {
    store = new Store(path, { now: () => 1000 });
    store.seed('oficial:ele2026:6258:2:1:sp', [{ uf: 'sp', kind: 'state' }]);
    store.success('oficial:ele2026:6258:2:1:sp:sp:-', { total: 100 }, 2000);
    store.setMeta('blocked-until', 600000);
    store.close();
    store = new Store(path, { now: () => 1000 });
    expect(store.record('oficial:ele2026:6258:2:1:sp:sp:-').result.total).toBe(100);
    expect(store.due('oficial:ele2026:6258:2:1:sp')).toHaveLength(0);
    expect(store.snapshot('oficial:ele2026:6257:1:1:sp').available).toBe(0);
    expect(store.getMeta('blocked-until')).toBe(600000);
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('lease impede dois coletores e permite retomada após expiração', () => {
  const directory = mkdtempSync(join(tmpdir(), 'apuracao-lease-'));
  let time = 0;
  const first = new Store(join(directory, 'results.sqlite'), { now: () => time });
  const second = new Store(join(directory, 'results.sqlite'), { now: () => time });
  try {
    first.claim();
    expect(() => second.claim()).toThrow('Outro coletor');
    time = 60001;
    second.claim();
    expect(() => first.claim()).toThrow('Outro coletor');
  } finally { first.close(); second.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('atualizar configuração remove abrangências retiradas da fila', () => {
  const store = new Store(':memory:');
  try {
    store.seed('context', [{ uf: 'sp' }, { uf: 'sp', tse: '00001' }]);
    store.seed('context', [{ uf: 'sp' }]);
    expect(store.due('context')).toHaveLength(1);
  } finally { store.close(); }
});

test('limita o corpo mesmo sem Content-Length e interpreta Retry-After como data HTTP', async () => {
  const response = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('x'.repeat(20)));
    controller.close();
  } }));
  await expect(fetchJson('https://example.test', { timeoutMs: 1000, maxBytes: 10, fetchImpl: async () => response })).rejects.toThrow('limite');
  expect(retryAfterMs('Sun, 25 Oct 2026 21:10:00 GMT', Date.parse('2026-10-25T21:00:00Z'))).toBe(600000);
});

test('respeita concorrência e bloqueio sem continuar iniciando novas consultas', async () => {
  const h = harness({ concurrency: 4 });
  let active = 0;
  let maximum = 0;
  h.handle(async (url) => {
    if (url.includes('/config/') || url === source.configUrl) return null;
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    return new Response('', { status: 403 });
  });
  try {
    await h.collector.runOnce();
    expect(maximum).toBeLessThanOrEqual(4);
    expect(h.requests.length).toBeLessThanOrEqual(6);
    const count = h.requests.length;
    h.advance(599999);
    await h.collector.runOnce();
    expect(h.requests.length).toBe(count);
  } finally { h.store.close(); }
});

test('timeout e encerramento abortam consultas em andamento', async () => {
  const untilAbort = async (_url, { signal }) => new Promise((_resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  await expect(fetchJson('https://example.test', { timeoutMs: 10, maxBytes: 100, fetchImpl: untilAbort })).rejects.toThrow('Tempo de consulta');
  const controller = new AbortController();
  const pending = fetchJson('https://example.test', { signal: controller.signal, timeoutMs: 1000, maxBytes: 100, fetchImpl: untilAbort });
  controller.abort(new Error('encerramento'));
  await expect(pending).rejects.toThrow('encerramento');
});

test('comando --once executa com SQLite real e retoma sem repetir consultas antes do prazo', () => {
  const directory = mkdtempSync(join(tmpdir(), 'apuracao-cli-'));
  const preload = join(directory, 'source-fixture.mjs');
  const database = join(directory, 'results.sqlite');
  writeFileSync(preload, `
    const elections = ${JSON.stringify(elections)};
    const municipalities = ${JSON.stringify(municipalities)};
    const base = ${JSON.stringify(sample())};
    globalThis.fetch = async (url) => {
      console.error('fixture-request');
      if (url.endsWith('/ele-c.json')) return Response.json(elections);
      if (url.includes('/config/mun-')) return Response.json(municipalities);
      const match = url.match(/\\/([a-z]{2})(\\d{5})?-c0001-e\\d+-u.json$/);
      if (!match) throw new Error('URL inesperada');
      return Response.json({ ...base, cdabr: match[2] || match[1], tpabr: match[2] ? 'mu' : match[1] === 'br' ? 'br' : 'uf' });
    };
  `);
  try {
    const command = [process.execPath, '--preload', preload, 'main.mjs', '--once'];
    const env = { PATH: process.env.PATH, COLLECTOR_DB: database, COLLECTOR_RPS: '50', COLLECTOR_UF: 'sp', COLLECTOR_ROUND: '2' };
    const first = Bun.spawnSync(command, { cwd: new URL('../../backend/', import.meta.url).pathname, env });
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout.toString()).coverage.available).toBe(5);
    expect(first.stderr.toString().match(/fixture-request/g)).toHaveLength(7);
    const second = Bun.spawnSync(command, { cwd: new URL('../../backend/', import.meta.url).pathname, env });
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.stdout.toString()).coverage.available).toBe(5);
    expect(second.stderr.toString()).not.toContain('fixture-request');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
