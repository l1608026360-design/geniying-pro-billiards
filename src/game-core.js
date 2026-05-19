export const GAME_WIDTH = 1000;
export const GAME_HEIGHT = 500;
export const BALL_RADIUS = 14;
export const POCKET_RADIUS = 26;
export const FRICTION = 0.988;
export const RESTITUTION = 0.85;
export const INITIAL_CUE_POS = { x: GAME_WIDTH * 0.25, y: GAME_HEIGHT / 2 };
export const ROOM_CODE_PATTERN = /^\d{4}$/;
export const POCKETS = [
  { x: 0, y: 0 },
  { x: GAME_WIDTH / 2, y: -5 },
  { x: GAME_WIDTH, y: 0 },
  { x: 0, y: GAME_HEIGHT },
  { x: GAME_WIDTH / 2, y: GAME_HEIGHT + 5 },
  { x: GAME_WIDTH, y: GAME_HEIGHT },
];

export const BALL_COLORS = {
  0: '#ffffff',
  1: '#facc15',
  2: '#2563eb',
  3: '#ef4444',
  4: '#7c3aed',
  5: '#f97316',
  6: '#16a34a',
  7: '#7f1d1d',
  8: '#0f172a',
  9: '#facc15',
  10: '#2563eb',
  11: '#ef4444',
  12: '#7c3aed',
  13: '#f97316',
  14: '#16a34a',
  15: '#7f1d1d',
};

export function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function magnitude(x, y) {
  return Math.hypot(x, y);
}

export function normalize(x, y) {
  const length = magnitude(x, y);
  if (!length) {
    return null;
  }
  return { x: x / length, y: y / length };
}

export function distance(a, b) {
  return magnitude(a.x - b.x, a.y - b.y);
}

export function rotate(vector, radians) {
  return {
    x: vector.x * Math.cos(radians) - vector.y * Math.sin(radians),
    y: vector.x * Math.sin(radians) + vector.y * Math.cos(radians),
  };
}

export function createBalls() {
  const balls = [{ id: 0, type: 'cue', x: INITIAL_CUE_POS.x, y: INITIAL_CUE_POS.y, vx: 0, vy: 0, active: true }];
  const startX = GAME_WIDTH * 0.7;
  const startY = GAME_HEIGHT / 2;
  const rowSpacing = BALL_RADIUS * Math.sqrt(3) + 0.5;
  const colSpacing = BALL_RADIUS * 2 + 0.5;
  const order = [1, 9, 2, 10, 8, 3, 4, 11, 12, 5, 13, 14, 6, 15, 7];
  let index = 0;

  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col <= row; col += 1) {
      const id = order[index];
      index += 1;
      balls.push({
        id,
        type: id === 8 ? '8ball' : id < 8 ? 'solid' : 'stripe',
        x: startX + row * rowSpacing,
        y: startY - (row * colSpacing) / 2 + col * colSpacing,
        vx: 0,
        vy: 0,
        active: true,
      });
    }
  }

  return balls;
}

export function getCueBall(balls) {
  return balls.find((ball) => ball.id === 0);
}

export function getPlayerType(role) {
  return role === 1 ? 'solid' : 'stripe';
}

export function getTargetBallsForRole(balls, role) {
  const type = getPlayerType(role);
  const targets = balls.filter((ball) => ball.active && ball.type === type);
  if (targets.length) {
    return targets;
  }
  const eightBall = balls.find((ball) => ball.id === 8 && ball.active);
  return eightBall ? [eightBall] : balls.filter((ball) => ball.active && ball.id !== 0);
}

export function exportGameState({ balls, currentTurn, isFreeBall, playerRoles, scored, fouls, gameResult }) {
  return {
    balls: deepClone(balls),
    turn: currentTurn,
    isFreeBall,
    playerRoles: playerRoles || { 1: 'unassigned', 2: 'unassigned' },
    scored: scored || { 1: [], 2: [] },
    fouls: fouls || { 1: 0, 2: 0 },
    gameResult: gameResult || null,
  };
}

export function importGameState(rawState) {
  return {
    balls: deepClone(rawState?.balls || createBalls()),
    currentTurn: rawState?.turn === 2 ? 2 : 1,
    isFreeBall: Boolean(rawState?.isFreeBall),
    playerRoles: rawState?.playerRoles || { 1: 'unassigned', 2: 'unassigned' },
    scored: rawState?.scored || { 1: [], 2: [] },
    fouls: rawState?.fouls || { 1: 0, 2: 0 },
    gameResult: rawState?.gameResult || null,
  };
}

