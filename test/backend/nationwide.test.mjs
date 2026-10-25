import { test, expect } from 'bun:test';
import { loadConfig, UFS } from '../../backend/config.mjs';
import { Store } from '../../backend/store.mjs';
import { Collector } from '../../backend/collector.mjs';
import { source } from '../../backend/source.mjs';
import { ResultsApi } from '../../backend/api.mjs';
import { Publisher } from '../../backend/publisher.mjs';

const office = (cd, ds, tp = '1') => ({ cd, ds, tp });
const federal = (cd, t) => ({ cd, t, tp: '8', abr: [{ cd: 'br', cp: [office('1', 'Presidente')] }] });
const configFile = { f: 'o', pl: [
  { c: 'ele2026', dt: '04/10/2026', e: [federal('6257', '1'), { cd: '6259', t: '1', tp: '1', abr: [{ cd: 'br', cp: [
    office('3', 'Governador'), office('5', 'Senador'), office('6', 'Deputado Federal', '2'), office('7', 'Deputado Estadual', '2'), office('8', 'Deputado Distrital', '2'),
  ] }] }, { cd: '6261', t: '1', tp: '3', abr: [{ cd: 'br', cp: [office('25', 'Conselheiro Distrital')] }] }] },
  { c: 'ele2026', dt: '25/10/2026', e: [federal('6258', '2'), { cd: '6260', t: '2', tp: '1', abr: ['sp', 'ac'].map((cd) => ({ cd, cp: [office('3', 'Governador')] })) }] },
] };

function mapping(count = 5568) {
  const ufs = [...UFS];
  let remaining = count - 1;
  let offset = 0;
  const abr = ufs.map((uf) => {
    const total = uf === 'df' ? 1 : Math.floor(remaining / (26 - offset++));
    if (uf !== 'df') remaining -= total;
    const ufIndex = ufs.indexOf(uf) + 10;
    return { cd: uf, mu: Array.from({ length: total }, (_, i) => ({ cdi: `${ufIndex}${String(i + 1).padStart(5, '0')}`, cd: String(i + 1).padStart(5, '0'), nm: `${uf} Município ${i + 1}` })) };
  });
  return { f: 'o', abr };
}

function resultFile(url, map) {
  const match = url.match(/\/([a-z]{2})(\d{5})?-c(\d{4})-e(\d+)-u.json$/);
  if (!match) throw new Error('URL inesperada');
  const [, uf, town, cargo, code] = match;
  const election = String(Number(code));
  const round = ['6258', '6260'].includes(election) ? '2' : '1';
  if (town && !map.abr.find((scope) => scope.cd === uf)?.mu.some((item) => item.cd === town)) throw new Error('Município fora da configuração');
  return { ele: election, t: round, f: 'o', cdabr: town || uf, tpabr: town ? 'mu' : uf === 'br' ? 'br' : 'uf', tf: 's', and: 'f', s: { pst: '100', st: '10', ts: '10' },
    carg: [{ cd: String(Number(cargo)), nv: '2', agr: [{ par: [{ sg: 'PT', cand: [{ n: '13', sqcand: '100', nmu: 'A', vap: '60', e: 's', st: 'Eleito' }, { n: '22', sqcand: '200', nmu: 'B', vap: '40', e: 'n' }] }] }] }], v: { vv: '100', tv: '100' } };
}

