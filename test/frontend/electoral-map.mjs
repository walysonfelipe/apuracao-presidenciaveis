import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { apiFixture, result } from '../fixtures/results-api.mjs';

async function harness() {
  const calls = [];
  let mode = 'normal';
  let time = 1000000;
  let badContext = false;
  const window = { AppConfig: { apiBaseUrl: 'https://api.example.test', dataPrefix: 'resultados' }, setTimeout, clearTimeout };
  window.fetch = async (url) => {
    calls.push(url);
    if (mode === 'failure') return new Response('{}', { status: 503 });
    const data = apiFixture(new URL(url).pathname, { mode, now: time });
    if (badContext && data?.context) data.context.round = '1';
    return data ? Response.json(data) : new Response('{}', { status: 404 });
  };
  const sandbox = vm.createContext({ window, URL, AbortController, setTimeout, clearTimeout, Date });
  for (const file of ['api-client.js', 'results-loader.js']) vm.runInContext(await readFile(new URL(`../../frontend/${file}`, import.meta.url), 'utf8'), sandbox);
  return { window, calls, mode: (value) => { mode = value; }, advance: (ms) => { time += ms; }, wrongRound: () => { badContext = true; },
    client: new window.ResultsApiClient({ now: () => time }), now: () => time };
}

test('cliente consulta somente a API e reaproveita arquivos imutáveis', async () => {
  const h = await harness();
  const first = await h.client.scope('2', 'sp');
  assert.equal(first.entries[0].scope.ibge, '3550308');
  assert.equal(first.entries[0].result.fill, '#4a5ee8');
  const count = h.calls.length;
  await h.client.scope('2', 'sp');
  assert.equal(h.calls.length, count);
  h.advance(6000);
  await h.client.scope('2', 'sp');
  assert.equal(h.calls.filter((url) => url.includes('/estados/sp/')).length, 1);
  assert.ok(h.calls.every((url) => url.startsWith('https://api.example.test/resultados/')));
});

test('não troca turno ou UF indisponível por outro resultado', async () => {
  const h = await harness();
  await assert.rejects(h.client.scope('2', 'zz'));
  h.wrongRound();
  await assert.rejects(h.client.scope('2', 'sp'), /outra eleição/);
});

test('rejeita URLs fora da API e resultados malformados', async () => {
  const h = await harness();
  await assert.rejects(h.client.json('https://external.example.test/data.json'));
  assert.throws(() => h.client.result({ ...result(), total: -1 }));
  const payload = result(); payload.candidates[0].votes = NaN;
  assert.throws(() => h.client.result(payload));
});

test('mapa recebe um resumo da UF, preserva última leitura e pausa sem perder o receptor Window', async () => {
  const h = await harness();
  const scheduled = [];
  const loader = new h.window.ResultsMapLoader({ source: h.client, now: h.now, setTimer: (fn) => { scheduled.push(fn); return scheduled.length; }, clearTimer() {} });
  loader.setScope({ uf: 'SP', items: [{ id: '3550308' }], round: '2' });
  await loader.tick();
  assert.equal(loader.record('3550308').result.total, 100);
  h.mode('failure'); h.advance(6000);
  await loader.tick();
  assert.equal(loader.record('3550308').result.total, 100);
  assert.ok(loader.snapshot().stale);
  loader.setPaused(true);
  const count = h.calls.length;
  await loader.tick();
  assert.equal(h.calls.length, count);
  loader.setScope({ uf: 'sp', items: [{ id: '3550308' }], round: '1' });
  assert.equal(loader.record('3550308'), undefined);
});

test('empate, ausência de votos e cor são fornecidos pela API sem regra eleitoral no frontend', async () => {
  const h = await harness();
  h.mode('tie');
  let payload = await h.client.scope('2', 'sp');
  assert.equal(payload.result.result.fill, '#7c899b');
  assert.equal(payload.result.result.tied, true);
  h.advance(6000); h.mode('zero');
  payload = await h.client.scope('2', 'sp');
  assert.equal(payload.result.result.fill, '#34465b');
  assert.equal(payload.result.result.total, 0);
});

test('páginas não contêm consultas, fotos ou adaptadores diretos do TSE', async () => {
  for (const name of ['game.js', 'estados.js', 'api-client.js', 'results-loader.js', 'index.html', 'corrida.html', 'estados.html']) {
    const content = await readFile(new URL(`../../frontend/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(content, /https:\/\/resultados(?:-sim)?\.tse\.jus\.br|shared\/|TseMapLoader|TseData/);
  }
});

test('cargos, DF, segundo turno e painéis nacionais seguem o catálogo da API', async () => {
  const h = await harness();
  const federal = await h.client.scope('1', 'sp', undefined, '6');
  assert.equal(federal.context.office, '6');
  assert.equal(federal.result.result.partySeats[0].seats, 1);
  await assert.rejects(h.client.scope('1', 'sp', undefined, '8'));
  assert.equal((await h.client.scope('1', 'df', undefined, '8')).context.office, '8');
  await assert.rejects(h.client.scope('2', 'rj', undefined, '3'));
  const national = await h.client.scope('1', 'br', undefined, '6');
  assert.equal(national.result.result.aggregate, true);
  assert.equal(national.result.result.candidates.length, 54);
  const council = await h.client.scope('1', 'pe', undefined, '25', '2605459');
  assert.equal(council.result.scope.ibge, '2605459');
});
