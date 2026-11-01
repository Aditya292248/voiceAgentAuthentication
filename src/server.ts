import { loadConfig } from './config.js';
import { readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { _logRequest, _logServerStarted } from './log.js';

// Validate config before anything else runs; a bad .env exits here with a readable message.
const config = loadConfig();

// package.json sits one level above both src/ (dev) and dist/ (build).
const { version } = z
  .object({ version: z.string() })
  .parse(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')));

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  // Path only: query strings may later carry tokens, and must stay out of logs.
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (req.method === 'GET' && path === '/health') {
    sendJson(res, 200, { ok: true, version });
  } else {
    sendJson(res, 404, { error: 'not_found' });
  }
  _logRequest(req.method ?? 'UNKNOWN', path, res.statusCode);
});

// Loopback only: nothing here is meant to be reachable from the network yet.
server.listen(config.port, '127.0.0.1', () => _logServerStarted(config.port, version));
