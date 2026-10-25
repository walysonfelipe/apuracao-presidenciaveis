import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_URL, presidentialElection, municipalityCodes, resultUrl, summarize, EMPTY_FILL } from '../lib/tse.mjs';
import { createResults, loadOptions } from '../lib/results.mjs';

const election = { code: '6258', round: '2' };
const electionConfig = { pl: [{ c: 'ele2026', dt: '25/10/2026', e: [{ t: '2', cd: '6258', abr: [{ cd: 'br', cp: [{ cd: '1' }] }] }] }] };
const municipalConfig = { f: 'o', abr: [{ cd: 'sp', mu: [{ cdi: '3550308', cd: '71072' }, { cdi: '3509502', cd: '62910' }, { cdi: '3500001', cd: '00001' }] }] };
const sample = (uf, tse, overrides = {}) => ({
  ele: '6258', t: '2', f: 'o', tpabr: tse ? 'mu' : uf === 'br' ? 'br' : 'uf', cdabr: tse || uf,
  dg: '25/10/2026', hg: '18:00:00', and: 'p', s: { pst: '25,00' },
  v: { vv: '100', vb: '5', pvb: '4,50', tvn: '6', ptvn: '5,40' }, e: { te: '150', c: '111', pc: '74,00', a: '39', pa: '26,00' },
  carg: [{ cd: '1', agr: [{ par: [
    { sg: 'PT', cand: [{ n: '13', nmu: 'Candidato A', sqcand: '100', vap: '60' }] },
    { sg: 'PL', cand: [{ n: '22', nmu: 'Candidato B', sqcand: '200', vap: '40' }] },
  ] }] }], ...overrides,
});

function memoryStorage() {
  const objects = new Map();
  return { objects, async get(key) { return objects.has(key) ? structuredClone(objects.get(key)) : null; }, async put(key, value) { objects.set(key, structuredClone(value)); },
    async getBytes(key) { return objects.get(key) || null; }, async putBytes(key, bytes) { objects.set(key, bytes); } };
}

function harness({ storage = memoryStorage(), handle } = {}) {
  let time = 1_000_000;
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    const custom = await handle?.(url);
    if (custom) return custom;
    if (url === CONFIG_URL) return Response.json(electionConfig);
    if (url.includes('/config/mun-')) return Response.json(municipalConfig);
    const match = url.match(/\/([a-z]{2})(\d{5})?-c0001-e006258-u\.json$/);
    if (!match) return new Response('', { status: 404 });
    return Response.json(sample(match[1], match[2]));
  };
  const results = createResults({ fetchImpl, storage, now: () => time, wait: async (ms) => { time += ms; }, options: { ...loadOptions({}), concurrency: 2 } });
  return { results, requests, storage, advance: (ms) => { time += ms; } };
}

