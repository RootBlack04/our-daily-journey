export const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, max-age=0',
  'x-content-type-options': 'nosniff',
};

function allowedOrigins() {
  return (Deno.env.get('APP_ORIGINS') ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

export function corsHeaders(request: Request): Headers | null {
  const origin = request.headers.get('origin');
  if (origin && !allowedOrigins().includes(origin)) return null;
  const headers = new Headers({
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'authorization, apikey, x-client-info, content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  });
  if (origin) headers.set('access-control-allow-origin', origin);
  return headers;
}

export function jsonResponse(request: Request, data: unknown, status = 200): Response {
  const cors = corsHeaders(request);
  if (!cors) return new Response(JSON.stringify({ error: 'Origin is not allowed.' }), { status: 403, headers: JSON_HEADERS });
  for (const [key, value] of Object.entries(JSON_HEADERS)) cors.set(key, value);
  return new Response(JSON.stringify(data), { status, headers: cors });
}

export function preflight(request: Request): Response {
  const cors = corsHeaders(request);
  if (!cors) return new Response(null, { status: 403, headers: JSON_HEADERS });
  for (const [key, value] of Object.entries(JSON_HEADERS)) cors.set(key, value);
  return new Response(null, { status: 204, headers: cors });
}

export async function readBody(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > 8192) throw new Error('Request is too large.');
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new Error('A JSON request is required.');
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 8192) throw new Error('Request is too large.');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('A valid JSON object is required.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A JSON object is required.');
  return value as Record<string, unknown>;
}

export function bearerToken(request: Request): string | null {
  const value = request.headers.get('authorization') ?? '';
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

export function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing server configuration: ${name}`);
  return value;
}
