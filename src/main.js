import './styles.css';
import {
  BALL_COLORS,
  BALL_RADIUS,
  GAME_HEIGHT,
  GAME_WIDTH,
  INITIAL_CUE_POS,
  POCKET_RADIUS,
  POCKETS,
  ROOM_CODE_PATTERN,
  advancePhysicsFrame,
  clamp,
  createBalls,
  chooseAiPlan,
  describePocketedBall,
  exportGameState,
  getAimingGuide,
  getCueBall,
  importGameState,
  magnitude,
  normalize,
  rotate,
  setCuePosition,
} from './game-core.js';
import { LanDirectTransport, RelayTransport } from './transports.js';

const APP_NAME_ZH = '思颖竞技台球';
const APP_NAME_EN = 'GeniYing Pro Billiards';
const DEFAULT_ROOM_NAME = `${APP_NAME_ZH}房间`;
const RELAY_STORAGE_KEY = 'geniying-pro-billiards-relay-url';

const el = {
  canvas: document.getElementById('gameCanvas'),
  tableWrapper: document.getElementById('table-wrapper'),
  clothWrapper: document.getElementById('cloth-wrapper'),
  turnIndicator: document.getElementById('turn-indicator'),
  roleDisplay: document.getElementById('role-display'),
  roomDisplay: document.getElementById('room-display'),
  networkStatus: document.getElementById('network-status'),
  toast: document.getElementById('toast'),
  lobbyModal: document.getElementById('lobby-modal'),
  waitingModal: document.getElementById('waiting-modal'),
  waitingTitle: document.getElementById('waiting-title'),
  waitingCopy: document.getElementById('waiting-copy'),
  waitingRoomId: document.getElementById('waiting-room-id'),
  waitingRoomName: document.getElementById('waiting-room-name'),
  waitingHostIp: document.getElementById('waiting-host-ip'),
  scanStatus: document.getElementById('scan-status'),
  roomList: document.getElementById('room-list'),
  installNote: document.getElementById('install-note'),
  nativeLanPanel: document.getElementById('native-lan-panel'),
  pwaPanel: document.getElementById('pwa-panel'),
  relayPanel: document.getElementById('relay-panel'),
  inputRoomName: document.getElementById('input-room-name'),
  inputManualIp: document.getElementById('input-manual-ip'),
  inputManualRoom: document.getElementById('input-manual-room'),
  inputRelayRoom: document.getElementById('input-relay-room'),
  inputRelayServer: document.getElementById('input-relay-server'),
  relayServerDisplay: document.getElementById('relay-server-display'),
  btnBack: document.getElementById('btn-back'),
  btnSingle: document.getElementById('btn-single'),
  btnAi: document.getElementById('btn-ai'),
  btnHostLan: document.getElementById('btn-host-lan'),
  btnScanLan: document.getElementById('btn-scan-lan'),
  btnJoinManual: document.getElementById('btn-join-manual'),
  btnInstallPwa: document.getElementById('btn-install-pwa'),
  btnDownloadApk: document.getElementById('btn-download-apk'),
  btnCreateRelay: document.getElementById('btn-create-relay'),
  btnJoinRelay: document.getElementById('btn-join-relay'),
  btnSaveRelay: document.getElementById('btn-save-relay'),
  btnResetRelay: document.getElementById('btn-reset-relay'),
  btnShareRoom: document.getElementById('btn-share-room'),
  btnCancelWaiting: document.getElementById('btn-cancel-waiting'),
  btnForceLandscape: document.getElementById('force-landscape'),
};

const ctx = el.canvas.getContext('2d', { alpha: false });
const lanTransport = new LanDirectTransport();
const relayTransport = new RelayTransport({ getRelayUrl: getEffectiveRelayUrl });

const dragState = {
  active: false,
  startX: 0,
  startY: 0,
  currentX: 0,
  currentY: 0,
  mode: 'shoot',
};

const appState = {
  balls: [],
  currentTurn: 1,
  playerRole: 1,
  gameMode: 'single',
  currentRoomCode: '',
  currentRoomName: DEFAULT_ROOM_NAME,
  renderScale: 1,
  viewWidth: GAME_WIDTH,
  viewHeight: GAME_HEIGHT,
  isMoving: false,
  isFreeBall: false,
  isHost: false,
  awaitingAuthoritativeSync: false,
  aiThinking: false,
  aiTurnTimer: 0,
  toastTimer: 0,
  activeTransport: null,
  waitingMeta: null,
  discoveredRooms: [],
  scanActive: false,
  installPrompt: null,
};

function isHostedWebPage() {
  return window.location.protocol === 'http:' || window.location.protocol === 'https:';
}

function isNativeAndroidApp() {
  return lanTransport.isAvailable();
}

function normalizeRelayUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }

  let candidate = raw.replace(/^https?:\/\//i, (match) => (match.toLowerCase() === 'https://' ? 'wss://' : 'ws://'));
  if (!/^[a-z]+:\/\//i.test(candidate)) {
    candidate = `ws://${candidate}`;
  }

  try {
    const url = new URL(candidate);
    if (!/^wss?:$/.test(url.protocol)) {
      return '';
    }
    if (!url.pathname || url.pathname === '/') {
      url.pathname = '/ws';
    }
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function deriveAutoRelayUrl() {
  if (!isHostedWebPage() || isNativeAndroidApp()) {
    return '';
  }
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return normalizeRelayUrl(`${protocol}://${window.location.host}/ws`);
}

function readStoredRelayUrl() {
  try {
    return normalizeRelayUrl(window.localStorage.getItem(RELAY_STORAGE_KEY) || '');
  } catch {
    return '';
  }
}

function writeStoredRelayUrl(value) {
  try {
    if (value) {
      window.localStorage.setItem(RELAY_STORAGE_KEY, value);
    } else {
      window.localStorage.removeItem(RELAY_STORAGE_KEY);
    }
  } catch {}
}

function getEffectiveRelayUrl() {
  return readStoredRelayUrl() || deriveAutoRelayUrl();
}

function populateRelayInput() {
  el.inputRelayServer.value = readStoredRelayUrl();
}

function refreshRelayUi() {
  const stored = readStoredRelayUrl();
  const auto = deriveAutoRelayUrl();
  const effective = getEffectiveRelayUrl();

  if (stored) {
    el.relayServerDisplay.textContent = `已保存房间服务器：${stored}`;
    return;
  }

  if (auto) {
    el.relayServerDisplay.textContent = `当前自动使用：${auto}`;
    return;
  }

  if (effective) {
    el.relayServerDisplay.textContent = `当前服务器：${effective}`;
    return;
  }

  el.relayServerDisplay.textContent = '还没有设置中继服务器。网页版可自动使用同域 WebSocket，APK 版更推荐直接走同 Wi-Fi 局域网。';
}

function formatEndpointLabel(hostIp, port) {
  if (!hostIp) {
    return '--';
  }
  return `${hostIp}:${port}`;
}

function getCurrentRoomName() {
  const typed = String(el.inputRoomName?.value || '').trim();
  return typed || DEFAULT_ROOM_NAME;
}

function showToast(message) {
  if (!message) {
    return;
  }
  window.clearTimeout(appState.toastTimer);
  el.toast.textContent = message;
  el.toast.classList.add('show');
  appState.toastTimer = window.setTimeout(() => {
    el.toast.classList.remove('show');
  }, 1800);
}

function updateNetworkStatus(message, tone = 'neutral') {
  el.networkStatus.textContent = message;
  el.networkStatus.dataset.tone = tone;
}

function setTurnText(message, tone = 'neutral') {
  el.turnIndicator.textContent = message;
  el.turnIndicator.dataset.tone = tone;
}

function setRoomLabel(text) {
  el.roomDisplay.textContent = text;
}

function setScanStatus(message) {
  el.scanStatus.textContent = message;
}

function exportState() {
  return exportGameState(appState);
}

function applyImportedState(rawState) {
  const next = importGameState(rawState);
  appState.balls = next.balls;
  appState.currentTurn = next.currentTurn;
  appState.isFreeBall = next.isFreeBall;
  appState.awaitingAuthoritativeSync = false;
  updateUI();
  draw();
}

function resetRack() {
  appState.balls = createBalls();
  appState.currentTurn = 1;
  appState.isMoving = false;
  appState.isFreeBall = false;
  appState.awaitingAuthoritativeSync = false;
  dragState.active = false;
  appState.aiThinking = false;
  window.clearTimeout(appState.aiTurnTimer);
}

function humanCanAct() {
  if (appState.isMoving || appState.awaitingAuthoritativeSync || appState.aiThinking) {
    return false;
  }
  if (appState.gameMode === 'online') {
    return appState.currentTurn === appState.playerRole;
  }
  if (appState.gameMode === 'ai') {
    return appState.currentTurn === 1;
  }
  return true;
}

function updateUI() {
  if (appState.gameMode === 'single') {
    el.roleDisplay.textContent = appState.currentTurn === 1 ? '红球方 (1-7)' : '花球方 (9-15)';
    setTurnText(
      appState.isFreeBall ? `玩家 ${appState.currentTurn} 的自由球` : `玩家 ${appState.currentTurn} 的回合`,
      appState.currentTurn === 1 ? 'warning' : 'alt',
    );
    return;
  }

  if (appState.gameMode === 'ai') {
    el.roleDisplay.textContent = '你是红球方 (1-7) / AI 是花球方 (9-15)';
    if (appState.currentTurn === 1) {
      setTurnText(appState.isFreeBall ? '你的自由球，先摆白球再击球' : '你的回合', 'active');
    } else if (appState.aiThinking) {
      setTurnText(appState.isFreeBall ? 'AI 正在摆放自由球...' : 'AI 正在思考...', 'warning');
    } else {
      setTurnText(appState.isFreeBall ? 'AI 的自由球' : 'AI 击球中...', 'wait');
    }
    return;
  }

  el.roleDisplay.textContent = appState.playerRole === 1 ? '你是红球方 (1-7)' : '你是花球方 (9-15)';
  if (appState.awaitingAuthoritativeSync) {
    setTurnText('正在等待房主同步球桌状态...', 'warning');
    return;
  }
  if (appState.currentTurn === appState.playerRole) {
    setTurnText(appState.isFreeBall ? '你的自由球，拖动白球到要摆放的位置' : '你的回合', 'active');
  } else {
    setTurnText(appState.isFreeBall ? '等待对方摆放自由球...' : '等待对方击球...', 'wait');
  }
}

function resize() {
  let width = window.innerWidth * 0.95;
  let height = width / 2;
  if (height > window.innerHeight * 0.9) {
    height = window.innerHeight * 0.9;
    width = height * 2;
  }

  el.tableWrapper.style.width = `${width}px`;
  el.tableWrapper.style.height = `${height}px`;

  const padding = parseFloat(window.getComputedStyle(el.tableWrapper).padding) || 0;
  const innerWidth = width - padding * 2;
  const innerHeight = height - padding * 2;

  el.clothWrapper.style.width = `${innerWidth}px`;
  el.clothWrapper.style.height = `${innerHeight}px`;

  const dpr = window.devicePixelRatio || 1;
  el.canvas.width = innerWidth * dpr;
  el.canvas.height = innerHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  appState.renderScale = innerWidth / GAME_WIDTH;
  appState.viewWidth = innerWidth;
  appState.viewHeight = innerHeight;
  draw();
}

function getPointerPosition(event) {
  const rect = el.canvas.getBoundingClientRect();
  const pointer = event.touches ? event.touches[0] : event;
  return {
    x: (pointer.clientX - rect.left) / appState.renderScale,
    y: (pointer.clientY - rect.top) / appState.renderScale,
  };
}

function roundRect(x, y, width, height, radius) {
  const w = Math.max(width, 0);
  const h = Math.max(height, 0);
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawPowerMeter(cue, direction, stretch) {
  const power = clamp(stretch * 0.55, 0, 100);
  const meterWidth = 160 * appState.renderScale;
  const meterHeight = 18 * appState.renderScale;
  const anchorX = cue.x * appState.renderScale - meterWidth / 2;
  const anchorY = cue.y * appState.renderScale + 34 * appState.renderScale;

  ctx.save();
  ctx.fillStyle = 'rgba(2, 8, 23, 0.7)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
  ctx.lineWidth = 1.5;
  roundRect(anchorX, anchorY, meterWidth, meterHeight, 999);
  ctx.fill();
  ctx.stroke();

  const fillWidth = (meterWidth - 4) * (power / 100);
  const gradient = ctx.createLinearGradient(anchorX, anchorY, anchorX + meterWidth, anchorY);
  gradient.addColorStop(0, '#34d399');
  gradient.addColorStop(0.55, '#facc15');
  gradient.addColorStop(1, '#f97316');
  ctx.fillStyle = gradient;
  roundRect(anchorX + 2, anchorY + 2, fillWidth, meterHeight - 4, 999);
  ctx.fill();

  ctx.fillStyle = '#e2e8f0';
  ctx.font = `700 ${12 * appState.renderScale}px Segoe UI`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`力度 ${Math.round(power)}%`, cue.x * appState.renderScale, anchorY - 6 * appState.renderScale);

  const springLength = clamp(stretch * 3.6, 28, 120) * appState.renderScale;
  const springStart = {
    x: cue.x * appState.renderScale - direction.x * (BALL_RADIUS * appState.renderScale + 12 * appState.renderScale),
    y: cue.y * appState.renderScale - direction.y * (BALL_RADIUS * appState.renderScale + 12 * appState.renderScale),
  };
  const springEnd = {
    x: springStart.x - direction.x * springLength,
    y: springStart.y - direction.y * springLength,
  };

  ctx.beginPath();
  const normal = { x: -direction.y, y: direction.x };
  const segments = 7;
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const baseX = springStart.x + (springEnd.x - springStart.x) * t;
    const baseY = springStart.y + (springEnd.y - springStart.y) * t;
    const wobble = i === 0 || i === segments ? 0 : (i % 2 === 0 ? -1 : 1) * 8 * appState.renderScale;
    const px = baseX + normal.x * wobble;
    const py = baseY + normal.y * wobble;
    if (i === 0) {
      ctx.moveTo(px, py);
    } else {
      ctx.lineTo(px, py);
    }
  }
  ctx.strokeStyle = 'rgba(250, 204, 21, 0.8)';
  ctx.lineWidth = 2.2;
  ctx.stroke();
  ctx.restore();
}

function drawAimingGuide(cue, guide) {
  const cueX = cue.x * appState.renderScale;
  const cueY = cue.y * appState.renderScale;

  ctx.save();
  ctx.setLineDash([9 * appState.renderScale, 6 * appState.renderScale]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
  ctx.beginPath();
  ctx.moveTo(cueX, cueY);
  if (guide.hit) {
    ctx.lineTo(guide.hit.contactPoint.x * appState.renderScale, guide.hit.contactPoint.y * appState.renderScale);
  } else {
    ctx.lineTo(guide.aimEnd.x * appState.renderScale, guide.aimEnd.y * appState.renderScale);
  }
  ctx.stroke();

  if (guide.hit) {
    if (guide.objectPath) {
      ctx.strokeStyle = 'rgba(96, 165, 250, 0.88)';
      ctx.beginPath();
      ctx.moveTo(guide.hit.ball.x * appState.renderScale, guide.hit.ball.y * appState.renderScale);
      ctx.lineTo(guide.objectPath.x * appState.renderScale, guide.objectPath.y * appState.renderScale);
      ctx.stroke();
    }

    if (guide.cueDeflection) {
      ctx.strokeStyle = 'rgba(250, 204, 21, 0.82)';
      ctx.beginPath();
      ctx.moveTo(guide.hit.contactPoint.x * appState.renderScale, guide.hit.contactPoint.y * appState.renderScale);
      ctx.lineTo(guide.cueDeflection.x * appState.renderScale, guide.cueDeflection.y * appState.renderScale);
      ctx.stroke();
    }

    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(
      guide.hit.contactPoint.x * appState.renderScale,
      guide.hit.contactPoint.y * appState.renderScale,
      4.5 * appState.renderScale,
      0,
      Math.PI * 2,
    );
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.fill();
  }

  ctx.restore();
}

function drawCueStick(cue, direction, stretch) {
  const cueX = cue.x * appState.renderScale;
  const cueY = cue.y * appState.renderScale;
  const pullback = clamp(stretch * 0.65, 12, 68) * appState.renderScale;
  const startOffset = (BALL_RADIUS + 7) * appState.renderScale + pullback;
  const endOffset = startOffset + 220 * appState.renderScale;
  const butt = { x: cueX - direction.x * endOffset, y: cueY - direction.y * endOffset };
  const shaft = { x: cueX - direction.x * startOffset, y: cueY - direction.y * startOffset };

  const gradient = ctx.createLinearGradient(shaft.x, shaft.y, butt.x, butt.y);
  gradient.addColorStop(0, '#e5e7eb');
  gradient.addColorStop(0.05, '#fde68a');
  gradient.addColorStop(0.32, '#d97706');
  gradient.addColorStop(0.5, '#1f2937');
  gradient.addColorStop(1, '#111827');

  ctx.beginPath();
  ctx.moveTo(shaft.x, shaft.y);
  ctx.lineTo(butt.x, butt.y);
  ctx.strokeStyle = gradient;
  ctx.lineWidth = 6 * appState.renderScale;
  ctx.lineCap = 'round';
  ctx.stroke();
}

function drawTable() {
  ctx.fillStyle = '#135b36';
  ctx.fillRect(0, 0, appState.viewWidth, appState.viewHeight);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(INITIAL_CUE_POS.x * appState.renderScale, 0);
  ctx.lineTo(INITIAL_CUE_POS.x * appState.renderScale, GAME_HEIGHT * appState.renderScale);
  ctx.stroke();

  for (const pocket of POCKETS) {
    ctx.beginPath();
    ctx.arc(pocket.x * appState.renderScale, pocket.y * appState.renderScale, POCKET_RADIUS * appState.renderScale, 0, Math.PI * 2);
    ctx.fillStyle = '#020617';
    ctx.fill();
  }
}

function drawBalls() {
  for (const ball of appState.balls) {
    if (!ball.active) {
      continue;
    }

    const x = ball.x * appState.renderScale;
    const y = ball.y * appState.renderScale;
    const radius = BALL_RADIUS * appState.renderScale;

    ctx.beginPath();
    ctx.arc(x + 2, y + 2, radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    if (ball.id === 0) {
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    } else if (ball.id > 8) {
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = BALL_COLORS[ball.id];
      ctx.fillRect(x - radius, y - radius * 0.42, radius * 2, radius * 0.84);
      ctx.restore();
    } else {
      ctx.fillStyle = BALL_COLORS[ball.id];
      ctx.fill();
    }

    if (ball.id !== 0) {
      ctx.beginPath();
      ctx.arc(x, y, radius * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.fillStyle = '#0f172a';
      ctx.font = `700 ${radius * 0.82}px Segoe UI`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(ball.id), x, y + 1);
    }

    ctx.beginPath();
    ctx.arc(x - radius * 0.28, y - radius * 0.28, radius * 0.24, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.32)';
    ctx.fill();
  }
}

function drawFreeBallHighlight() {
  if (!appState.isFreeBall || appState.isMoving) {
    return;
  }
  if (appState.gameMode === 'online' && appState.currentTurn !== appState.playerRole) {
    return;
  }
  if (appState.gameMode === 'ai' && appState.currentTurn !== 1) {
    return;
  }

  const cue = getCueBall(appState.balls);
  if (!cue || !cue.active) {
    return;
  }

  ctx.save();
  ctx.beginPath();
  ctx.arc(
    cue.x * appState.renderScale,
    cue.y * appState.renderScale,
    (BALL_RADIUS + 7) * appState.renderScale,
    0,
    Math.PI * 2,
  );
  ctx.strokeStyle = 'rgba(250, 204, 21, 0.82)';
  ctx.lineWidth = 3;
  ctx.setLineDash([6 * appState.renderScale, 5 * appState.renderScale]);
  ctx.stroke();
  ctx.restore();
}

function draw() {
  drawTable();
  drawBalls();
  drawFreeBallHighlight();

  if (dragState.active && dragState.mode === 'shoot' && humanCanAct()) {
    const cue = getCueBall(appState.balls);
    const guide = cue ? getAimingGuide({ balls: appState.balls, dragState, isMoving: appState.isMoving }) : null;
    if (cue && guide) {
      drawAimingGuide(cue, guide);
      drawCueStick(cue, guide.direction, guide.stretch);
      drawPowerMeter(cue, guide.direction, guide.stretch);
    }
  }
}

function startGame(mode) {
  appState.gameMode = mode;
  el.lobbyModal.classList.add('hidden');
  el.waitingModal.classList.add('hidden');
  updateUI();
  resize();
}

function finishTurnAuthoritatively() {
  appState.isMoving = false;
  const cue = getCueBall(appState.balls);
  let foul = false;

  if (cue && !cue.active) {
    cue.active = true;
    cue.x = GAME_WIDTH / 2;
    cue.y = GAME_HEIGHT / 2;
    cue.vx = 0;
    cue.vy = 0;
    foul = true;
  }

  appState.currentTurn = appState.currentTurn === 1 ? 2 : 1;
  appState.isFreeBall = foul;
  appState.awaitingAuthoritativeSync = false;
  updateUI();
  draw();

  if (appState.gameMode === 'ai') {
    maybeScheduleAiTurn();
  }
}

function finishMotion() {
  if (appState.gameMode === 'online') {
    if (appState.isHost) {
      finishTurnAuthoritatively();
      appState.activeTransport?.send({
        type: 'state-sync',
        roomCode: appState.currentRoomCode,
        state: exportState(),
      });
    } else {
      appState.isMoving = false;
      appState.awaitingAuthoritativeSync = true;
      updateUI();
      draw();
    }
    return;
  }

  finishTurnAuthoritatively();
}

function physicsLoop() {
  if (!appState.isMoving) {
    return;
  }

  const { stillMoving, pocketed } = advancePhysicsFrame(appState.balls);
  if (pocketed.length) {
    showToast(describePocketedBall(pocketed[pocketed.length - 1]));
  }

  draw();
  if (stillMoving) {
    window.requestAnimationFrame(physicsLoop);
  } else {
    finishMotion();
  }
}

function fireShot(vx, vy, { broadcast = true } = {}) {
  const cue = getCueBall(appState.balls);
  if (!cue || appState.isMoving) {
    return;
  }

  cue.vx = vx;
  cue.vy = vy;
  appState.isMoving = true;
  appState.isFreeBall = false;
  updateUI();

  if (broadcast && appState.gameMode === 'online') {
    appState.activeTransport?.send({
      type: 'shot',
      roomCode: appState.currentRoomCode,
      state: exportState(),
      shot: { vx, vy },
    });
  }

  window.requestAnimationFrame(physicsLoop);
}

function maybeScheduleAiTurn() {
  window.clearTimeout(appState.aiTurnTimer);
  appState.aiThinking = false;

  if (appState.gameMode !== 'ai' || appState.currentTurn !== 2 || appState.isMoving) {
    updateUI();
    return;
  }

  appState.aiThinking = true;
  updateUI();

  appState.aiTurnTimer = window.setTimeout(() => {
    if (appState.gameMode !== 'ai' || appState.currentTurn !== 2 || appState.isMoving) {
      appState.aiThinking = false;
      updateUI();
      return;
    }

    const plan = chooseAiPlan({
      balls: appState.balls,
      isFreeBall: appState.isFreeBall,
      role: 2,
    });
    const cue = getCueBall(appState.balls);
    if (!cue || !plan) {
      appState.aiThinking = false;
      updateUI();
      return;
    }

    if (plan.cuePosition) {
      setCuePosition(appState.balls, plan.cuePosition.x, plan.cuePosition.y);
      draw();
    }

    window.setTimeout(() => {
      const activeCue = getCueBall(appState.balls);
      if (!activeCue) {
        return;
      }
      appState.aiThinking = false;
      const aim = plan.aimPoint || { x: activeCue.x + 120, y: activeCue.y };
      const vector = normalize(aim.x - activeCue.x, aim.y - activeCue.y) || { x: 1, y: 0 };
      const jitter = rotate(vector, (Math.random() - 0.5) * 0.12);
      fireShot(jitter.x * plan.power, jitter.y * plan.power, { broadcast: false });
    }, plan.cuePosition ? 320 : 140);
  }, appState.isFreeBall ? 900 : 760);
}

function handlePointerStart(event) {
  if (!humanCanAct()) {
    return;
  }

  const cue = getCueBall(appState.balls);
  if (!cue) {
    return;
  }

  const pos = getPointerPosition(event);
  dragState.active = true;
  dragState.startX = pos.x;
  dragState.startY = pos.y;
  dragState.currentX = pos.x;
  dragState.currentY = pos.y;
  dragState.mode = 'shoot';

  if (appState.isFreeBall) {
    const dx = pos.x - cue.x;
    const dy = pos.y - cue.y;
    if (magnitude(dx, dy) < BALL_RADIUS * 3) {
      dragState.mode = 'place';
    }
  }

  draw();
}

function handlePointerMove(event) {
  if (!dragState.active) {
    return;
  }

  if (event.cancelable) {
    event.preventDefault();
  }

  const pos = getPointerPosition(event);
  dragState.currentX = pos.x;
  dragState.currentY = pos.y;

  if (dragState.mode === 'place') {
    setCuePosition(appState.balls, pos.x, pos.y);
  }

  draw();
}

function handlePointerEnd() {
  if (!dragState.active) {
    return;
  }

  dragState.active = false;
  if (dragState.mode === 'place') {
    draw();
    return;
  }

  const dx = dragState.startX - dragState.currentX;
  const dy = dragState.startY - dragState.currentY;
  const pull = magnitude(dx, dy);
  if (pull <= 12) {
    draw();
    return;
  }

  const direction = normalize(dx, dy);
  if (!direction) {
    draw();
    return;
  }

  const power = clamp(pull * 0.25, 0, 45);
  fireShot(direction.x * power, direction.y * power);
}

function refreshWaitingModal({
  title = el.waitingTitle.textContent,
  copy = el.waitingCopy.textContent,
  roomCode = appState.currentRoomCode || appState.waitingMeta?.roomCode || '----',
  roomName = appState.currentRoomName || appState.waitingMeta?.roomName || DEFAULT_ROOM_NAME,
  hostIp = formatEndpointLabel(appState.waitingMeta?.hostIp, appState.waitingMeta?.port),
} = {}) {
  el.waitingTitle.textContent = title;
  el.waitingCopy.textContent = copy;
  el.waitingRoomId.textContent = roomCode || '----';
  el.waitingRoomName.textContent = roomName || DEFAULT_ROOM_NAME;
  el.waitingHostIp.textContent = hostIp || '--';
}

function showWaitingModal(options = {}) {
  refreshWaitingModal(options);
  el.waitingModal.classList.remove('hidden');
}

function hideWaitingModal() {
  el.waitingModal.classList.add('hidden');
}

function buildShareText() {
  const lines = [`${APP_NAME_ZH} | ${APP_NAME_EN}`];
  if (appState.currentRoomName) {
    lines.push(`房间名：${appState.currentRoomName}`);
  }
  if (appState.currentRoomCode) {
    lines.push(`房号：${appState.currentRoomCode}`);
  }

  if (appState.activeTransport === lanTransport) {
    const hostIp = appState.waitingMeta?.hostIp;
    const port = appState.waitingMeta?.port;
    if (hostIp) {
      lines.push(`局域网地址：${formatEndpointLabel(hostIp, port)}`);
    }
    lines.push('让另一台安卓手机连接同一个 Wi-Fi 或热点后，打开 APK，点击“扫描附近房间”即可加入。');
    return lines.join('\n');
  }

  const relayUrl = getEffectiveRelayUrl();
  const autoRelayUrl = deriveAutoRelayUrl();
  const shareUrl =
    appState.currentRoomCode && relayUrl && autoRelayUrl && relayUrl === autoRelayUrl && isHostedWebPage()
      ? (() => {
          const url = new URL(window.location.href);
          url.searchParams.set('room', appState.currentRoomCode);
          return url.toString();
        })()
      : '';

  if (shareUrl) {
    lines.push(`网页加入链接：${shareUrl}`);
  } else if (relayUrl) {
    lines.push(`中继服务器：${relayUrl}`);
  }
  return lines.join('\n');
}

async function shareRoomInfo() {
  if (!appState.currentRoomCode) {
    return;
  }

  const text = buildShareText();
  try {
    if (navigator.share) {
      await navigator.share({
        title: `${APP_NAME_ZH} 房间`,
        text,
      });
      return;
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      return;
    }
  }

  try {
    await navigator.clipboard.writeText(text);
    showToast('房间信息已复制');
  } catch {
    showToast(text);
  }
}

async function stopLanDiscovery({ clearRooms = false } = {}) {
  if (!isNativeAndroidApp()) {
    return;
  }
  await lanTransport.stopDiscovery();
  appState.scanActive = false;
  if (clearRooms) {
    appState.discoveredRooms = [];
    renderRoomList();
  }
}

async function cleanupOnlineSession({ notify = true } = {}) {
  window.clearTimeout(appState.aiTurnTimer);

  const transport = appState.activeTransport;
  if (!transport) {
    appState.currentRoomCode = '';
    appState.currentRoomName = DEFAULT_ROOM_NAME;
    appState.isHost = false;
    appState.awaitingAuthoritativeSync = false;
    appState.waitingMeta = null;
    return;
  }

  const roomCode = appState.currentRoomCode;
  const shouldStopHost = transport === lanTransport;
  appState.activeTransport = null;
  appState.currentRoomCode = '';
  appState.currentRoomName = DEFAULT_ROOM_NAME;
  appState.isHost = false;
  appState.awaitingAuthoritativeSync = false;
  appState.waitingMeta = null;

  try {
    await transport.disconnect({ notify, roomCode });
  } catch {}

  if (shouldStopHost) {
    await lanTransport.stopHosting();
  }
}

async function returnToLobby(message, notifyServer = false) {
  await cleanupOnlineSession({ notify: notifyServer });
  resetRack();
  appState.gameMode = 'single';
  appState.playerRole = 1;
  hideWaitingModal();
  el.lobbyModal.classList.remove('hidden');
  setRoomLabel('单机练习');
  updateNetworkStatus(appState.scanActive ? '正在扫描附近房间' : '待命', 'neutral');
  updateUI();
  draw();
  if (message) {
    showToast(message);
  }
}

async function prepareOnlineSession({ transport, isHost, roomCode = '', roomName = DEFAULT_ROOM_NAME }) {
  await cleanupOnlineSession({ notify: true });
  resetRack();
  appState.activeTransport = transport;
  appState.isHost = isHost;
  appState.playerRole = isHost ? 1 : 2;
  appState.gameMode = 'online';
  appState.currentRoomCode = roomCode;
  appState.currentRoomName = roomName;
  appState.waitingMeta = {
    roomCode,
    roomName,
  };
}

async function startPractice() {
  await stopLanDiscovery();
  await cleanupOnlineSession({ notify: true });
  resetRack();
  setRoomLabel('练习模式');
  updateNetworkStatus('练习模式已就绪', 'neutral');
  startGame('single');
}

async function startAiBattle() {
  await stopLanDiscovery();
  await cleanupOnlineSession({ notify: true });
  resetRack();
  appState.playerRole = 1;
  setRoomLabel('AI 对战');
  updateNetworkStatus('AI 对战已就绪', 'neutral');
  startGame('ai');
  maybeScheduleAiTurn();
}

async function createLanRoom() {
  if (!isNativeAndroidApp()) {
    showToast('同 Wi-Fi 直连只在 Android APK 里提供');
    return;
  }

  await stopLanDiscovery({ clearRooms: true });
  const roomName = getCurrentRoomName();
  await prepareOnlineSession({
    transport: lanTransport,
    isHost: true,
    roomName,
  });

  showWaitingModal({
    title: '正在广播局域网房间',
    copy: '请让另一台安卓手机连上同一个 Wi-Fi 或热点，然后点击“扫描附近房间”。',
    roomCode: '----',
    roomName,
    hostIp: '正在获取...',
  });
  updateNetworkStatus('正在广播局域网房间...', 'pending');

  try {
    const meta = await lanTransport.startHosting({ roomName });
    appState.currentRoomCode = meta.roomCode;
    appState.waitingMeta = { ...meta, roomName };
    el.inputManualRoom.value = meta.roomCode;
    refreshWaitingModal({
      roomCode: meta.roomCode,
      roomName,
      hostIp: formatEndpointLabel(meta.hostIp, meta.port),
    });
    await lanTransport.createRoom({ state: exportState() });
  } catch {
    await returnToLobby('创建局域网房间失败，请检查网络权限或重试');
  }
}

async function startLanScan() {
  if (!isNativeAndroidApp()) {
    return;
  }

  appState.scanActive = true;
  appState.discoveredRooms = [];
  renderRoomList();
  setScanStatus('正在扫描附近房间...');
  updateNetworkStatus('正在扫描附近房间', 'pending');

  try {
    const rooms = await lanTransport.startDiscovery();
    if (rooms.length) {
      setScanStatus(`已扫描到 ${rooms.length} 个房间，点选即可加入。`);
      updateNetworkStatus('已扫描到附近房间', 'ok');
    } else {
      setScanStatus('还没有扫描到房间，请确认房主已经创建局域网房间。');
      updateNetworkStatus('正在等待附近房间出现', 'warning');
    }
  } catch {
    appState.scanActive = false;
    setScanStatus('扫描失败，请确认本机已连上 Wi-Fi 或热点。');
    updateNetworkStatus('局域网扫描失败', 'error');
  }
}

async function joinLanRoom(room) {
  await stopLanDiscovery();
  await prepareOnlineSession({
    transport: lanTransport,
    isHost: false,
    roomCode: room.roomCode,
    roomName: room.roomName,
  });

  appState.waitingMeta = room;
  showWaitingModal({
    title: '正在加入局域网房间',
    copy: '已找到房主，正在连接球桌服务。',
    roomCode: room.roomCode,
    roomName: room.roomName,
    hostIp: formatEndpointLabel(room.hostIp, room.port),
  });
  updateNetworkStatus('正在加入局域网房间...', 'pending');

  try {
    await lanTransport.joinRoom(room);
  } catch {
    await returnToLobby('加入局域网房间失败，请确认房主仍在线');
  }
}

async function joinLanManual() {
  const roomCode = el.inputManualRoom.value.trim();
  const hostIp = el.inputManualIp.value.trim();

  if (!ROOM_CODE_PATTERN.test(roomCode)) {
    showToast('请输入 4 位房号');
    return;
  }
  if (!hostIp) {
    showToast('请先输入主机 IP');
    return;
  }

  await stopLanDiscovery();
  await prepareOnlineSession({
    transport: lanTransport,
    isHost: false,
    roomCode,
    roomName: '手动输入房间',
  });

  appState.waitingMeta = {
    roomCode,
    roomName: '手动输入房间',
    hostIp,
    port: 8787,
  };
  showWaitingModal({
    title: '正在按 IP 加入房间',
    copy: '正在尝试连接房主手机上的局域网球桌服务。',
    roomCode,
    roomName: '手动输入房间',
    hostIp: formatEndpointLabel(hostIp, 8787),
  });
  updateNetworkStatus('正在连接主机 IP...', 'pending');

  try {
    await lanTransport.joinByIp({ hostIp, roomCode });
  } catch {
    await returnToLobby('按 IP 加入失败，请确认主机地址和房号都正确');
  }
}

async function createRelayRoom() {
  await stopLanDiscovery();
  await prepareOnlineSession({
    transport: relayTransport,
    isHost: true,
    roomName: DEFAULT_ROOM_NAME,
  });

  showWaitingModal({
    title: '正在创建网页中继房间',
    copy: '正在连接网页房间服务，请稍等。',
    roomCode: '----',
    roomName: DEFAULT_ROOM_NAME,
    hostIp: '中继模式',
  });
  updateNetworkStatus('正在连接网页房间服务...', 'pending');

  try {
    await relayTransport.createRoom({ state: exportState() });
  } catch (error) {
    await returnToLobby(error.message === 'missing-relay-url' ? '请先填写网页中继服务器地址' : '网页房间创建失败');
  }
}

async function joinRelayRoom() {
  const roomCode = el.inputRelayRoom.value.trim();
  if (!ROOM_CODE_PATTERN.test(roomCode)) {
    showToast('请输入 4 位房号');
    return;
  }

  await stopLanDiscovery();
  await prepareOnlineSession({
    transport: relayTransport,
    isHost: false,
    roomCode,
    roomName: DEFAULT_ROOM_NAME,
  });

  showWaitingModal({
    title: '正在加入网页房间',
    copy: '正在连接网页中继服务。',
    roomCode,
    roomName: DEFAULT_ROOM_NAME,
    hostIp: '中继模式',
  });
  updateNetworkStatus('正在连接网页房间服务...', 'pending');

  try {
    await relayTransport.joinRoom({ roomCode });
  } catch (error) {
    await returnToLobby(error.message === 'missing-relay-url' ? '请先填写网页中继服务器地址' : '网页房间连接失败');
  }
}

function saveRelayServer() {
  const normalized = normalizeRelayUrl(el.inputRelayServer.value);
  if (!normalized) {
    showToast('服务器地址格式不正确');
    return;
  }
  writeStoredRelayUrl(normalized);
  populateRelayInput();
  refreshRelayUi();
  showToast('中继服务器已保存');
}

function resetRelayServer() {
  writeStoredRelayUrl('');
  populateRelayInput();
  refreshRelayUi();
  showToast(deriveAutoRelayUrl() ? '已恢复自动检测' : '已清空中继服务器地址');
}

function handleTransportMessage(message) {
  switch (message.type) {
    case 'room-created':
      appState.currentRoomCode = message.roomCode;
      appState.isHost = true;
      appState.playerRole = message.role || 1;
      appState.waitingMeta = {
        ...appState.waitingMeta,
        roomCode: message.roomCode,
      };
      el.inputManualRoom.value = message.roomCode;
      setRoomLabel(`房号 ${appState.currentRoomCode}`);
      refreshWaitingModal({ roomCode: appState.currentRoomCode });
      updateNetworkStatus(appState.activeTransport === lanTransport ? '局域网房间已创建，等待加入' : '网页房间已创建，等待加入', 'ok');
      break;
    case 'room-ready':
      appState.currentRoomCode = message.roomCode;
      appState.playerRole = message.role || appState.playerRole;
      appState.isHost = appState.playerRole === 1;
      appState.waitingMeta = {
        ...appState.waitingMeta,
        roomCode: message.roomCode,
      };
      setRoomLabel(`房号 ${appState.currentRoomCode}`);
      startGame('online');
      applyImportedState(message.state || exportState());
      updateNetworkStatus(appState.activeTransport === lanTransport ? '局域网对战已连接' : '网页对战已连接', 'ok');
      showToast(appState.isHost ? '对手已加入，可以开球了' : '已成功加入房间');
      break;
    case 'room-full':
      void returnToLobby('该房间已经满员');
      break;
    case 'room-missing':
      void returnToLobby(appState.activeTransport === lanTransport ? '房间不存在，请确认房主还在广播' : '房间不存在');
      break;
    case 'room-closed':
      void returnToLobby(appState.activeTransport === lanTransport ? '房主已关闭局域网房间' : '房主已关闭房间');
      break;
    case 'player-left':
      void returnToLobby('对方已离开房间');
      break;
    case 'shot':
      if (message.state) {
        const imported = importGameState(message.state);
        appState.balls = imported.balls;
        appState.currentTurn = imported.currentTurn;
        appState.isFreeBall = false;
      }
      updateUI();
      draw();
      fireShot(message.shot.vx, message.shot.vy, { broadcast: false });
      break;
    case 'state-sync':
      applyImportedState(message.state);
      updateNetworkStatus('球桌状态已同步', 'ok');
      break;
    case 'error':
      showToast(message.message || '联机出现异常');
      updateNetworkStatus(message.message || '联机出现异常', 'error');
      break;
    default:
      break;
  }
}

function handleTransportDisconnect(payload) {
  if (appState.gameMode === 'online' || !el.waitingModal.classList.contains('hidden')) {
    void returnToLobby(payload.message || '房间连接已断开');
  } else {
    updateNetworkStatus(payload.message || '房间连接已断开', 'error');
  }
}

function handleLanRoomsUpdated(rooms) {
  appState.discoveredRooms = rooms;
  renderRoomList();
  if (appState.scanActive) {
    if (rooms.length) {
      setScanStatus(`已扫描到 ${rooms.length} 个房间，点选即可加入。`);
      updateNetworkStatus('已扫描到附近房间', 'ok');
    } else {
      setScanStatus('正在扫描中，还没发现房主。');
    }
  }
}

function handleLanHostStatus(payload) {
  if (payload?.roomCode) {
    appState.currentRoomCode = payload.roomCode;
    el.inputManualRoom.value = payload.roomCode;
  }
  if (payload?.hostIp || payload?.port || payload?.roomName) {
    appState.waitingMeta = {
      ...appState.waitingMeta,
      ...payload,
    };
    refreshWaitingModal({
      roomCode: payload.roomCode || appState.currentRoomCode,
      roomName: payload.roomName || appState.currentRoomName,
      hostIp: formatEndpointLabel(payload.hostIp || appState.waitingMeta?.hostIp, payload.port || appState.waitingMeta?.port),
    });
  }

  if (payload?.status === 'hosting') {
    updateNetworkStatus('局域网房间已广播', 'ok');
  }
  if (payload?.status === 'error') {
    updateNetworkStatus(payload.message || '局域网房间异常', 'error');
    if (appState.activeTransport === lanTransport) {
      void returnToLobby(payload.message || '局域网房间异常');
    }
  }
}

function renderRoomList() {
  el.roomList.textContent = '';

  if (!appState.discoveredRooms.length) {
    const empty = document.createElement('div');
    empty.className = 'room-list-empty';
    empty.textContent = appState.scanActive
      ? '正在等待附近房间出现。房主建房后会自动出现在这里。'
      : '还没有扫描结果。点击“扫描附近房间”开始搜索房主。';
    el.roomList.appendChild(empty);
    return;
  }

  for (const room of appState.discoveredRooms) {
    const card = document.createElement('div');
    card.className = 'room-item';

    const top = document.createElement('div');
    top.className = 'room-item-top';

    const title = document.createElement('div');
    title.className = 'room-item-title';
    title.textContent = room.roomName;

    const code = document.createElement('div');
    code.className = 'room-item-code';
    code.textContent = room.roomCode;

    top.appendChild(title);
    top.appendChild(code);

    const meta = document.createElement('div');
    meta.className = 'room-item-meta';

    const device = document.createElement('div');
    device.textContent = `设备：${room.deviceName}`;
    const endpoint = document.createElement('div');
    endpoint.textContent = `地址：${formatEndpointLabel(room.hostIp, room.port)}`;
    const status = document.createElement('div');
    status.textContent = `状态：${room.connectionStatus === 'available' ? '可加入' : room.connectionStatus}`;

    meta.appendChild(device);
    meta.appendChild(endpoint);
    meta.appendChild(status);

    const joinButton = document.createElement('button');
    joinButton.type = 'button';
    joinButton.className = 'primary-button';
    joinButton.textContent = '加入这个房间';
    joinButton.addEventListener('click', () => {
      void joinLanRoom(room);
    });

    card.appendChild(top);
    card.appendChild(meta);
    card.appendChild(joinButton);
    el.roomList.appendChild(card);
  }
}

function isStandaloneDisplay() {
  return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone;
}

function refreshInstallUi() {
  if (isNativeAndroidApp()) {
    return;
  }

  if (isStandaloneDisplay()) {
    el.btnInstallPwa.disabled = true;
    el.installNote.textContent = '网页版已经安装到主屏幕，可以离线继续练习和打 AI。';
    return;
  }

  if (appState.installPrompt) {
    el.btnInstallPwa.disabled = false;
    el.installNote.textContent = '支持的浏览器会直接弹出安装提示。';
    return;
  }

  el.btnInstallPwa.disabled = false;
  el.installNote.textContent = '如果没有自动弹窗，也可以用浏览器菜单里的“安装应用”或“添加到主屏幕”。';
}

async function installPwa() {
  if (isNativeAndroidApp()) {
    return;
  }

  if (appState.installPrompt) {
    const promptEvent = appState.installPrompt;
    promptEvent.prompt();
    await promptEvent.userChoice.catch(() => null);
    appState.installPrompt = null;
    refreshInstallUi();
    return;
  }

  showToast('请使用浏览器菜单里的“安装应用”或“添加到主屏幕”');
}

function applyPlatformUi() {
  document.body.dataset.platform = isNativeAndroidApp() ? 'android' : 'web';
  el.nativeLanPanel.classList.toggle('hidden', !isNativeAndroidApp());
  el.pwaPanel.classList.toggle('hidden', isNativeAndroidApp());
  el.relayPanel.open = !isNativeAndroidApp();
  refreshInstallUi();
}

async function forceLandscape() {
  const root = document.documentElement;
  try {
    if (root.requestFullscreen) {
      await root.requestFullscreen();
    } else if (root.webkitRequestFullscreen) {
      root.webkitRequestFullscreen();
    }
    if (screen.orientation?.lock) {
      await screen.orientation.lock('landscape');
    }
  } catch {}
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    return;
  }
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
  });
}

