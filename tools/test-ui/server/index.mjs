import { spawn } from 'node:child_process';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');
const webDistDir = path.join(__dirname, '..', 'web', 'dist');

const PORT = Number(process.env.TEST_UI_API_PORT ?? 8787);
const runs = new Map();
const sseClients = new Set();

const toJson = (status, data) => ({ status, body: JSON.stringify(data) });

const parseRequestBody = async (req) =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (data.length > 2_000_000) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });

const runSummary = (run) => ({
  id: run.id,
  suite: run.suite,
  status: run.status,
  startedAt: run.startedAt,
  endedAt: run.endedAt,
  exitCode: run.exitCode,
  durationMs: run.endedAt ? Date.parse(run.endedAt) - Date.parse(run.startedAt) : undefined,
  targetOrg: run.targetOrg,
});

const sortedRunSummaries = () =>
  [...runs.values()]
    .map(runSummary)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));

const broadcast = (payload) => {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    client.write(data);
  }
};

const buildCommand = ({ suite, targetOrg, devHubAlias, scratchDurationDays, keepOrg }) => {
  if (suite === 'e2e-local') {
    return {
      command: 'npm run test:e2e:local',
      env: {},
    };
  }

  if (suite === 'e2e-org') {
    const env = {
      RUN_E2E_ORG: 'true',
    };
    if (targetOrg) env.E2E_TARGET_ORG = String(targetOrg);
    if (devHubAlias) env.DEV_HUB_ALIAS = String(devHubAlias);
    if (scratchDurationDays) env.SCRATCH_DURATION_DAYS = String(scratchDurationDays);
    if (keepOrg) env.E2E_KEEP_ORG = 'true';

    return {
      command: 'npm run test:e2e:org',
      env,
    };
  }

  throw new Error(`Unsupported suite: ${suite}`);
};

const startRun = ({ suite, targetOrg, devHubAlias, scratchDurationDays, keepOrg }) => {
  const id = randomUUID();
  const now = new Date().toISOString();
  const run = {
    id,
    suite,
    targetOrg: targetOrg ?? null,
    status: 'running',
    startedAt: now,
    endedAt: null,
    exitCode: null,
    logs: '',
    child: null,
    cancelRequested: false,
  };
  runs.set(id, run);
  broadcast({ type: 'created', run: runSummary(run) });

  const command = buildCommand({ suite, targetOrg, devHubAlias, scratchDurationDays, keepOrg });
  const spawnArgs =
    process.platform === 'win32'
      ? ['/d', '/s', '/c', command.command]
      : ['-lc', command.command];
  const child = spawn(process.platform === 'win32' ? 'cmd.exe' : 'bash', spawnArgs, {
    cwd: repoRoot,
    shell: false,
    env: {
      ...process.env,
      ...command.env,
      FORCE_COLOR: '0',
    },
  });
  run.child = child;

  const appendLog = (chunk) => {
    const text = chunk.toString('utf8');
    run.logs += text;
    if (run.logs.length > 2_000_000) {
      run.logs = run.logs.slice(-2_000_000);
    }
    broadcast({ type: 'log', runId: run.id, chunk: text });
  };

  child.stdout.on('data', appendLog);
  child.stderr.on('data', appendLog);

  child.on('close', (code) => {
    if (run.cancelRequested) {
      run.status = 'canceled';
      run.exitCode = null;
      run.endedAt = new Date().toISOString();
      run.child = null;
      broadcast({ type: 'updated', run: runSummary(run) });
      return;
    }
    run.status = code === 0 ? 'passed' : 'failed';
    run.exitCode = code ?? null;
    run.endedAt = new Date().toISOString();
    run.child = null;
    broadcast({ type: 'updated', run: runSummary(run) });
  });

  child.on('error', (error) => {
    if (run.cancelRequested) {
      run.status = 'canceled';
      run.exitCode = null;
      run.logs += '\n[runner-info] run canceled\n';
      run.endedAt = new Date().toISOString();
      run.child = null;
      broadcast({ type: 'updated', run: runSummary(run) });
      return;
    }
    run.status = 'failed';
    run.exitCode = -1;
    run.logs += `\n[runner-error] ${error.message}\n`;
    run.endedAt = new Date().toISOString();
    run.child = null;
    broadcast({ type: 'updated', run: runSummary(run) });
  });

  return run;
};

