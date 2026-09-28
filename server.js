'use strict';

/**
 * Live Audience Interaction — лёгкая альтернатива Slido.
 *
 *   /        — страница участника (телефон): вопрос с именем и фото.
 *   /screen  — экран презентации (ТВ/проектор): живая лента сообщений.
 *
 * Транспорт: Socket.IO (WebSocket + авто-fallback на long-polling).
 */

const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const qrcode = require('qrcode-generator');
const { Server } = require('socket.io');

/* ------------------------------------------------------------------ */
/*  Конфигурация                                                       */
/* ------------------------------------------------------------------ */

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MAX_TEXT_LENGTH = 200; // максимум символов в одном сообщении
const MAX_NAME_LENGTH = 40; // максимум символов в имени участника
const MAX_PHOTO_CHARS = 300000; // максимум длины data-URL фото (~225 КБ данных)
const MAX_HISTORY = 100; // сколько последних сообщений держать в памяти
const SEND_COOLDOWN_MS = 700; // серверный антиспам: пауза между сообщениями

// PUBLIC_URL — публичный адрес страницы участника (туннель ngrok/localtunnel или свой домен).
// Если не задан, адрес определяется по заголовкам запроса, а в локальной сети — по IP компьютера.
const PUBLIC_URL = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');

/* ------------------------------------------------------------------ */
/*  HTTP-сервер (Express)                                              */
/* ------------------------------------------------------------------ */

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.disable('x-powered-by');
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

// Главный экран для проектора/ТВ.
app.get('/screen', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'screen.html'));
});

// Адрес, по которому участники открывают страницу с телефона.
function lanUrl() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        return 'http://' + net.address + ':' + PORT;
      }
    }
  }
  return 'http://localhost:' + PORT;
}

/**
 * Публичный адрес страницы участника:
 *   1) PUBLIC_URL из окружения (ручное переопределение);
 *   2) заголовки туннеля/прокси (ngrok, localtunnel): X-Forwarded-Proto + X-Forwarded-Host;
 *   3) Host из запроса, если он не localhost;
 *   4) локальный IP компьютера в Wi-Fi сети.
 */
function resolveParticipantUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;

  const first = (value) => String(value || '').split(',')[0].trim();
  const host = first(req.headers['x-forwarded-host']) || String(req.headers.host || '');
  const proto = first(req.headers['x-forwarded-proto']) || 'http';

  if (!host || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)) {
    return lanUrl();
  }
  return proto + '://' + host;
}

// Отдаём фронтенду адрес для подключения участников.
app.get('/api/info', (req, res) => {
  res.json({
    port: PORT,
    participantUrl: resolveParticipantUrl(req),
  });
});

/** Рисуем QR-код как масштабируемый SVG — локально, без интернета и внешних сервисов. */
function renderQrSvg(text, size, margin) {
  const qr = qrcode(0, 'M'); // 0 — автоматический выбор версии, M — уровень коррекции
  qr.addData(text);
  qr.make();

  const count = qr.getModuleCount();
  const total = count + margin * 2;
  let path = '';

  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) {
        path += 'M' + (col + margin) + ' ' + (row + margin) + 'h1v1h-1z';
      }
    }
  }

  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '"' +
    ' viewBox="0 0 ' + total + ' ' + total + '" shape-rendering="crispEdges" role="img"' +
    ' aria-label="QR-код для подключения участников">' +
    '<rect width="' + total + '" height="' + total + '" fill="#ffffff"/>' +
    '<path d="' + path + '" fill="#000000"/>' +
    '</svg>'
  );
}

// QR-код со ссылкой для участников (показывается на экране презентации).
app.get('/api/qr.svg', (req, res) => {
  const url = resolveParticipantUrl(req);
  const requested = Number.parseInt(req.query.size, 10);
  const size = Number.isFinite(requested) ? Math.min(Math.max(requested, 128), 1024) : 512;

  res.type('image/svg+xml');
  res.set('Cache-Control', 'no-store');
  res.send(renderQrSvg(url, size, 4));
});

/* ------------------------------------------------------------------ */
/*  Состояние (в памяти)                                               */
/* ------------------------------------------------------------------ */