export function setCuePosition(balls, x, y) {
  const cue = getCueBall(balls);
  if (!cue) {
    return null;
  }

  let nextX = clamp(x, BALL_RADIUS, GAME_WIDTH - BALL_RADIUS);
  let nextY = clamp(y, BALL_RADIUS, GAME_HEIGHT - BALL_RADIUS);

  for (const ball of balls) {
    if (!ball.active || ball.id === 0) {
      continue;
    }
    const dx = nextX - ball.x;
    const dy = nextY - ball.y;
    const dist = magnitude(dx, dy);
    if (dist && dist < BALL_RADIUS * 2.05) {
      const angle = Math.atan2(dy, dx);
      nextX = ball.x + Math.cos(angle) * (BALL_RADIUS * 2.08);
      nextY = ball.y + Math.sin(angle) * (BALL_RADIUS * 2.08);
    }
  }

  cue.active = true;
  cue.vx = 0;
  cue.vy = 0;
  cue.x = clamp(nextX, BALL_RADIUS, GAME_WIDTH - BALL_RADIUS);
  cue.y = clamp(nextY, BALL_RADIUS, GAME_HEIGHT - BALL_RADIUS);
  return cue;
}

function projectToTableEdge(startX, startY, dirX, dirY) {
  const direction = normalize(dirX, dirY);
  if (!direction) {
    return null;
  }

  const candidates = [];
  if (direction.x !== 0) {
    const tx = direction.x > 0 ? (GAME_WIDTH - BALL_RADIUS - startX) / direction.x : (BALL_RADIUS - startX) / direction.x;
    if (tx > 0) {
      candidates.push(tx);
    }
  }

  if (direction.y !== 0) {
    const ty =
      direction.y > 0
        ? (GAME_HEIGHT - BALL_RADIUS - startY) / direction.y
        : (BALL_RADIUS - startY) / direction.y;
    if (ty > 0) {
      candidates.push(ty);
    }
  }

  if (!candidates.length) {
    return null;
  }

  const distanceToEdge = Math.min(...candidates, 260);
  return {
    x: startX + direction.x * distanceToEdge,
    y: startY + direction.y * distanceToEdge,
  };
}

export function getAimingGuide({ balls, dragState, isMoving }) {
  if (!dragState.active || dragState.mode !== 'shoot' || isMoving) {
    return null;
  }

  const cue = getCueBall(balls);
  if (!cue || !cue.active) {
    return null;
  }

  const dx = dragState.startX - dragState.currentX;
  const dy = dragState.startY - dragState.currentY;
  const stretch = magnitude(dx, dy);
  if (stretch <= 8) {
    return null;
  }

  const direction = normalize(dx, dy);
  if (!direction) {
    return null;
  }

  let nearestHit = null;
  for (const ball of balls) {
    if (!ball.active || ball.id === 0) {
      continue;
    }

    const cueToBallX = ball.x - cue.x;
    const cueToBallY = ball.y - cue.y;
    const projection = cueToBallX * direction.x + cueToBallY * direction.y;
    if (projection <= BALL_RADIUS * 2) {
      continue;
    }

    const closestX = cue.x + direction.x * projection;
    const closestY = cue.y + direction.y * projection;
    const distanceToLine = magnitude(ball.x - closestX, ball.y - closestY);
    if (distanceToLine > BALL_RADIUS * 2) {
      continue;
    }

    const offset = Math.sqrt((BALL_RADIUS * 2) ** 2 - distanceToLine ** 2);
    const distanceToContact = projection - offset;
    if (distanceToContact <= 0) {
      continue;
    }

    if (!nearestHit || distanceToContact < nearestHit.distanceToContact) {
      const contactPoint = {
        x: cue.x + direction.x * distanceToContact,
        y: cue.y + direction.y * distanceToContact,
      };
      const normal = normalize(ball.x - contactPoint.x, ball.y - contactPoint.y);
      if (!normal) {
        continue;
      }
      nearestHit = {
        ball,
        contactPoint,
        normal,
        distanceToContact,
      };
    }
  }

  if (!nearestHit) {
    return {
      direction,
      stretch,
      aimEnd: projectToTableEdge(cue.x, cue.y, direction.x, direction.y) || {
        x: cue.x + direction.x * 800,
        y: cue.y + direction.y * 800,
      },
    };
  }

  const incomingDot = direction.x * nearestHit.normal.x + direction.y * nearestHit.normal.y;
  const tangent = normalize(
    direction.x - incomingDot * nearestHit.normal.x,
    direction.y - incomingDot * nearestHit.normal.y,
  );

  return {
    direction,
    stretch,
    hit: nearestHit,
    objectPath: projectToTableEdge(
      nearestHit.ball.x,
      nearestHit.ball.y,
      nearestHit.normal.x,
      nearestHit.normal.y,
    ),
    cueDeflection: tangent
      ? projectToTableEdge(nearestHit.contactPoint.x, nearestHit.contactPoint.y, tangent.x, tangent.y)
      : null,
  };
}

