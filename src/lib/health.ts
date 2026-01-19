import http from 'node:http';

export function startHealthServer(params: {
  port: number;
  getSnapshot: () => unknown;
  log?: (msg: string) => void;
}) {
  const port = Math.max(0, Math.floor(params.port));
  if (!port) return;

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/healthz') {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('ok');
      return;
    }
    if (url === '/metrics' || url === '/snapshot') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(params.getSnapshot()));
      return;
    }
    res.statusCode = 404;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('not found');
  });

  server.listen(port, () => {
    params.log?.(`health server listening on :${port}`);
  });
}

