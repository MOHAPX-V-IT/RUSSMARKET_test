import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 4180);
const base = process.env.BASE_PATH ? `/${process.env.BASE_PATH.replace(/^\/+|\/+$/g, '')}` : '';
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8',
};
const server = createServer(async (request, response) => {
  try {
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    let pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (base && pathname === base) {
      response.writeHead(302, { Location: `${base}/` }).end();
      return;
    }
    if (base && !pathname.startsWith(`${base}/`)) {
      response.writeHead(404).end('Not found');
      return;
    }
    pathname = pathname.slice(base.length);
    const filename = resolve(root, `.${pathname.endsWith('/') ? `${pathname}index.html` : pathname}`);
    if (!filename.startsWith(root + sep) || pathname.split(/[\\/]/).some(part => part.startsWith('.') && part !== '.nojekyll')) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    if (!(await stat(filename)).isFile()) throw new Error('Not a file');
    const body = await readFile(filename);
    response.writeHead(200, {
      'Content-Type': types[extname(filename)] || 'application/octet-stream',
      'Content-Length': body.byteLength,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch (error) {
    response.writeHead(error instanceof URIError ? 400 : 404).end('Not found');
  }
});
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `Порт ${port} занят. Задайте другой PORT.` : error.message);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => console.log(`Support Brief: http://127.0.0.1:${port}${base}/`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
