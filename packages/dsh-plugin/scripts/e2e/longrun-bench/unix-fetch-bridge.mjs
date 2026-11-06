// Offline DSH integration bridge. Inside an empty network/PID namespace, only
// allow explicitly named mock routes via a Unix socket outside that namespace.
// No secret, real vendor URL, arbitrary proxying, redirects or fallback fetch.
import http from 'node:http';
import {Readable} from 'node:stream';

const socketPath = process.env.LONGRUN_MOCK_SOCKET;
if (!socketPath?.startsWith('/')) throw new Error('absolute LONGRUN_MOCK_SOCKET required');
const paths = new Set(['/r/main/w100000/v1/chat/completions', '/r/hist/w200000/v1/chat/completions']);
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== 'http://longrun.invalid' || !paths.has(url.pathname) || url.search ||
      request.method !== 'POST') throw new Error('longrun mock bridge: route denied');
  const raw = Buffer.from(await request.arrayBuffer());
  if (raw.length > 4_000_000) throw new Error('longrun mock bridge: body too large');
  if (request.signal.aborted) throw request.signal.reason;
  return await new Promise((resolve, reject) => {
    const req = http.request({socketPath, method: 'POST', path: url.pathname,
      headers: {'content-type': 'application/json', 'content-length': String(raw.length),
        'x-opencode-session': request.headers.get('x-opencode-session') ?? 'mock-smoke'}}, (res) => {
      const headers = new Headers();
      for (const [key,value] of Object.entries(res.headers)) {
        if (value !== undefined && !['connection','transfer-encoding'].includes(key))
          headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      resolve(new Response(Readable.toWeb(res), {status: res.statusCode, headers}));
    });
    req.on('error', reject);
    const abort = () => req.destroy(new Error('longrun mock bridge: request aborted'));
    request.signal.addEventListener('abort', abort, {once:true});
    req.once('close', () => request.signal.removeEventListener('abort', abort));
    req.end(raw);
  });
};