function overlapsOtherBalls(balls, x, y, ignoreId = 0) {
  return balls.some((ball) => {
    if (!ball.active || ball.id === ignoreId) {
      return false;
    }
    return magnitude(x - ball.x, y - ball.y) < BALL_RADIUS * 2.02;
  });
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const abSquared = abx * abx + aby * aby;
  if (!abSquared) {
    return magnitude(px - ax, py - ay);
  }
  const t = clamp(((px - ax) * abx + (py - ay) * aby) / abSquared, 0, 1);
  const closestX = ax + abx * t;
  const closestY = ay + aby * t;
  return magnitude(px - closestX, py - closestY);
}

function pathBlocked(balls, start, end, ignoredIds = []) {
  return balls.some((ball) => {
    if (!ball.active || ignoredIds.includes(ball.id)) {
      return false;
    }
    return distanceToSegment(ball.x, ball.y, start.x, start.y, end.x, end.y) < BALL_RADIUS * 2.05;
  });
}

function pickCuePlacementForAi(balls, ghost, target) {
  const cue = getCueBall(balls);
  const candidates = [];
  const forward = normalize(target.x - ghost.x, target.y - ghost.y) || { x: 1, y: 0 };
  const fallbacks = [120, 160, 210];

  for (const distanceValue of fallbacks) {
    candidates.push({
      x: ghost.x - forward.x * distanceValue,
      y: ghost.y - forward.y * distanceValue,
    });
  }

  candidates.push({
    x: clamp(cue?.x ?? INITIAL_CUE_POS.x, BALL_RADIUS, GAME_WIDTH - BALL_RADIUS),
    y: clamp(cue?.y ?? INITIAL_CUE_POS.y, BALL_RADIUS, GAME_HEIGHT - BALL_RADIUS),
  });

  for (const candidate of candidates) {
    const x = clamp(candidate.x, BALL_RADIUS, GAME_WIDTH - BALL_RADIUS);
    const y = clamp(candidate.y, BALL_RADIUS, GAME_HEIGHT - BALL_RADIUS);
    if (!overlapsOtherBalls(balls, x, y)) {
      return { x, y };
    }
  }

  return null;
}