/** @type {{ id: string, text: string, name: string, photo: string, createdAt: string }[]} */
const messages = [];
let seq = 0;

/** Приводим входящий текст к безопасному виду. */
function normalizeText(raw) {
  return String(raw === undefined || raw === null ? '' : raw)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT_LENGTH);
}

/** Имя участника: пробелы схлопываем, длину ограничиваем. Пустое имя допустимо (аноним). */
function normalizeName(raw) {
  return String(raw === undefined || raw === null ? '' : raw)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
}

// Фото приходит с телефона как data-URL картинки (base64) — сжатый на клиенте снимок.
// Всё, что не похоже на такую картинку или слишком велико, тихо отбрасываем.
const PHOTO_DATA_URL_RE = /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/]+={0,2}$/i;

/** Проверяем фото-вложение: только data-URL картинки в разумных пределах. */
function normalizePhoto(raw) {
  if (typeof raw !== 'string') return '';
  const value = raw.trim();
  if (!value || value.length > MAX_PHOTO_CHARS) return '';
  return PHOTO_DATA_URL_RE.test(value) ? value : '';
}

/* ------------------------------------------------------------------ */
/*  Socket.IO                                                          */
/* ------------------------------------------------------------------ */

io.on('connection', (socket) => {
  socket.data.lastSentAt = 0;

  // Новый клиент (например, только что открытый экран) получает историю.
  socket.emit('init-messages', messages);

  // Участник отправляет вопрос / ответ.
  socket.on('send-message', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : function () {};
    const now = Date.now();

    if (now - socket.data.lastSentAt < SEND_COOLDOWN_MS) {
      reply({ ok: false, error: 'cooldown' });
      return;
    }

    const data = payload && typeof payload === 'object' ? payload : { text: payload };
    const text = normalizeText(data.text);
    const name = normalizeName(data.name);
    const photo = normalizePhoto(data.photo);

    // Сообщение принимаем, если есть текст или фото.
    if (!text && !photo) {
      reply({ ok: false, error: 'empty' });
      return;
    }

    socket.data.lastSentAt = now;

    const message = {
      id: now.toString(36) + '-' + (++seq).toString(36),
      text: text,
      name: name,
      photo: photo,
      createdAt: new Date(now).toISOString(),
    };

    messages.push(message);
    if (messages.length > MAX_HISTORY) {
      messages.splice(0, messages.length - MAX_HISTORY);
    }

    io.emit('new-message', message); // всем клиентам, включая автора
    reply({ ok: true, id: message.id });
  });

  // Модерация: очистить экран у всех клиентов.
  socket.on('clear-all', (_payload, ack) => {
    messages.length = 0;
    io.emit('messages-cleared');
    if (typeof ack === 'function') ack({ ok: true });
  });

  // Модерация: удалить один вопрос (случайный, дубль, не по теме).
  socket.on('delete-message', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : function () {};
    const id = String((payload && typeof payload === 'object' ? payload.id : payload) || '');
    const index = messages.findIndex((message) => message.id === id);

    if (index === -1) {
      reply({ ok: false, error: 'not-found' });
      return;
    }

    messages.splice(index, 1);
    io.emit('message-deleted', { id: id });
    reply({ ok: true, id: id });
  });
});

/* ------------------------------------------------------------------ */
/*  Запуск                                                             */
/* ------------------------------------------------------------------ */

server.listen(PORT, () => {
  console.log('');
  console.log('  Приложение запущено');
  console.log('  ---------------------------------------------');
  console.log('  Экран презентации : http://localhost:' + PORT + '/screen');
  console.log('  Для участников    : ' + (PUBLIC_URL || lanUrl()) + '/');
  console.log('  ---------------------------------------------');
  if (PUBLIC_URL) {
    console.log('  Адрес взят из PUBLIC_URL (туннель или свой домен).');
  } else {
    console.log('  Wi-Fi: телефон и компьютер должны быть в одной сети.');
    console.log('  Мобильный интернет у гостей? Запустите:');
    console.log('      npm run share');
    console.log('  Туннель поднимется сам, ссылка и QR-код обновятся.');
  }
  console.log('');
});