function maybeJoinRoomFromUrl() {
  if (isNativeAndroidApp()) {
    return;
  }

  const roomCode = new URL(window.location.href).searchParams.get('room');
  if (!roomCode || !ROOM_CODE_PATTERN.test(roomCode)) {
    return;
  }
  el.inputRelayRoom.value = roomCode;
  if (getEffectiveRelayUrl()) {
    window.setTimeout(() => {
      if (!el.lobbyModal.classList.contains('hidden')) {
        void joinRelayRoom();
      }
    }, 360);
  }
}

function bindEvents() {
  el.btnBack.addEventListener('click', () => {
    void returnToLobby('已返回大厅', true);
  });
  el.btnSingle.addEventListener('click', () => {
    void startPractice();
  });
  el.btnAi.addEventListener('click', () => {
    void startAiBattle();
  });
  el.btnHostLan.addEventListener('click', () => {
    void createLanRoom();
  });
  el.btnScanLan.addEventListener('click', () => {
    void startLanScan();
  });
  el.btnJoinManual.addEventListener('click', () => {
    void joinLanManual();
  });
  el.btnInstallPwa.addEventListener('click', () => {
    void installPwa();
  });
  el.btnCreateRelay.addEventListener('click', () => {
    void createRelayRoom();
  });
  el.btnJoinRelay.addEventListener('click', () => {
    void joinRelayRoom();
  });
  el.btnSaveRelay.addEventListener('click', saveRelayServer);
  el.btnResetRelay.addEventListener('click', resetRelayServer);
  el.btnShareRoom.addEventListener('click', () => {
    void shareRoomInfo();
  });
  el.btnCancelWaiting.addEventListener('click', () => {
    void returnToLobby('已取消等待', true);
  });
  el.btnForceLandscape.addEventListener('click', () => {
    void forceLandscape();
  });
  el.waitingRoomId.addEventListener('click', () => {
    void shareRoomInfo();
  });

  el.inputRelayRoom.addEventListener('input', () => {
    el.inputRelayRoom.value = el.inputRelayRoom.value.replace(/\D+/g, '').slice(0, 4);
  });
  el.inputManualRoom.addEventListener('input', () => {
    el.inputManualRoom.value = el.inputManualRoom.value.replace(/\D+/g, '').slice(0, 4);
  });

  el.inputRelayRoom.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      void joinRelayRoom();
    }
  });
  el.inputManualRoom.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      void joinLanManual();
    }
  });
  el.inputManualIp.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      void joinLanManual();
    }
  });
  el.inputRelayServer.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      saveRelayServer();
    }
  });

  el.canvas.addEventListener('touchstart', handlePointerStart, { passive: false });
  window.addEventListener('touchmove', handlePointerMove, { passive: false });
  window.addEventListener('touchend', handlePointerEnd);
  el.canvas.addEventListener('mousedown', handlePointerStart);
  window.addEventListener('mousemove', handlePointerMove);
  window.addEventListener('mouseup', handlePointerEnd);
  window.addEventListener('resize', resize);
  window.addEventListener('beforeunload', () => {
    void cleanupOnlineSession({ notify: true });
  });

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    appState.installPrompt = event;
    refreshInstallUi();
  });
  window.addEventListener('appinstalled', () => {
    appState.installPrompt = null;
    refreshInstallUi();
    showToast('网页版本已安装到主屏幕');
  });
}

function bootstrap() {
  resetRack();
  renderRoomList();
  bindEvents();
  populateRelayInput();
  refreshRelayUi();
  applyPlatformUi();
  updateNetworkStatus(isNativeAndroidApp() ? '等待创建或扫描局域网房间' : '待命', 'neutral');
  updateUI();
  resize();
  registerServiceWorker();
  maybeJoinRoomFromUrl();

  relayTransport.setHandlers({
    onMessage: handleTransportMessage,
    onStatus: ({ message, tone }) => updateNetworkStatus(message, tone),
    onDisconnect: handleTransportDisconnect,
  });

  lanTransport.setHandlers({
    onMessage: handleTransportMessage,
    onStatus: ({ message, tone }) => updateNetworkStatus(message, tone),
    onDisconnect: handleTransportDisconnect,
    onRoomsUpdated: handleLanRoomsUpdated,
    onHostStatus: handleLanHostStatus,
  });
}

bootstrap();