export function chooseAiPlan({ balls, isFreeBall, role = 2 }) {
  const cue = getCueBall(balls);
  if (!cue || !cue.active) {
    return null;
  }

  const targets = getTargetBallsForRole(balls, role);
  let bestPlan = null;

  for (const target of targets) {
    for (const pocket of POCKETS) {
      const toPocket = normalize(pocket.x - target.x, pocket.y - target.y);
      if (!toPocket) {
        continue;
      }

      const ghost = {
        x: target.x - toPocket.x * BALL_RADIUS * 2.05,
        y: target.y - toPocket.y * BALL_RADIUS * 2.05,
      };

      if (
        ghost.x <= BALL_RADIUS ||
        ghost.x >= GAME_WIDTH - BALL_RADIUS ||
        ghost.y <= BALL_RADIUS ||
        ghost.y >= GAME_HEIGHT - BALL_RADIUS
      ) {
        continue;
      }

      const startPoint = isFreeBall ? pickCuePlacementForAi(balls, ghost, target) : { x: cue.x, y: cue.y };
      if (!startPoint) {
        continue;
      }

      const cueToGhost = distance(startPoint, ghost);
      const objectToPocket = distance(target, pocket);
      const blockedCue = pathBlocked(balls, startPoint, ghost, [0, target.id]);
      const blockedObject = pathBlocked(balls, target, pocket, [0, target.id]);

      let score = 1000;
      score -= cueToGhost * 0.65;
      score -= objectToPocket * 0.45;
      score -= blockedCue ? 300 : 0;
      score -= blockedObject ? 210 : 0;
      score += isFreeBall ? 60 : 0;

      if (!bestPlan || score > bestPlan.score) {
        bestPlan = {
          score,
          cuePosition: isFreeBall ? startPoint : null,
          aimPoint: ghost,
          power: clamp(16 + cueToGhost * 0.04 + objectToPocket * 0.018, 14, 40),
        };
      }
    }
  }

  if (bestPlan) {
    return bestPlan;
  }

  const fallbackTarget = targets[0];
  if (!fallbackTarget) {
    return {
      cuePosition: null,
      aimPoint: { x: cue.x + 120, y: cue.y + 10 },
      power: 20,
    };
  }

  return {
    cuePosition: isFreeBall
      ? {
          x: clamp(fallbackTarget.x - 120, BALL_RADIUS, GAME_WIDTH - BALL_RADIUS),
          y: clamp(fallbackTarget.y, BALL_RADIUS, GAME_HEIGHT - BALL_RADIUS),
        }
      : null,
    aimPoint: { x: fallbackTarget.x, y: fallbackTarget.y },
    power: 22,
  };
}

export function advancePhysicsFrame(balls) {
  let stillMoving = false;
  const pocketed = [];

  for (let step = 0; step < 5; step += 1) {
    for (const ball of balls) {
      if (!ball.active) {
        continue;
      }
      ball.x += ball.vx / 5;
      ball.y += ball.vy / 5;
    }

    for (let i = 0; i < balls.length; i += 1) {
      const b1 = balls[i];
      if (!b1.active) {
        continue;
      }

      if (b1.x - BALL_RADIUS < 0) {
        b1.x = BALL_RADIUS;
        b1.vx *= -RESTITUTION;
      } else if (b1.x + BALL_RADIUS > GAME_WIDTH) {
        b1.x = GAME_WIDTH - BALL_RADIUS;
        b1.vx *= -RESTITUTION;
      }

      if (b1.y - BALL_RADIUS < 0) {
        b1.y = BALL_RADIUS;
        b1.vy *= -RESTITUTION;
      } else if (b1.y + BALL_RADIUS > GAME_HEIGHT) {
        b1.y = GAME_HEIGHT - BALL_RADIUS;
        b1.vy *= -RESTITUTION;
      }

      for (const pocket of POCKETS) {
        if ((b1.x - pocket.x) ** 2 + (b1.y - pocket.y) ** 2 < (POCKET_RADIUS - 4) ** 2) {
          b1.active = false;
          b1.vx = 0;
          b1.vy = 0;
          pocketed.push(b1.id);
          break;
        }
      }

      if (!b1.active) {
        continue;
      }

      for (let j = i + 1; j < balls.length; j += 1) {
        const b2 = balls[j];
        if (!b2.active) {
          continue;
        }

        const dx = b2.x - b1.x;
        const dy = b2.y - b1.y;
        const dist = magnitude(dx, dy);
        if (!dist || dist >= BALL_RADIUS * 2) {
          continue;
        }

        const nx = dx / dist;
        const ny = dy / dist;
        const overlap = BALL_RADIUS * 2 - dist;
        b1.x -= nx * overlap * 0.5;
        b1.y -= ny * overlap * 0.5;
        b2.x += nx * overlap * 0.5;
        b2.y += ny * overlap * 0.5;

        const impulse = nx * (b1.vx - b2.vx) + ny * (b1.vy - b2.vy);
        b1.vx -= impulse * nx;
        b1.vy -= impulse * ny;
        b2.vx += impulse * nx;
        b2.vy += impulse * ny;
      }
    }
  }

  for (const ball of balls) {
    if (!ball.active) {
      continue;
    }
    ball.vx *= FRICTION;
    ball.vy *= FRICTION;
    if (Math.abs(ball.vx) < 0.02 && Math.abs(ball.vy) < 0.02) {
      ball.vx = 0;
      ball.vy = 0;
    } else {
      stillMoving = true;
    }
  }

  return { stillMoving, pocketed };
}

export function describePocketedBall(id) {
  if (id === 0) {
    return '白球落袋，下回合为自由球';
  }
  if (id === 8) {
    return '8 号球落袋';
  }
  return `${id} 号球落袋`;
}