test('adaptador valida turno, ambiente e território e preserva zeros à esquerda', () => {
  assert.deepStrictEqual(presidentialElection(electionConfig, '2'), { code: '6258', round: '2', date: '25/10/2026' });
  assert.strictEqual(presidentialElection(electionConfig, '1'), null);
  assert.strictEqual(municipalityCodes(municipalConfig).sp['3500001'], '00001');
  assert.ok(resultUrl(election, 'sp', '00001').endsWith('/dados/sp/sp00001-c0001-e006258-u.json'));
  const result = summarize(sample('sp'), election, 'sp');
  assert.strictEqual(result.total, 100);
  assert.strictEqual(result.leader, '100');
  assert.strictEqual(result.counted, 25);
  assert.deepStrictEqual(result.votes, { valid: 100, blank: 5, blankPct: 4.5, null: 6, nullPct: 5.4 });
  assert.deepStrictEqual(result.abstention, { count: 39, pct: 26 });
  assert.strictEqual(result.electorate, 150);
  assert.match(result.fill, /^#[0-9a-f]{6}$/);
  for (const override of [{ f: 's' }, { t: '1' }, { ele: '6257' }, { tpabr: 'br' }, { cdabr: 'rj' }, { s: { pst: '101' } }]) {
    assert.throws(() => summarize(sample('sp', null, override), election, 'sp'));
  }
  const fractional = sample('sp');
  fractional.carg[0].agr[0].par[0].cand[0].vap = '1.5';
  assert.throws(() => summarize(fractional, election, 'sp'));
  const zero = sample('br');
  zero.carg[0].agr[0].par.forEach((party) => { party.cand[0].vap = '0'; });
  assert.strictEqual(summarize(zero, election, 'br').fill, EMPTY_FILL);
});

test('primeira consulta responde na hora e preenche o pedaço em segundo plano', async () => {
  const h = harness();
  const first = await h.results.scope('2', 'sp');
  assert.deepStrictEqual(first.payload.items, {});
  assert.ok(first.pending);
  await first.pending;
  const { payload } = await h.results.scope('2', 'sp');
  assert.deepStrictEqual(Object.keys(payload.items).sort(), ['3500001', '3509502', '3550308']);
  assert.strictEqual(payload.summary.result.total, 100);
  assert.strictEqual(payload.items['3550308'].result.candidates.length, 2);
  assert.strictEqual(payload.items['3550308'].result.abstention.count, 39);
  assert.ok(h.storage.objects.has('6258/2/sp.json'));
  assert.ok(h.storage.objects.has('config/municipios-6258.json'));
  const published = JSON.parse(h.storage.objects.get('publico/2/sp.json'));
  assert.deepStrictEqual(published.items, payload.items);
  assert.strictEqual(published.summary.result.total, 100);
  assert.ok(published.publishedAt);
});

test('visitantes simultâneos compartilham uma única atualização e o cache evita novas consultas', async () => {
  const h = harness();
  const calls = await Promise.all(Array.from({ length: 20 }, () => h.results.scope('2', 'br')));
  assert.strictEqual(calls.filter((call) => call.pending).length, 1);
  await Promise.all(calls.map((call) => call.pending));
  const resultRequests = () => h.requests.filter((url) => url.includes('/dados/')).length;
  assert.strictEqual(resultRequests(), 28);
  h.advance(10000);
  await (await h.results.scope('2', 'br')).pending;
  assert.strictEqual(resultRequests(), 28);
  h.advance(30000);
  await (await h.results.scope('2', 'br')).pending;
  assert.strictEqual(resultRequests(), 56);
});

test('nova instância reaproveita o pedaço salvo no R2', async () => {
  const storage = memoryStorage();
  const first = harness({ storage });
  await (await first.results.scope('2', 'sp')).pending;
  const second = harness({ storage });
  const { payload, pending } = await second.results.scope('2', 'sp');
  assert.strictEqual(Object.keys(payload.items).length, 3);
  await pending;
  assert.strictEqual(second.requests.filter((url) => url.includes('/dados/')).length, 0);
  assert.ok(!second.requests.some((url) => url.includes('/config/mun-')));
});

test('bloqueio do TSE pausa todas as consultas e mantém o último resultado', async () => {
  let blocked = false;
  const h = harness({ handle: (url) => blocked && url.includes('/dados/') ? new Response('', { status: 429 }) : null });
  await (await h.results.scope('2', 'br')).pending;
  blocked = true;
  h.advance(31000);
  await (await h.results.scope('2', 'br')).pending;
  const blockedRequests = h.requests.length;
  h.advance(31000);
  const { payload, pending } = await h.results.scope('2', 'br');
  assert.strictEqual(pending, null);
  assert.ok(payload.pausedUntil);
  assert.strictEqual(payload.summary.result.total, 100);
  assert.strictEqual(h.requests.length, blockedRequests);
});

test('falhas seguidas interrompem a varredura sem zerar votos', async () => {
  const h = harness({ handle: (url) => url.includes('/dados/sp/sp') && /sp\d{5}-/.test(url) ? new Response('', { status: 404 }) : null });
  await (await h.results.scope('2', 'sp')).pending;
  const { payload } = await h.results.scope('2', 'sp');
  assert.strictEqual(payload.summary.result.total, 100);
  assert.ok(Object.values(payload.items).every((entry) => entry.error === 'missing' && !entry.result));
  assert.ok(h.requests.filter((url) => /sp\d{5}-/.test(url)).length <= 3);
});

test('turno sem configuração e seleções inválidas são recusados', async () => {
  const h = harness();
  await assert.rejects(h.results.scope('1', 'br'), { status: 404 });
  await assert.rejects(h.results.scope('2', 'xx'), { status: 400 });
  await assert.rejects(h.results.scope('3', 'br'), { status: 400 });
});

test('fotos vêm do TSE uma vez, ficam no R2 e só para candidaturas conhecidas', async () => {
  const photo = new Uint8Array([0xff, 0xd8, 0xff]);
  const h = harness({ handle: (url) => url.includes('/fotos/br/') ? new Response(photo, { headers: { 'Content-Type': 'image/jpeg' } }) : null });
  await assert.rejects(h.results.photo('2', '100'), { status: 404 });
  assert.ok(!h.requests.some((url) => url.includes('/fotos/')));
  await (await h.results.scope('2', 'sp')).pending;
  const first = await h.results.photo('2', '100');
  await h.results.photo('2', '100');
  assert.deepStrictEqual([...first.bytes], [...photo]);
  assert.strictEqual(h.requests.filter((url) => url.endsWith('/6258/fotos/br/100.jpeg')).length, 1);
  assert.ok(h.storage.objects.has('fotos/6258/100.jpeg'));
  await assert.rejects(h.results.photo('2', '999'), { status: 404 });
  await assert.rejects(h.results.photo('2', '../x'), { status: 400 });
});

test('pré-carregamento traz todos os estados do R2 sem consultar resultados no TSE', async () => {
  const storage = memoryStorage();
  const first = harness({ storage });
  await (await first.results.scope('2', 'sp')).pending;
  let reads = 0;
  const counted = { ...storage, async get(key) { if (key.startsWith('6258/')) reads++; return storage.get(key); } };
  const second = harness({ storage: counted });
  await second.results.preload();
  // Round 1 is not configured in the fake TSE and is skipped; round 2 loads Brasil + 27 UFs.
  assert.strictEqual(reads, 28);
  assert.deepStrictEqual(second.requests, [CONFIG_URL]);
  const { payload } = await second.results.scope('2', 'sp');
  assert.strictEqual(Object.keys(payload.items).length, 3);
  assert.strictEqual(reads, 28);
});

test('mini workers aquecem Brasil e todos os estados em fatias pequenas', async () => {
  const h = harness();
  const rounds = await h.results.activeRounds();
  assert.deepStrictEqual(rounds, ['2']);
  let steps = 0;
  while (await h.results.work({ rounds, slice: 2, concurrency: 1 })) steps++;
  // Brasil + 27 UFs in slices of 2, one slice per UF without cities, SP state + 3 cities in two slices.
  assert.strictEqual(steps, 14 + 26 + 2);
  const results = h.requests.filter((url) => url.includes('/dados/'));
  assert.strictEqual(results.length, 28 + 27 + 3);
  assert.ok(results.slice(0, 28).every((url) => url.includes('/dados/br/') || /\/dados\/[a-z]{2}\/[a-z]{2}-c0001/.test(url)));
  await h.results.flush(true);
  assert.ok(h.storage.objects.has('6258/2/sp.json'));
  const { payload } = await h.results.scope('2', 'sp');
  assert.strictEqual(Object.keys(payload.items).length, 3);
  assert.strictEqual(await h.results.work({ rounds, slice: 2 }), false);
  h.advance(31000);
  assert.strictEqual(await h.results.work({ rounds, slice: 2 }), true);
});

test('rodízio dá uma fatia a cada estado antes de voltar ao mesmo', async () => {
  const big = { f: 'o', abr: ['sp', 'mg', 'ba'].map((uf, i) => ({ cd: uf, mu: Array.from({ length: 10 }, (_, j) => ({ cdi: String(3000000 + i * 100 + j), cd: String(i * 100 + j).padStart(5, '0') })) })) };
  const h = harness({ handle: (url) => url.includes('/config/mun-') ? Response.json(big) : null });
  const rounds = ['2'];
  const order = [];
  for (let step = 0; step < 80; step++) {
    const before = h.requests.length;
    await h.results.work({ rounds, slice: 3, concurrency: 1 });
    const urls = h.requests.slice(before).filter((url) => /\/dados\/(sp|mg|ba)\/(sp|mg|ba)\d{5}/.test(url));
    if (urls.length) order.push(urls[0].match(/\/dados\/([a-z]{2})\//)[1]);
  }
  // After the first slices (state + 2 cities) each big state keeps alternating with the others.
  assert.deepStrictEqual(order.slice(0, 6), ['ba', 'mg', 'sp', 'ba', 'mg', 'sp']);
});

test('resposta pronta é reaproveitada até os dados mudarem e vem enxuta', async () => {
  const h = harness();
  await (await h.results.scope('2', 'sp')).pending;
  const first = await h.results.scope('2', 'sp');
  const again = await h.results.scope('2', 'sp');
  assert.strictEqual(again.body, first.body);
  assert.strictEqual(again.etag, first.etag);
  const payload = JSON.parse(first.body);
  assert.deepStrictEqual(Object.keys(payload.candidates).sort(), ['100', '200']);
  assert.deepStrictEqual(payload.candidates['100'], { name: 'Candidato A', party: 'PT', number: '13', color: '#e5484d' });
  assert.deepStrictEqual(payload.items['3550308'].result.candidates[0], { id: '100', votes: 60, pct: 60 });
  assert.ok(!('name' in payload.items['3550308'].result.candidates[0]));
  h.advance(181000);
  await (await h.results.scope('2', 'sp')).pending;
  assert.notStrictEqual((await h.results.scope('2', 'sp')).etag, first.etag);
});
