import { registerPlugin } from '@capacitor/core';

const DEFAULT_LAN_PORT = 8787;
const lanRoomPlugin = registerPlugin('LanRoomPlugin');

function noop() {}

function isSocketOpen(socket) {
  return socket?.readyState === WebSocket.OPEN;
}

function normalizeRoom(room) {
  if (!room) {
    return null;
  }
  return {
    roomCode: String(room.roomCode || '').trim(),
    roomName: String(room.roomName || '').trim() || '思颖竞技台球房间',
    deviceName: String(room.deviceName || '').trim() || '附近设备',
    hostIp: String(room.hostIp || '').trim(),
    port: Number(room.port || DEFAULT_LAN_PORT),
    serviceName: String(room.serviceName || '').trim(),
    connectionStatus: String(room.connectionStatus || '').trim() || 'available',
  };
}

function normalizeRooms(rooms) {
  const seen = new Set();
  const normalized = [];
  for (const room of rooms || []) {
    const item = normalizeRoom(room);
    if (!item?.roomCode || !item.hostIp) {
      continue;
    }
    const key = `${item.roomCode}:${item.hostIp}:${item.port}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(item);
  }
  return normalized;
}

export function buildSocketUrl(hostIp, port = DEFAULT_LAN_PORT) {
  const host = String(hostIp || '').trim();
  if (!host) {
    return '';
  }
  const normalizedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `ws://${normalizedHost}:${Number(port || DEFAULT_LAN_PORT)}/ws`;
}

export class BaseSocketTransport {
  constructor(kind) {
    this.kind = kind;
    this.socket = null;
    this.socketUrl = '';
    this.pendingConnection = null;
    this.intentionalSocketClose = false;
    this.onMessage = noop;
    this.onStatus = noop;
    this.onDisconnect = noop;
  }

  setHandlers(handlers = {}) {
    this.onMessage = handlers.onMessage || noop;
    this.onStatus = handlers.onStatus || noop;
    this.onDisconnect = handlers.onDisconnect || noop;
  }

  async connect(socketUrl) {
    if (!socketUrl) {
      throw new Error('missing-socket-url');
    }

    if (isSocketOpen(this.socket) && this.socketUrl === socketUrl) {
      return this.socket;
    }

    if (this.pendingConnection) {
      return this.pendingConnection;
    }

    if (this.socket && this.socketUrl !== socketUrl) {
      await this.disconnect();
    }

    this.pendingConnection = new Promise((resolve, reject) => {
      const ws = new WebSocket(socketUrl);
      this.socket = ws;
      this.socketUrl = socketUrl;
      let settled = false;

      const cleanupPending = () => {
        this.pendingConnection = null;
      };

      const finishReject = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanupPending();
        this.socket = null;
        this.socketUrl = '';
        reject(error);
      };

      const finishResolve = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanupPending();
        resolve(ws);
      };

      const timeout = window.setTimeout(() => {
        try {
          this.intentionalSocketClose = true;
          ws.close();
        } catch {}
        this.intentionalSocketClose = false;
        finishReject(new Error('socket-timeout'));
      }, 8000);

      ws.addEventListener('open', () => {
        window.clearTimeout(timeout);
        this.onStatus({ tone: 'ok', message: '房间连接已建立', kind: this.kind });
        finishResolve();
      });

      ws.addEventListener('message', (event) => {
        let message = null;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        this.onMessage(message);
      });

      ws.addEventListener('error', () => {
        window.clearTimeout(timeout);
        if (!settled) {
          finishReject(new Error('socket-error'));
        } else {
          this.onStatus({ tone: 'error', message: '房间连接异常', kind: this.kind });
        }
      });

      ws.addEventListener('close', () => {
        window.clearTimeout(timeout);
        const wasPending = !settled;
        this.socket = null;
        this.socketUrl = '';

        if (wasPending) {
          finishReject(new Error('socket-closed'));
          return;
        }

        cleanupPending();
        if (!this.intentionalSocketClose) {
          this.onDisconnect({ kind: this.kind, message: '房间连接已断开' });
        }
      });
    });

    return this.pendingConnection;
  }

  send(payload) {
    if (isSocketOpen(this.socket)) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  async disconnect({ notify = false, roomCode = '' } = {}) {
    if (notify && roomCode && isSocketOpen(this.socket)) {
      this.send({ type: 'leave-room', roomCode });
    }

    this.intentionalSocketClose = true;
    try {
      this.socket?.close();
    } catch {}
    this.socket = null;
    this.socketUrl = '';
    this.pendingConnection = null;

    window.setTimeout(() => {
      this.intentionalSocketClose = false;
    }, 0);
  }
}

export class RelayTransport extends BaseSocketTransport {
  constructor({ getRelayUrl }) {
    super('relay');
    this.getRelayUrl = getRelayUrl;
  }

