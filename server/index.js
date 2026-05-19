import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '0.0.0.0';
const ROOM_CODE_PATTERN = /^\d{4}$/;

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.manifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const rooms = new Map();
const sockets = new Map();

function send(socket, payload) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function roomOf(socket) {
  const meta = sockets.get(socket);
  return meta ? rooms.get(meta.roomCode) : null;
}

function createRoomCode(preferredCode = '') {
  if (ROOM_CODE_PATTERN.test(preferredCode) && !rooms.has(preferredCode)) {
    return preferredCode;
  }

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    if (!rooms.has(code)) {
      return code;
    }
  }
  return null;
}

function removeRoom(roomCode) {
  rooms.delete(roomCode);
}

function closeRoom(roomCode, reason, skipSocket = null) {
  const room = rooms.get(roomCode);
  if (!room) {
    return;
  }

  if (room.host && room.host !== skipSocket) {
    send(room.host, { type: reason });
  }
  if (room.guest && room.guest !== skipSocket) {
    send(room.guest, { type: reason });
  }

  if (room.host) {
    sockets.delete(room.host);
  }
  if (room.guest) {
    sockets.delete(room.guest);
  }
  removeRoom(roomCode);
}

function leaveRoom(socket, reason = 'player-left') {
  const meta = sockets.get(socket);
  if (!meta) {
    return;
  }

  const room = rooms.get(meta.roomCode);
  sockets.delete(socket);
  if (!room) {
    return;
  }

  if (room.host === socket) {
    closeRoom(meta.roomCode, 'room-closed', socket);
    return;
  }

  if (room.guest === socket) {
    if (room.host) {
      send(room.host, { type: reason });
      sockets.delete(room.host);
    }
    removeRoom(meta.roomCode);
  }
}

function handleCreateRoom(socket, message) {
  const roomCode = createRoomCode(message.roomCode);
  if (!roomCode) {
    send(socket, { type: 'error', message: '当前房间太多了，请稍后重试' });
    return;
  }

  rooms.set(roomCode, {
    roomCode,
    host: socket,
    guest: null,
    state: message.state ?? null,
  });
  sockets.set(socket, { roomCode, role: 1 });

  send(socket, {
    type: 'room-created',
    roomCode,
    role: 1,
  });
}

function handleJoinRoom(socket, message) {
  const room = rooms.get(message.roomCode);
  if (!room) {
    send(socket, { type: 'room-missing' });
    return;
  }

  if (room.guest) {
    send(socket, { type: 'room-full' });
    return;
  }

  room.guest = socket;
  sockets.set(socket, { roomCode: room.roomCode, role: 2 });

  send(room.host, {
    type: 'room-ready',
    roomCode: room.roomCode,
    role: 1,
    state: room.state,
  });
  send(room.guest, {
    type: 'room-ready',
    roomCode: room.roomCode,
    role: 2,
    state: room.state,
  });
}

function handleShot(socket, message) {
  const room = roomOf(socket);
  if (!room) {
    return;
  }

  const target = room.host === socket ? room.guest : room.host;
  if (!target) {
    return;
  }

  send(target, {
    type: 'shot',
    roomCode: room.roomCode,
    shot: message.shot,
    state: message.state,
  });
}

function handleStateSync(socket, message) {
  const room = roomOf(socket);
  if (!room || room.host !== socket) {
    return;
  }

  room.state = message.state ?? room.state;
  if (room.guest) {
    send(room.guest, {
      type: 'state-sync',
      roomCode: room.roomCode,
      state: room.state,
    });
  }
}

function handleSocketMessage(socket, raw) {
  let message = null;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    send(socket, { type: 'error', message: '消息格式不正确' });
    return;
  }

  switch (message.type) {
    case 'create-room':
      leaveRoom(socket, 'player-left');
      handleCreateRoom(socket, message);
      break;
    case 'join-room':
      leaveRoom(socket, 'player-left');
      handleJoinRoom(socket, message);
      break;
    case 'shot':
      handleShot(socket, message);
      break;
    case 'state-sync':
      handleStateSync(socket, message);
      break;
    case 'leave-room':
      leaveRoom(socket, 'player-left');
      break;
    default:
      send(socket, { type: 'error', message: '不支持的消息类型' });
      break;
  }
}

function getSafePath(urlPathname) {
  const pathname = decodeURIComponent(urlPathname.split('?')[0]);
  const normalized = pathname === '/' ? '/index.html' : pathname;
  const absolutePath = path.normalize(path.join(distDir, normalized));
  if (!absolutePath.startsWith(distDir)) {
    return null;
  }
  return absolutePath;
}

function serveStatic(req, res) {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host}`);
  const absolutePath = getSafePath(requestUrl.pathname);
  const fallbackPath = path.join(distDir, 'index.html');

  if (!absolutePath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const filePath = fs.existsSync(absolutePath) ? absolutePath : fallbackPath;
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('dist not found. Please run `npm run build` first.');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = contentTypes[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }

  serveStatic(req, res);
});

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (socket) => {
  socket.on('message', (raw) => handleSocketMessage(socket, raw));
  socket.on('close', () => leaveRoom(socket, 'player-left'));
  socket.on('error', () => leaveRoom(socket, 'player-left'));
});

server.on('upgrade', (req, socket, head) => {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host}`);
  if (requestUrl.pathname !== '/ws') {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

server.listen(port, host, () => {
  const urls = new Set([`http://localhost:${port}`]);
  const interfaces = os.networkInterfaces();

  for (const group of Object.values(interfaces)) {
    for (const address of group || []) {
      if (address.family === 'IPv4' && !address.internal) {
        urls.add(`http://${address.address}:${port}`);
      }
    }
  }

  console.log('GeniYing Pro Billiards relay server ready:');
  for (const url of urls) {
    console.log(`  ${url}`);
  }
  console.log(`WebSocket endpoint: ws://<same-host>:${port}/ws`);
});
