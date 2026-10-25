import { getResults } from '../../../../../lib/instance.mjs';

export const dynamic = 'force-dynamic';

const results = getResults();

export async function GET(_request, { params }) {
  const { turno, id } = await params;
  try {
    const { bytes, type } = await results.photo(turno, id);
    return new Response(bytes, { headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800' } });
  } catch (error) {
    return new Response(null, { status: error.status === 400 || error.status === 404 ? error.status : 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
