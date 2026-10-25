import { readdir, mkdir, copyFile, rm, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('./', import.meta.url));
const output = fileURLToPath(new URL('../dist/frontend/', import.meta.url));
const publicExtensions = new Set(['.html', '.css', '.js', '.json', '.gz', '.png', '.jpg', '.webp', '.ico', '.svg']);

async function copyPublicFiles(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const input = resolve(from, entry.name);
    const target = resolve(to, entry.name);
    if (entry.isDirectory() && entry.name === 'data') await copyData(input, target);
    else if (entry.isFile() && publicExtensions.has(extname(entry.name))) await copyFile(input, target);
  }
}

async function copyData(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const input = resolve(from, entry.name);
    const target = resolve(to, entry.name);
    if (entry.isDirectory()) await copyData(input, target);
    else if (entry.isFile() && publicExtensions.has(extname(entry.name))) await copyFile(input, target);
  }
}

export async function buildFrontend() {
  // Only public frontend assets enter the site.
  await rm(output, { recursive: true, force: true });
  await copyPublicFiles(source, output);
  if (process.env.FRONTEND_API_BASE_URL) {
    const base = new URL(process.env.FRONTEND_API_BASE_URL);
    if (base.username || base.password || base.search || base.hash || !['http:', 'https:'].includes(base.protocol)) throw new Error('FRONTEND_API_BASE_URL inválida.');
    const prefix = process.env.FRONTEND_DATA_PREFIX || 'resultados';
    if (!/^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/.test(prefix)) throw new Error('FRONTEND_DATA_PREFIX inválido.');
    await writeFile(resolve(output, 'api-config.js'), `window.AppConfig = Object.freeze(${JSON.stringify({ apiBaseUrl: base.href.replace(/\/$/, ''), dataPrefix: prefix })});\n`);
  }
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildFrontend();
  console.log('Frontend gerado em dist/frontend/');
}
