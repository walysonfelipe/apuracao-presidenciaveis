import http from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { apiFixture } from '../fixtures/results-api.mjs';
const root = fileURLToPath(new URL('../../dist/frontend/', import.meta.url)).replace(/\/$/, '');
const profile = await mkdtemp(path.join(tmpdir(), 'corrida-api-qa-'));
let browser, socket;
let fixtureMode = 'normal';
const requests = [];
const municipalities = JSON.parse(await readFile(path.join(root, 'data/mapa/35.json'), 'utf8'));
const server = http.createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  requests.push(pathname);
  if (pathname.startsWith('/__api/')) {
    if (fixtureMode === 'failure') { res.writeHead(503); res.end('{}'); return; }
    const data = apiFixture(pathname.slice('/__api'.length), { ids: municipalities.map((item) => item.id), mode: fixtureMode });
    res.setHeader('Content-Type', 'application/json');
    if (!data) { res.writeHead(404); res.end('{}'); return; }
    res.end(JSON.stringify(data)); return;
  }
  try {
    const filename = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!filename.startsWith(root + '/')) throw Error();
    const body = await readFile(filename);
    res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webp': 'image/webp', '.ico': 'image/x-icon' }[path.extname(filename)] || 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const pending = new Map();
let nextId = 0, sessionId;
const errors = [], checks = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function send(method, params = {}, session = sessionId) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function wait(expression) {
  for (let i = 0; i < 300; i++) { if (await evaluate(expression)) return; await delay(50); }
  throw Error('Timed out: ' + expression);
}
async function check(expression, label) {
  if (!await evaluate(expression)) throw Error(label);
  checks.push(label);
}
try {
  browser = spawn(process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', 'about:blank'], { stdio: 'ignore' });
  let port;
  for (let i = 0; i < 100; i++) { try { port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch { await delay(100); } }
  if (!port) throw Error('Chrome did not launch');
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.json());
  socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve));
  socket.addEventListener('message', event => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
    if (msg.method === 'Network.requestWillBeSent' && /resultados(?:-sim)?\.tse\.jus\.br/.test(msg.params.request.url)) errors.push('Consulta direta ao TSE');
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text);
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, null);
  ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }, null));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setBlockedURLs', { urls: ['*fonts.googleapis.com*', '*fonts.gstatic.com*', '*tse.jus.br*', '*googletagmanager.com*'] });
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const target = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (target.hostname.endsWith('tse.jus.br')) throw Error('Frontend tentou consultar o TSE');
      return originalFetch(target.pathname.startsWith('/resultados/') ? '/__api' + target.pathname : input, init);
    };
  ` });
  await send('Emulation.setDeviceMetricsOverride', { width:1440,height:1100,deviceScaleFactor:1,mobile:false });
  await send('Page.navigate', { url });
  await wait("document.querySelectorAll('.territory').length === 27 && document.querySelectorAll('#election-candidates > span').length === 2");
  await check("document.querySelector('#territories [data-id=\"35\"]').style.getPropertyValue('--territory-fill') === '#4a5ee8'", 'Mapa usa a cor preparada pela API');
  await check("[...document.querySelectorAll('.territory')].filter((item) => item.style.getPropertyValue('--territory-fill') === '#4a5ee8').length === 27", 'Todas as 27 UFs recebem resultados da API');
  await evaluate("document.querySelector('#territories [data-id=\"35\"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))");
  await wait("document.querySelectorAll('.municipality').length === 645 && document.querySelector('.municipality').style.getPropertyValue('--territory-fill') === '#4a5ee8'");
  await evaluate("document.querySelector('.place-picker summary').click()");
  await wait("document.querySelectorAll('.territory-row').length === 645");
  await evaluate("document.getElementById('territory-search').value='3550308'; document.getElementById('territory-search').dispatchEvent(new Event('input')); document.querySelector('.territory-row').click()");
  await wait("document.getElementById('map-selection-result').textContent.includes('75,00%')");
  await check("document.getElementById('map-selection-result').textContent.includes('42,50%')", 'API distingue votos de seções totalizadas');
  if (requests.filter((request) => request.includes('/estados/sp/')).length !== 1) throw Error('Resumo estadual duplicado');
  checks.push('Um resumo da API atende os 645 municípios e reutiliza a versão em cache');
  await send('Emulation.setDeviceMetricsOverride', { width:390,height:844,deviceScaleFactor:1,mobile:true });
  await check("document.documentElement.scrollWidth <= innerWidth", 'Detalhe municipal cabe no celular');
  fixtureMode = 'failure';
  await wait("document.getElementById('map-selection-result').textContent.includes('Mostrando os últimos resultados disponíveis')");
  await check("document.querySelector('.is-selected').style.getPropertyValue('--territory-fill') === '#4a5ee8'", 'Falha da API preserva a última leitura');
  fixtureMode = 'normal';
  await evaluate("document.getElementById('election-round').value='1'; document.getElementById('election-round').dispatchEvent(new Event('change'))");
  await wait("document.getElementById('map-selection-result').textContent.includes('75,00%') && location.hash.includes('turno=1')");
  checks.push('Troca de turno consulta o contrato correspondente da API');
  for (const mode of ['zero', 'tie']) {
    fixtureMode = mode;
    await send('Page.navigate', { url });
    const fill = mode === 'zero' ? '#34465b' : '#7c899b';
    await wait(`document.querySelectorAll('#election-candidates > span').length === 2 && document.querySelector('#territories [data-id="35"]').style.getPropertyValue('--territory-fill') === '${fill}'`);
    checks.push(mode === 'zero' ? 'Zero votos mantém mapa neutro' : 'Empate usa a cor informada pelo backend');
  }
  await evaluate("Object.defineProperty(document,'hidden',{configurable:true,value:true}); document.dispatchEvent(new Event('visibilitychange'))");
  await wait("document.getElementById('election-status').textContent === 'As atualizações voltam quando você retornar.'");
  const pausedCount = requests.length;
  await delay(300);
  if (requests.length !== pausedCount) throw Error('Aba oculta continuou consultando');
  checks.push('Aba oculta pausa consultas');
  fixtureMode = 'normal';
  await send('Page.navigate', { url: url + '/estados.html?uf=sp&cargo=1&turno=2' });
  await wait("document.querySelectorAll('.candidate').length === 2");
  await check("document.getElementById('round-select').value === '2' && document.getElementById('candidates').textContent.includes('75,00%')", 'Resultados renderizam resumo normalizado da API');
  await send('Page.navigate', { url: url + '/estados.html?uf=sp&cargo=5&turno=2' });
  await wait("document.getElementById('message').textContent.includes('Os resultados desta seleção ainda não estão disponíveis')");
  checks.push('Cargo que não disputa o segundo turno não usa resultado de outro turno');
  await send('Page.navigate', { url: url + '/estados.html?uf=sp&cargo=6&turno=1' });
  await wait("document.querySelectorAll('.candidate').length === 2 && !document.getElementById('parliament').hidden");
  await check("document.getElementById('results-title').textContent.includes('Deputado Federal')", 'Deputados federais e vagas oficiais são exibidos');
  await evaluate("document.getElementById('uf-select').value='br'; document.getElementById('uf-select').dispatchEvent(new Event('change'))");
  await wait("document.querySelectorAll('.candidate').length === 54 && document.getElementById('status-text').textContent.includes('AGREGADO')");
  checks.push('Painel nacional de parlamentares reúne as UFs e identifica a agregação');
  await send('Page.navigate', { url: url + '/estados.html?uf=df&cargo=8&turno=1' });
  await wait("document.querySelectorAll('.candidate').length === 2 && document.getElementById('results-title').textContent.includes('Distrital')");
  checks.push('Deputado Distrital disponível no DF');
  await send('Page.navigate', { url: url + '/estados.html?uf=pe&cargo=25&turno=1' });
  await wait("document.getElementById('municipality-select')?.value === '2605459' && document.querySelectorAll('.candidate').length === 2");
  checks.push('Cargos municipais têm seleção da cidade anunciada pela API');
  await send('Page.navigate', { url: url + '/corrida.html' });
  await wait("document.querySelectorAll('.racer-row').length >= 2 && document.querySelector('#source-label').textContent.length > 0");
  await evaluate("(async () => { stopSimulation(); state.realtime = true; state.round = 2; await pollApiResults(); })()");
  await check("document.getElementById('source-label').textContent.includes('FONTE OFICIAL') && document.getElementById('standings').textContent.includes('75,0%')", 'Corrida renderiza os votos oficiais preparados pela API');
  if (errors.length) throw Error(errors.join('; '));
  console.log(JSON.stringify({ status: 'PASS', checks }, null, 2));
} finally {
  socket?.close(); browser?.kill(); server.close();
  await delay(400);
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
