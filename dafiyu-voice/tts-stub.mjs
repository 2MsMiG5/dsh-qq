import fs from 'node:fs';
import http from 'node:http';
const file = process.argv[2];
const wav = fs.readFileSync(file);
http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, engine: 'stub', voice: 'dafiyu' }));
    return;
  }
  if (req.method === 'POST' && req.url === '/tts') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      console.log('[stub] tts', body.slice(0, 160));
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length });
      res.end(wav);
    });
    return;
  }
  res.writeHead(404); res.end('not found');
}).listen(3210, '127.0.0.1', () => console.log('[stub] listening 3210'));