export function isSolid(id) {
  return id >= 1 && id <= 7;
}

export function isStripe(id) {
  return id >= 9 && id <= 15;
}

export function getBallType(id) {
  if (id === 0) return 'cue';
  if (id === 8) return '8ball';
  if (isSolid(id)) return 'solid';
  if (isStripe(id)) return 'stripe';
  return 'unknown';
}

export function hasWon(gameResult) {
  return gameResult !== null;
}

/**
 * Evaluate the result of a completed turn.
 * Returns { foul, isFreeBall, switchTurn, potted, assigned, scored, gameResult }
 *
 * @param {object} state - Current game state
 * @param {number[]} newlyPotted - IDs of balls potted this turn (empty=miss)
 * @param {number} currentTurn - Which player (1 or 2) just shot
 */
export function evaluateTurn({ playerRoles, scored, fouls, currentTurn, balls }, newlyPotted) {
  const role = currentTurn;
  const opponent = role === 1 ? 2 : 1;
  let result = {
    foul: false,
    switchTurn: false,
    isFreeBall: false,
    potted: newlyPotted,
    assigned: null,       // set when a player's type is first determined
    newScored: scored ? { ...scored, [role]: [...(scored[role] || [])] } : { 1: [], 2: [] },
    newFouls: fouls ? { ...fouls } : { 1: 0, 2: 0 },
    gameResult: null,
    newPlayerRoles: playerRoles ? { ...playerRoles } : { 1: 'unassigned', 2: 'unassigned' },
  };

  const cuePotted = newlyPotted.includes(0);
  const eightPotted = newlyPotted.includes(8);
  // Non-8, non-cue potted balls
  const objectBallsPotted = newlyPotted.filter((id) => id !== 0 && id !== 8);
  const roleType = result.newPlayerRoles[role];

  // --- Win / Loss conditions involving 8-ball ---
  if (eightPotted) {
    const roleTargetsRemaining = getRemainingOfType(balls, role, result.newPlayerRoles);
    if (cuePotted || roleTargetsRemaining > 0) {
      // 8-ball potted before all targets are cleared, or with a scratch → LOSS
      result.gameResult = { winner: opponent, reason: 'before-8-foul' };
    } else {
      // All targets cleared, 8-ball potted cleanly → WIN
      result.gameResult = { winner: role, reason: '8ball-potted' };
    }
    result.switchTurn = true;
    result.foul = cuePotted;
    result.isFreeBall = false;
    return result;
  }

  // --- Cue ball foul ---
  if (cuePotted) {
    result.foul = true;
    result.switchTurn = true;
    result.isFreeBall = true;
    result.newFouls[role] += 1;
    return result;
  }

  // --- No ball potted (miss) ---
  if (objectBallsPotted.length === 0) {
    // No ball potted = switch turn, not a foul (in standard bar rules this is just a miss)
    result.switchTurn = true;
    return result;
  }

  // --- Balls were potted ---
  // If type not yet assigned, assign based on first potted ball
  if (roleType === 'unassigned') {
    const firstPottedType = getBallType(objectBallsPotted[0]);
    if (firstPottedType === 'solid' || firstPottedType === 'stripe') {
      result.newPlayerRoles[role] = firstPottedType;
      result.newPlayerRoles[opponent] = firstPottedType === 'solid' ? 'stripe' : 'solid';
      result.assigned = firstPottedType;
    }
  }

  const assignedType = result.newPlayerRoles[role];
  let legalPotted = 0;
  let illegalPotted = 0;

  for (const id of objectBallsPotted) {
    if (getBallType(id) === assignedType) {
      legalPotted += 1;
      result.newScored[role].push(id);
    } else {
      illegalPotted += 1;
    }
  }

  // Foul: potted opponent's ball
  if (illegalPotted > 0 && assignedType !== 'unassigned') {
    result.foul = true;
    result.isFreeBall = true;
    result.newFouls[role] += 1;
    result.switchTurn = true;
    return result;
  }

  // Legal pot: player continues
  result.switchTurn = false;
  return result;
}

function getRemainingOfType(balls, role, playerRoles) {
  const type = playerRoles[role];
  if (!type || type === 'unassigned') return 99;
  return balls.filter((b) => b.active && getBallType(b.id) === type).length;
}
