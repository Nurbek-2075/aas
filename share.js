'use strict';

/**
 * Автозапуск «под ключ»: сервер + публичный туннель + готовая ссылка для гостей.
 *
 *   npm run share             # поднять туннель, получить ссылку, открыть экран в браузере
 *   npm run share -- --lan    # без туннеля (гости только из той же Wi-Fi сети)
 *   NO_OPEN=1 npm run share   # не открывать браузер автоматически
 *
 * Порядок работы: сначала поднимается туннель и берётся его адрес, затем стартует сервер
 * с PUBLIC_URL — поэтому и QR-код на экране, и подвал сразу показывают рабочую внешнюю ссылку.
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const qrcode = require('qrcode-generator');

const PORT = Number(process.env.PORT) || 3000;
const LOCAL_URL = 'http://127.0.0.1:' + PORT;
const WITH_TUNNEL = !process.argv.includes('--lan');
const OPEN_SCREEN = process.env.NO_OPEN !== '1';

let tunnel = null; // { child, url, name } — заполняется в main()

/* ------------------------------------------------------------------ */
/*  Поиск доступного туннеля                                           */
/* ------------------------------------------------------------------ */

/** Проверяем, есть ли исполняемый файл в PATH (без лишнего вывода). */
function hasBinary(bin, args) {
  const probe = spawnSync(bin, args, { stdio: 'ignore', windowsHide: true });
  return probe.status === 0;
}

/** cloudflared — быстрый https без регистрации: сначала локальный пакет, потом PATH. */
function findCloudflared() {
  try {
    const mod = require('cloudflared');
    const bin = typeof mod === 'string' ? mod : mod.bin || mod.path;
    if (bin && fs.existsSync(bin)) return bin;
  } catch (error) {
    // пакет не установлен — проверим PATH
  }
  return hasBinary('cloudflared', ['--version']) ? 'cloudflared' : null;
}

/** ngrok — нужен аккаунт и authtoken, поэтому запасной вариант. */
function findNgrok() {
  return hasBinary('ngrok', ['--version']) ? 'ngrok' : null;
}

/** Последний вариант без регистрации: ssh-туннель localhost.run. */
function findSsh() {
  return hasBinary('ssh', ['-V']) ? 'ssh' : null;
}

const TUNNELS = [
  {
    // Без регистрации и без загрузок: ssh уже есть в Windows 10+.
    // Каждый запуск даёт новый адрес вида https://<случайный>.lhr.life
    name: 'localhost.run (ssh)',
    find: findSsh,
    args: (port) => [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'BatchMode=yes',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=30',
      '-R', '80:localhost:' + port,
      'nokey@localhost.run',
    ],
    pattern: /https:\/\/[a-z0-9-]+\.lhr\.life/i,
    hint: 'включите в Windows компонент «Клиент OpenSSH» (Параметры → Приложения → Доп. компоненты)',
  },
  {
    name: 'cloudflared',
    find: findCloudflared,
    args: (port) => ['tunnel', '--url', 'http://127.0.0.1:' + port, '--no-autoupdate'],
    pattern: /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i,
    hint: 'поставить можно так: winget install --id Cloudflare.cloudflared',
  },
  {
    name: 'ngrok',
    find: findNgrok,
    args: (port) => ['http', String(port), '--log', 'stdout'],
    pattern: /https:\/\/[a-z0-9][a-z0-9.-]*\.ngrok(?:-free)?\.(?:app|io|dev)/i,
    hint: 'нужен authtoken: ngrok config add-authtoken <токен>',
  },
];