test('cobertura nacional: 5.568 municípios, 27 UFs, cargos e turnos sem combinações inexistentes', async () => {
  let time = 1000000;
  const now = () => time;
  const config = loadConfig({ COLLECTOR_RPS: '50', COLLECTOR_BATCH_SIZE: '10000', COLLECTOR_CONFIG_INTERVAL_MS: '86400000', COLLECTOR_COMPLETE_INTERVAL_MS: '86400000' });
  const map = mapping();
  const council = { f: 'o', abr: [{ cd: 'pe', mu: [map.abr.find((scope) => scope.cd === 'pe').mu[0]] }] };
  expect(map.abr.reduce((sum, scope) => sum + scope.mu.length, 0)).toBe(5568);
  const store = new Store(':memory:', { now });
  const requests = [];
  let active = 0;
  let maximum = 0;
  const fetchImpl = async (url) => {
    requests.push({ url, at: time }); active++; maximum = Math.max(maximum, active);
    try {
      await Promise.resolve();
      if (url === source.configUrl) return Response.json(configFile);
      if (url.includes('/config/mun-')) return Response.json(url.includes('/6261/') ? council : map);
      return Response.json(resultFile(url, url.includes('/6261/') ? council : map));
    } finally { active--; }
  };
  const collector = new Collector({ config, store, now, fetchImpl, wait: async (ms) => { time += ms; }, random: () => 0 });
  try {
    let status;
    for (let i = 0; i < 10; i++) {
      status = await collector.runOnce();
      if (status.coverage.available === status.coverage.configured) break;
    }
    expect(status.coverage.available).toBe(status.coverage.configured);
    expect(status.coverage.configured).toBeGreaterThan(33000);
    expect(status.coverage.municipalities).toBe(5568);
    expect(status.coverage.states).toBe(27);
    expect(status.contexts).toBe(167);
    expect(maximum).toBeLessThanOrEqual(config.concurrency);
    for (let i = 1; i < requests.length; i++) expect(requests[i].at - requests[i - 1].at).toBeGreaterThanOrEqual(20);
    const urls = requests.map((request) => request.url);
    expect(urls.filter((url) => /\/6257\/dados\/br\//.test(url))).toHaveLength(1);
    expect(urls.filter((url) => /\/6258\/dados\/br\//.test(url))).toHaveLength(1);
    expect(urls.filter((url) => /\/6257\/dados\/[a-z]{2}\/[a-z]{2}\d{5}-c0001/.test(url))).toHaveLength(5568);
    expect(urls.filter((url) => /\/6258\/dados\/[a-z]{2}\/[a-z]{2}\d{5}-c0001/.test(url))).toHaveLength(5568);
    expect(urls.some((url) => /\/df\/.*-c0007-/.test(url))).toBe(false);
    expect(urls.filter((url) => /-c0008-/.test(url)).every((url) => url.includes('/df/'))).toBe(true);
    expect(urls.filter((url) => url.includes('/6260/dados/')).every((url) => /\/dados\/(sp|ac)\//.test(url))).toBe(true);
    expect(urls.filter((url) => url.includes('/6261/dados/'))).toHaveLength(1);
    const api = new ResultsApi({ config, store, now });
    const get = (path) => api.respond(new Request(`https://api.example.test/${path}`));
    const catalog = await get('resultados/api/v1/config.json').json();
    expect(Object.keys(catalog.rounds['1'].offices['1'].scopes)).toHaveLength(28);
    expect(Object.keys(catalog.rounds['1'].offices['8'].scopes)).toEqual(['df']);
    expect(Object.keys(catalog.rounds['2'].offices['3'].scopes).sort()).toEqual(['ac', 'sp']);
    const national = await get(catalog.rounds['2'].offices['1'].scopes.br.manifestKey).json();
    const country = await get(national.datasets.brasil.key).json();
    expect(country.states).toHaveLength(27);
    const house = await get(catalog.rounds['1'].offices['6'].overviewKey).json();
    expect(house.coverage.available).toBe(27);
    expect(house.result.aggregate).toBe(true);
    expect(house.result.candidates).toHaveLength(54);
    const manifest = await get(catalog.rounds['1'].offices['6'].scopes.sp.manifestKey).json();
    const sp = await get(manifest.datasets.estado.key).json();
    expect(sp.result.office).toBe('6');
    expect(sp.result.partySeats[0].seats).toBe(1);
    expect(sp.municipalities.length).toBeGreaterThan(200);
    const code = map.abr.find((scope) => scope.cd === 'sp').mu[0].cdi;
    const detail = await get(`resultados/oficial/ele2026/6259/1/6/municipios/sp/${code}.json`).json();
    expect(detail.result.office).toBe('6');
    expect(detail.result.candidates).toHaveLength(2);
  } finally { collector.stop(); store.close(); }
}, 120000);

test('configuração de filtros permite limitar ensaios sem limitar o padrão nacional', () => {
  expect(loadConfig({}).uf).toBe('all');
  expect(loadConfig({}).round).toBe('all');
  expect(loadConfig({}).offices).toEqual(['all']);
  const filtered = source.discoverAll(configFile, loadConfig({ COLLECTOR_UF: 'sp', COLLECTOR_ROUND: '2', COLLECTOR_OFFICES: '3' }));
  expect(filtered).toHaveLength(1);
  const plans = source.plan(filtered[0], mapping(28), loadConfig({ COLLECTOR_UF: 'sp' }));
  expect(plans.map((plan) => plan.uf)).toEqual(['sp']);
  const district = source.discoverAll(configFile, loadConfig({ COLLECTOR_ROUND: '1', COLLECTOR_OFFICES: '8' }))[0];
  const df = source.plan(district, { abr: [{ cd: 'df', mu: [] }] }, loadConfig({}));
  expect(df.map((plan) => plan.uf)).toEqual(['df']);
  expect(df[0].scopes).toEqual([{ kind: 'state', uf: 'df' }]);
});

test('uma resposta inválida isolada não paralisa os demais cargos e territórios', async () => {
  let time = 1000000;
  const now = () => time;
  const config = loadConfig({ COLLECTOR_UF: 'sp', COLLECTOR_ROUND: '1', COLLECTOR_OFFICES: '1,3', COLLECTOR_BATCH_SIZE: '1000' });
  const map = mapping(28);
  const store = new Store(':memory:', { now });
  const collector = new Collector({ config, store, now, wait: async (ms) => { time += ms; }, fetchImpl: async (url) => {
    if (url === source.configUrl) return Response.json(configFile);
    if (url.includes('/config/mun-')) return Response.json(map);
    const data = resultFile(url, map);
    if (url.includes('/sp/sp-c0003-')) data.carg = [];
    return Response.json(data);
  } });
  try {
    const status = await collector.runOnce();
    expect(status.coverage.failed).toBe(1);
    expect(status.coverage.available).toBe(status.coverage.configured - 1);
    expect(status.blockedUntil).toBeNull();
  } finally { collector.stop(); store.close(); }
});

test('configuração municipal de uma eleição indisponível preserva as outras e pode recuperar', async () => {
  let time = 1000000;
  let missing = true;
  const now = () => time;
  const config = loadConfig({ COLLECTOR_UF: 'sp', COLLECTOR_ROUND: '1', COLLECTOR_OFFICES: '1,6', COLLECTOR_BATCH_SIZE: '1000' });
  const map = mapping(28);
  const store = new Store(':memory:', { now });
  const collector = new Collector({ config, store, now, wait: async (ms) => { time += ms; }, fetchImpl: async (url) => {
    if (url === source.configUrl) return Response.json(configFile);
    if (url.includes('/config/mun-')) return missing && url.includes('/6259/') ? new Response('{}', { status: 404 }) : Response.json(map);
    return Response.json(resultFile(url, map));
  } });
  try {
    const first = await collector.runOnce();
    expect(first.preparationErrors).toHaveLength(1);
    expect(first.coverage.available).toBe(first.coverage.configured);
    expect(collector.contexts.some((context) => context.includes(':6:'))).toBe(false);
    missing = false; time += 60000;
    const recovered = await collector.runOnce();
    expect(recovered.preparationErrors).toHaveLength(0);
    expect(collector.contexts.some((context) => context.includes(':6:'))).toBe(true);
  } finally { collector.stop(); store.close(); }
});

test('armazenamento comprime listas completas e exporta resumos municipais sem perder detalhes', () => {
  const store = new Store(':memory:');
  const context = 'oficial:ele2026:6259:1:6:sp';
  try {
    store.seed(context, [{ kind: 'municipality', uf: 'sp', ibge: '3550308', tse: '71072' }]);
    const key = `${context}:sp:71072`;
    const candidates = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), name: `Candidato ${i}`, party: 'PT', votes: i, pct: 0, color: '#e5484d' }));
    store.success(key, { total: 499500, candidates }, Date.now() + 60000);
    expect(store.db.query('SELECT typeof(result) AS type FROM results WHERE key = ?').get(key).type).toBe('blob');
    const compact = store.exportRecords(context, true)[0];
    expect(compact.result.candidates).toHaveLength(2);
    expect(compact.result.candidateCount).toBe(1000);
    expect(store.municipalityRecord(context, '3550308').result.candidates).toHaveLength(1000);
    store.db.query('UPDATE results SET result = ? WHERE key = ?').run(JSON.stringify({ total: 7, candidates: [] }), key);
    expect(store.record(key).result.total).toBe(7);
  } finally { store.close(); }
});

test('R2 publica catálogo nacional, manifestos de todas as UFs e painéis dos cargos', async () => {
  let time = 1000000;
  const now = () => time;
  const config = loadConfig({ COLLECTOR_BATCH_SIZE: '1000' });
  const map = mapping(28);
  const council = { abr: [{ cd: 'pe', mu: [map.abr.find((scope) => scope.cd === 'pe').mu[0]] }] };
  const store = new Store(':memory:', { now });
  const objects = new Map();
  let writes = 0;
  const storage = { putJson: async (key, value) => { objects.set(key, value); writes++; }, delete: async (key) => { objects.delete(key); } };
  const collector = new Collector({ config, store, now, wait: async (ms) => { time += ms; }, fetchImpl: async (url) => {
    if (url === source.configUrl) return Response.json(configFile);
    if (url.includes('/config/mun-')) return Response.json(url.includes('/6261/') ? council : map);
    return Response.json(resultFile(url, url.includes('/6261/') ? council : map));
  } });
  const publisher = new Publisher({ config: { accountId: '0'.repeat(32), bucket: 'eleicao', prefix: 'resultados', intervalMs: 15000, heartbeatMs: 60000, retentionMs: 86400000 }, store, storage, now });
  try {
    await collector.runOnce();
    for (const context of collector.contexts) expect((await publisher.tick(context, collector.status())).lastError).toBeNull();
    const catalog = JSON.parse(objects.get('resultados/api/v1/config.json'));
    expect(Object.keys(catalog.rounds['1'].offices['1'].scopes)).toHaveLength(28);
    expect(Object.keys(catalog.rounds['1'].offices['6'].scopes)).toHaveLength(27);
    expect(Object.keys(catalog.rounds['2'].offices['3'].scopes).sort()).toEqual(['ac', 'sp']);
    for (const round of Object.values(catalog.rounds)) for (const cargo of Object.values(round.offices)) {
      for (const selection of Object.values(cargo.scopes).flat()) {
        const manifest = JSON.parse(objects.get(selection.manifestKey));
        for (const descriptor of Object.values(manifest.datasets)) expect(objects.has(descriptor.key)).toBe(true);
      }
      if (cargo.overviewKey) expect(objects.has(cargo.overviewKey)).toBe(true);
    }
    const manifest = JSON.parse(objects.get(catalog.rounds['2'].offices['1'].scopes.br.manifestKey));
    expect(JSON.parse(objects.get(manifest.datasets.brasil.key)).states).toHaveLength(27);
    const house = JSON.parse(objects.get(catalog.rounds['1'].offices['7'].overviewKey));
    expect(house.coverage.available).toBe(27);
    expect(house.result.candidates.some((candidate) => candidate.uf === 'df')).toBe(true);
    const count = writes;
    for (const context of collector.contexts) await publisher.tick(context, collector.status());
    expect(writes).toBe(count);
  } finally { collector.stop(); store.close(); }
});
