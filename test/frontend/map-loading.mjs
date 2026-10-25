import http from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
const root = fileURLToPath(new URL('../../dist/frontend/', import.meta.url)).replace(/\/$/, '');
const profile = await mkdtemp(path.join(tmpdir(), 'corrida-map-qa-'));
let browser, socket, failUf = '', missingGzip = false, corruptGzip = false;
const requests = [];
const server = http.createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  requests.push(pathname);
  if (pathname.endsWith('.gz') && missingGzip) { res.writeHead(404); res.end(); return; }
  if (pathname.endsWith('.gz') && corruptGzip) { res.end('invalid'); return; }
  if (failUf && pathname.startsWith(`/data/mapa/${failUf}.json`)) { res.writeHead(503); res.end(); return; }
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
  for (let i = 0; i < 120; i++) { if (await evaluate(expression)) return; await delay(50); }
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
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text);
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, null);
  ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }, null));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setBlockedURLs', { urls: ['*fonts.googleapis.com*', '*fonts.gstatic.com*', '*resultados.tse.jus.br*'] });
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await wait("document.querySelectorAll('.territory').length === 27 && document.getElementById('map-message').hidden");
  await check("document.querySelectorAll('.territory-row').length === 0", 'Lista fechada não cria municípios no DOM');
  if (requests.filter(p => p === '/data/mapa/brasil.json.gz').length !== 1 || requests.includes('/data/mapa/brasil.json')) throw Error('Preload duplicado ou fallback inesperado');
  checks.push('Preload do Brasil aproveitado: um download compactado');
  await evaluate("document.querySelector('#territories [data-id=\"35\"]').dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}))");
  for (let i = 0; i < 100 && !requests.includes('/data/mapa/35.json.gz'); i++) await delay(20);
  if (!requests.includes('/data/mapa/35.json.gz')) throw Error('Hover não adiantou o download');
  await evaluate("document.querySelector('#territories [data-id=\"35\"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))");
  await wait("document.querySelectorAll('.municipality').length === 645 && document.getElementById('map-message').hidden");
  if (requests.filter(p => p === '/data/mapa/35.json.gz').length !== 1) throw Error('Prefetch e clique duplicaram o download');
  checks.push('Hover adianta download e clique reutiliza a mesma requisição');
  await evaluate("document.getElementById('home-button').click()");
  const ufIds = await evaluate("[...document.querySelectorAll('.territory')].map(p => p.dataset.id)");
  for (const id of ufIds) {
    await evaluate(`document.querySelector('#territories [data-id="${id}"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
    await wait("document.querySelectorAll('.municipality').length > 0 && document.getElementById('map-message').hidden");
    await check("document.querySelectorAll('.territory-row').length === 0", `UF ${id}: mapa pronto sem montar a lista oculta`);
    await evaluate("document.querySelector('.place-picker summary').click()");
    await wait("document.querySelectorAll('.municipality').length === document.querySelectorAll('.territory-row').length");
    await evaluate("document.getElementById('home-button').click()");
  }
  if (requests.some(p => /\/data\/mapa\/\d+\.json$/.test(p))) throw Error('Gzip não utilizado para as UFs');
  checks.push('Todas as 27 malhas compactadas abrem e correspondem à lista');
  const before = requests.length;
  await evaluate("document.querySelector('#territories [data-id=\"35\"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))");
  await wait("document.querySelectorAll('.municipality').length === 645");
  if (requests.length !== before) throw Error('Estado já visitado fez outro download');
  checks.push('Retorno ao estado usa cache sem novo download');
  await evaluate("document.querySelector('.place-picker summary').click()");
  await wait("document.querySelectorAll('.territory-row').length === 645");
  await evaluate("document.getElementById('territory-search').value='3550308'; document.getElementById('territory-search').dispatchEvent(new Event('input')); document.querySelector('.territory-row').click()");
  await check("document.querySelector('.is-selected')?.dataset.id === '3550308' && !document.getElementById('map-selection').hidden", 'Busca, seleção e zoom municipal preservados');
  await send('Page.reload');
  await wait("document.querySelector('.is-selected')?.dataset.id === '3550308'");
  checks.push('Link direto restaura estado e município');

  let legacyScript;
  for (const mode of ['missing', 'corrupt', 'legacy']) {
    missingGzip = mode === 'missing'; corruptGzip = mode === 'corrupt';
    if (mode === 'legacy') legacyScript = (await send('Page.addScriptToEvaluateOnNewDocument', { source: 'delete window.DecompressionStream' })).identifier;
    await send('Page.navigate', { url });
    await wait("document.querySelectorAll('.territory').length === 27 && document.getElementById('map-message').hidden");
    checks.push(`Fallback JSON: ${mode}`);
  }
  failUf = '12';
  await evaluate("document.querySelector('#territories [data-id=\"12\"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))");
  await wait("!document.getElementById('retry-button').hidden");
  failUf = '';
  await evaluate("document.getElementById('retry-button').click()");
  await wait("document.getElementById('state-crumb').textContent === 'Acre' && document.getElementById('map-message').hidden");
  checks.push('Repetir após falha remove promessa rejeitada do cache');
  for (const [width, height] of [[1440,900],[390,844],[320,568]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 700 });
    await check("document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight", `Tela ${width}: sem transbordamento`);
  }
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: legacyScript });
  if (process.argv.includes('--benchmark')) {
    await send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 200000, uploadThroughput: 100000 });
    await send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const measurements = {};
    for (const mode of ['gzip', 'json']) {
      let script;
      if (mode === 'json') script = (await send('Page.addScriptToEvaluateOnNewDocument', { source: 'delete window.DecompressionStream' })).identifier;
      measurements[mode] = [];
      for (let run = 0; run < 3; run++) {
        await send('Page.navigate', { url });
        await wait("document.querySelectorAll('.territory').length === 27 && document.getElementById('map-message').hidden");
        await evaluate("window.loadStarted=performance.now(); document.querySelector('#territories [data-id=\"35\"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))");
        await wait("document.querySelectorAll('.municipality').length === 645 && document.getElementById('map-message').hidden");
        measurements[mode].push(Math.round(await evaluate('performance.now()-window.loadStarted')));
      }
      if (script) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: script });
    }
    console.log(JSON.stringify({ network: '1.6 Mbps, 150 ms de latência, CPU 4× mais lenta, sem cache HTTP', milliseconds: measurements }, null, 2));
  }
  if (errors.length) throw Error(errors.join('; '));
  console.log(JSON.stringify({status:'PASS',checks},null,2));
} finally {
  socket?.close();
  browser?.kill();
  server.close();
  await delay(400);
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
