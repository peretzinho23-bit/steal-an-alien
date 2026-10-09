// Runs the dashboard on any machine or Node host: static files from public/ plus the same /api handler Vercel uses.
//   npm start        (reads web/.env or web/.env.local)
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServices } from './lib/context.js';
import { loadEnvFile } from './lib/env.js';
import { createHandler } from './lib/router.js';

const root = fileURLToPath(new URL('.', import.meta.url));
loadEnvFile(join(root, '.env.local'));
loadEnvFile(join(root, '.env'));

const PUBLIC = join(root, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

let services;
const api = createHandler(() => (services ??= createServices()));

function serveStatic(req, res, pathname) {
  // path traversal guard: the resolved file must stay inside public/
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  let file = join(PUBLIC, rel || 'index.html');
  if (!file.startsWith(PUBLIC + sep) && file !== PUBLIC) {
    res.statusCode = 403;
    return res.end('Forbidden');
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) {
    // single page app: unknown paths without a file extension get the shell
    if (extname(rel)) {
      res.statusCode = 404;
      return res.end('Not found');
    }
    file = join(PUBLIC, 'index.html');
  }
  res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  createReadStream(file).pipe(res);
}

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname.startsWith('/api/')) return api(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    return res.end('Method not allowed');
  }
  try {
    serveStatic(req, res, pathname);
  } catch (e) {
    console.error('static error:', e.message);
    res.statusCode = 400;
    res.end('Bad request');
  }
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => console.log(`Dashboard on http://localhost:${port}`));
