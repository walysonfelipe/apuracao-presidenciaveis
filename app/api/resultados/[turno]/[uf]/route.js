import { after } from 'next/server';
import { getResults } from '../../../../../lib/instance.mjs';

export const dynamic = 'force-dynamic';

const results = getResults();
// Browsers revalidate every poll (cheap 304 via ETag); a CDN in front shares one copy for 5 s and may serve it stale for 30 s while refreshing.
const CACHE = 'public, max-age=0, s-maxage=5, stale-while-revalidate=30';

export async function GET(request, { params }) {
  const { turno, uf } = await params;
  try {
    const { body, gzip, etag, pending } = await results.scope(turno, uf.toLowerCase());
    // Serverless hosts keep the function alive until the shared refresh finishes.
    if (pending) after(() => pending);
    const headers = { ETag: etag, 'Cache-Control': CACHE, Vary: 'Accept-Encoding' };
    if (request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers });
    const json = { ...headers, 'Content-Type': 'application/json; charset=utf-8' };
    if (/\bgzip\b/.test(request.headers.get('Accept-Encoding') || '')) return new Response(gzip, { headers: { ...json, 'Content-Encoding': 'gzip' } });
    return new Response(body, { headers: json });
  } catch (error) {
    const status = error.status === 400 || error.status === 404 ? error.status : 503;
    const message = status === 400 ? 'Seleção inválida.' : status === 404 ? 'Este turno ainda não está disponível.' : 'Não foi possível consultar o TSE agora.';
    return Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}
