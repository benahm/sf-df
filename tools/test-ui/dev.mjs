import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = [];
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string'));
let shuttingDown = false;

const start = (name, command, args, cwd, extraEnv = {}) => {
  const child = spawn(command, args, {
    cwd,
    env: { ...cleanEnv, ...extraEnv },
    shell: process.platform === 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  child.on('exit', (code) => {
    if (code !== 0) {
      process.stderr.write(`[${name}] exited with code ${String(code)}\n`);
    }
  });

  children.push(child);
  return child;
};

const stopAll = () => {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) {
      if (process.platform === 'win32' && child.pid) {
        // Kill the full process tree so Vite/Node children don't stay alive.
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } else {
        child.kill('SIGTERM');
      }
    }
  }
};

process.on('SIGINT', () => {
  stopAll();
  setTimeout(() => process.exit(0), 150);
});

process.on('SIGTERM', () => {
  stopAll();
  setTimeout(() => process.exit(0), 150);
});

process.on('exit', () => {
  stopAll();
});

process.on('uncaughtException', (error) => {
  process.stderr.write(`[launcher] uncaught exception: ${error.message}\n`);
  stopAll();
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  process.stderr.write(`[launcher] unhandled rejection: ${String(error)}\n`);
  stopAll();
  process.exit(1);
});

const nodeCmd = process.execPath;
const webRoot = path.join(repoRoot, 'tools', 'test-ui', 'web');
const viteBin = process.platform === 'win32'
  ? path.join(webRoot, 'node_modules', '.bin', 'vite.cmd')
  : path.join(webRoot, 'node_modules', '.bin', 'vite');

if (!existsSync(viteBin)) {
  process.stdout.write('[setup] Installing web dependencies...\n');
  const install = spawnSync(
    npmCmd,
    ['--prefix', path.join('tools', 'test-ui', 'web'), 'install'],
    {
      cwd: repoRoot,
      env: cleanEnv,
      shell: process.platform === 'win32',
      stdio: 'inherit',
    }
  );

  if (install.status !== 0) {
    process.stderr.write(`[setup] install failed with code ${String(install.status)}\n`);
    process.exit(1);
  }
}

const findAvailablePort = async (startPort) => {
  let port = startPort;
  while (port < startPort + 50) {
    // eslint-disable-next-line no-await-in-loop
    const isFree = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => {
        probe.close(() => resolve(true));
      });
      probe.listen(port, '127.0.0.1');
    });
    if (isFree) return port;
    port += 1;
  }
  throw new Error(`No free API port found in range ${startPort}-${startPort + 49}`);
};

const apiPort = await findAvailablePort(Number(process.env.TEST_UI_API_PORT ?? 8787));
const apiUrl = `http://127.0.0.1:${apiPort}`;

process.stdout.write(`[setup] API port selected: ${String(apiPort)}\n`);

start(
  'api',
  nodeCmd,
  [path.join(repoRoot, 'tools', 'test-ui', 'server', 'index.mjs')],
  repoRoot,
  { TEST_UI_API_PORT: String(apiPort) }
);
start(
  'web',
  npmCmd,
  ['--prefix', path.join('tools', 'test-ui', 'web'), 'run', 'dev'],
  repoRoot,
  { TEST_UI_API_URL: apiUrl }
);