  async createRoom({ state, roomCode = '' }) {
    const socketUrl = this.getRelayUrl();
    if (!socketUrl) {
      throw new Error('missing-relay-url');
    }
    await this.connect(socketUrl);
    this.send({ type: 'create-room', roomCode, state });
  }

  async joinRoom({ roomCode }) {
    const socketUrl = this.getRelayUrl();
    if (!socketUrl) {
      throw new Error('missing-relay-url');
    }
    await this.connect(socketUrl);
    this.send({ type: 'join-room', roomCode });
  }
}

export class LanDirectTransport extends BaseSocketTransport {
  constructor() {
    super('lan');
    this.onRoomsUpdated = noop;
    this.onHostStatus = noop;
    this.discoveryActive = false;
    this.hostMeta = null;
    this.discoveredRooms = [];
    this.listenerHandles = [];
    this.listenersBound = false;
  }

  isAvailable() {
    return Boolean(window.Capacitor?.isNativePlatform?.() && window.Capacitor?.getPlatform?.() === 'android');
  }

  setHandlers(handlers = {}) {
    super.setHandlers(handlers);
    this.onRoomsUpdated = handlers.onRoomsUpdated || noop;
    this.onHostStatus = handlers.onHostStatus || noop;
  }

  async ensurePluginListeners() {
    if (!this.isAvailable() || this.listenersBound) {
      return;
    }

    this.listenerHandles.push(
      await lanRoomPlugin.addListener('roomsUpdated', (payload) => {
        this.discoveredRooms = normalizeRooms(payload?.rooms);
        this.onRoomsUpdated(this.discoveredRooms);
      }),
    );

    this.listenerHandles.push(
      await lanRoomPlugin.addListener('hostStatusChanged', (payload) => {
        if (payload?.roomCode) {
          this.hostMeta = {
            ...this.hostMeta,
            ...normalizeRoom(payload),
          };
        }
        this.onHostStatus(payload || {});
      }),
    );

    this.listenersBound = true;
  }

  async startHosting({ roomName }) {
    if (!this.isAvailable()) {
      throw new Error('lan-plugin-unavailable');
    }

    await this.ensurePluginListeners();
    const meta = normalizeRoom(await lanRoomPlugin.startHosting({ roomName }));
    this.hostMeta = meta;
    await this.connect(buildSocketUrl('127.0.0.1', meta.port));
    return meta;
  }

  async createRoom({ state }) {
    if (!this.hostMeta?.roomCode) {
      throw new Error('missing-host-meta');
    }
    this.send({ type: 'create-room', roomCode: this.hostMeta.roomCode, state });
  }

  async stopHosting() {
    if (!this.isAvailable()) {
      return;
    }
    try {
      await lanRoomPlugin.stopHosting();
    } catch {}
    this.hostMeta = null;
  }

  async startDiscovery() {
    if (!this.isAvailable()) {
      return [];
    }
    await this.ensurePluginListeners();
    await lanRoomPlugin.startDiscovery();
    this.discoveryActive = true;
    return this.getDiscoveredRooms();
  }

  async stopDiscovery() {
    if (!this.isAvailable()) {
      return;
    }
    try {
      await lanRoomPlugin.stopDiscovery();
    } catch {}
    this.discoveryActive = false;
  }

  async getDiscoveredRooms() {
    if (!this.isAvailable()) {
      return [];
    }
    await this.ensurePluginListeners();
    const result = await lanRoomPlugin.getDiscoveredRooms();
    this.discoveredRooms = normalizeRooms(result?.rooms ?? result);
    this.onRoomsUpdated(this.discoveredRooms);
    return this.discoveredRooms;
  }

  async joinRoom(room) {
    const selectedRoom = normalizeRoom(room);
    if (!selectedRoom?.roomCode || !selectedRoom.hostIp) {
      throw new Error('missing-room-meta');
    }
    await this.connect(buildSocketUrl(selectedRoom.hostIp, selectedRoom.port));
    this.send({ type: 'join-room', roomCode: selectedRoom.roomCode });
    return selectedRoom;
  }

  async joinByIp({ hostIp, roomCode, port = DEFAULT_LAN_PORT }) {
    if (!hostIp || !roomCode) {
      throw new Error('missing-manual-room');
    }
    const meta = normalizeRoom({
      hostIp,
      roomCode,
      roomName: '手动加入房间',
      port,
      deviceName: '手动输入',
    });
    await this.connect(buildSocketUrl(meta.hostIp, meta.port));
    this.send({ type: 'join-room', roomCode: meta.roomCode });
    return meta;
  }

  async destroy() {
    await this.stopDiscovery();
    await this.stopHosting();
    await this.disconnect();
  }
}