/* ------------------------------------------------------------------ */
/*  Запуск туннеля                                                     */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Поднимаем туннель и вытаскиваем из его вывода публичный адрес. */
function startTunnel(candidate) {
  return new Promise((resolve, reject) => {
    const child = spawn(candidate.find(), candidate.args(PORT), {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let output = '';
    let settled = false;

    const finish = (error, url) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.removeAllListeners('data');
      child.stderr.removeAllListeners('data');
      if (error) reject(error);
      else resolve({ child, url, name: candidate.name });
    };

    const scan = (chunk) => {
      output += chunk.toString();
      const match = output.match(candidate.pattern);
      if (match) finish(null, match[0]);
    };

    child.stdout.on('data', scan);
    child.stderr.on('data', scan); // cloudflared пишет ссылку в stderr
    child.on('error', (error) => finish(error));
    child.on('exit', (code) => finish(new Error('процесс завершился с кодом ' + code)));

    const timer = setTimeout(() => finish(new Error('ссылка не появилась за 30 с')), 30000);
  });
}

/** Перебираем кандидатов, пока какой-нибудь туннель не заработает. */
async function openTunnel() {
  for (const candidate of TUNNELS) {
    if (!candidate.find()) continue;

    process.stdout.write('  Пробую ' + candidate.name + '… ');
    try {
      const started = await startTunnel(candidate);
      console.log('OK');
      return started;
    } catch (error) {
      console.log('не вышло (' + error.message + ')');
      console.log('    подсказка: ' + candidate.hint);
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Вспомогательные                                                    */
/* ------------------------------------------------------------------ */

/** Ждём, пока сервер начнёт отвечать, и забираем адрес для гостей. */
async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(LOCAL_URL + '/api/info');
      if (response.ok) return await response.json();
    } catch (error) {
      // сервер ещё поднимается
    }
    await sleep(200);
  }
  return null;
}

function openBrowser(url) {
  if (!OPEN_SCREEN) return;
  const isWindows = process.platform === 'win32';
  const command = isWindows ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = isWindows ? ['/c', 'start', '', url] : [url];
  try {
    spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true }).unref();
  } catch (error) {
    // браузер не открылся — ссылку можно открыть вручную
  }
}

/** QR прямо в терминале: удобно, если с браузером на проекторе что-то пошло не так. */
function terminalQr(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createASCII(1, 2).replace(/\s+$/, '');
}

function shutdown(code) {
  if (tunnel && tunnel.child && !tunnel.child.killed) {
    try {
      tunnel.child.kill();
    } catch (error) {
      // процесс уже завершён
    }
  }
  process.exit(code);
}

process.on('SIGINT', () => {
  console.log('\n  Останавливаю сервер и туннель…');
  shutdown(0);
});
process.on('SIGTERM', () => shutdown(0));

/* ------------------------------------------------------------------ */
/*  Сценарий                                                           */
/* ------------------------------------------------------------------ */

async function main() {
  console.log('');

  if (WITH_TUNNEL) {
    tunnel = await openTunnel();
    if (!tunnel) {
      console.log('  Внешний туннель не поднялся — работаю в локальной сети Wi-Fi.');
    } else {
      // Если туннель отвалится во время мероприятия — предупредим ведущего.
      tunnel.child.on('exit', () => {
        console.log('  Внимание: внешний туннель остановился.');
        console.log('  Перезапустите npm run share — новая ссылка появится автоматически.');
      });
    }
  }

  // Сервер запускается в этом же процессе: PUBLIC_URL он читает при старте.
  process.env.PORT = String(PORT);
  if (tunnel) process.env.PUBLIC_URL = tunnel.url;
  require(path.join(__dirname, 'server.js'));

  const info = await waitForServer();
  if (!info) {
    console.log('  Сервер не ответил за 15 секунд. Проверьте, свободен ли порт ' + PORT + '.');
    shutdown(1);
    return;
  }

  console.log('  ================================================================');
  console.log('   ССЫЛКА ДЛЯ ГОСТЕЙ:  ' + info.participantUrl);
  console.log('  ================================================================');
  if (!tunnel) {
    console.log('   Это адрес внутри Wi-Fi: телефон и компьютер должны быть в одной сети.');
  }
  console.log('');
  console.log(terminalQr(info.participantUrl));
  console.log('   Подключиться можно и по ссылке, и по QR-коду выше.');
  console.log('');
  console.log('   Экран презентации : ' + LOCAL_URL + '/screen');
  console.log('   Остановить        : Ctrl + C');
  console.log('');

  openBrowser(LOCAL_URL + '/screen');
}

main().catch((error) => {
  console.log('  Ошибка: ' + (error && error.message ? error.message : error));
  shutdown(1);
});