const cancelRun = (run) =>
  new Promise((resolve) => {
    if (!run || run.status !== 'running' || !run.child || !run.child.pid) {
      resolve(false);
      return;
    }

    run.cancelRequested = true;
    run.logs += '\n[runner-info] cancel requested by user\n';
    broadcast({ type: 'updated', run: runSummary(run) });

    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(run.child.pid), '/T', '/F'], {
        shell: false,
      });
      killer.on('close', () => resolve(true));
      killer.on('error', () => {
        try {
          run.child.kill('SIGTERM');
        } catch {
          // no-op
        }
        resolve(true);
      });
      return;
    }

    try {
      run.child.kill('SIGTERM');
      setTimeout(() => {
        if (run.status === 'running') {
          try {
            run.child?.kill('SIGKILL');
          } catch {
            // no-op
          }
        }
      }, 2000);
      resolve(true);
    } catch {
      resolve(false);
    }
  });

const send = (res, response, contentType = 'application/json') => {
  res.writeHead(response.status, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(response.body);
};

const notFound = (res) => send(res, toJson(404, { error: 'Not found' }));

const serveStatic = async (req, res) => {
  const pathname = req.url === '/' ? '/index.html' : req.url;
  const normalized = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(webDistDir, normalized);

  if (!filePath.startsWith(webDistDir)) {
    notFound(res);
    return;
  }

  const fallbackPath = path.join(webDistDir, 'index.html');
  const selectedPath = existsSync(filePath) ? filePath : fallbackPath;
  const content = await readFile(selectedPath);
  const type = selectedPath.endsWith('.html')
    ? 'text/html; charset=utf-8'
    : selectedPath.endsWith('.js')
      ? 'text/javascript; charset=utf-8'
      : selectedPath.endsWith('.css')
        ? 'text/css; charset=utf-8'
        : 'application/octet-stream';

  send(res, { status: 200, body: content }, type);
};

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    notFound(res);
    return;
  }

  if (req.method === 'OPTIONS') {
    send(res, { status: 204, body: '' });
    return;
  }

  if (req.url === '/api/health' && req.method === 'GET') {
    send(res, toJson(200, { ok: true }));
    return;
  }

  if (req.url === '/api/runs' && req.method === 'GET') {
    send(res, toJson(200, sortedRunSummaries()));
    return;
  }

  if (req.url === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`data: ${JSON.stringify({ type: 'snapshot', runs: sortedRunSummaries() })}\n\n`);
    sseClients.add(res);
    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  if (req.url === '/api/runs' && req.method === 'POST') {
    try {
      const body = await parseRequestBody(req);
      const suite = body?.suite;
      if (!suite || (suite !== 'e2e-local' && suite !== 'e2e-org')) {
        send(res, toJson(400, { error: 'suite must be e2e-local or e2e-org' }));
        return;
      }

      const run = startRun({
        suite,
        targetOrg: body.targetOrg,
        devHubAlias: body.devHubAlias,
        scratchDurationDays: body.scratchDurationDays,
        keepOrg: body.keepOrg,
      });
      send(res, toJson(201, runSummary(run)));
    } catch (error) {
      send(res, toJson(400, { error: error instanceof Error ? error.message : 'Invalid payload' }));
    }
    return;
  }

  const runDetailsMatch = req.url.match(/^\/api\/runs\/([^/]+)$/);
  if (runDetailsMatch && req.method === 'GET') {
    const id = runDetailsMatch[1];
    const run = runs.get(id);
    if (!run) {
      notFound(res);
      return;
    }
    send(res, toJson(200, { ...runSummary(run), logs: run.logs }));
    return;
  }

  const runCancelMatch = req.url.match(/^\/api\/runs\/([^/]+)\/cancel$/);
  if (runCancelMatch && req.method === 'POST') {
    const id = runCancelMatch[1];
    const run = runs.get(id);
    if (!run) {
      notFound(res);
      return;
    }
    if (run.status !== 'running') {
      send(res, toJson(409, { error: `run is ${run.status}, cannot cancel` }));
      return;
    }
    const canceled = await cancelRun(run);
    if (!canceled) {
      send(res, toJson(500, { error: 'failed to cancel run' }));
      return;
    }
    send(res, toJson(202, runSummary(run)));
    return;
  }

  if (existsSync(webDistDir)) {
    await serveStatic(req, res);
    return;
  }

  notFound(res);
});

server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    // eslint-disable-next-line no-console
    console.error(`test-ui api port ${PORT} is already in use. Set TEST_UI_API_PORT to another value.`);
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`test-ui api listening on http://localhost:${PORT}`);
});
