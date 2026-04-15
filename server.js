import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import handler from './api/data.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

function serveStatic(req, res) {
  const rel  = req.url === '/' ? '/index.html' : req.url;
  const file = path.join(__dirname, 'public', rel);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext  = path.extname(file);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// Adapt the Vercel-style handler (req, res) to Node's native http.ServerResponse
function makeRes(raw) {
  let statusCode = 200;
  const headers  = {};
  return {
    setHeader(k, v) { headers[k] = v; },
    status(code) {
      statusCode = code;
      return {
        json(body) {
          raw.writeHead(statusCode, { 'Content-Type': 'application/json', ...headers });
          raw.end(JSON.stringify(body));
        },
      };
    },
    json(body) {
      raw.writeHead(statusCode, { 'Content-Type': 'application/json', ...headers });
      raw.end(JSON.stringify(body));
    },
  };
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/api/data') {
    try {
      await handler(req, makeRes(res));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, () => console.log(`Listening on port ${PORT}`));
