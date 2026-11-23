// police.js — Wanted level, police pursuit, arrest, death and respawn.
// Pure game logic: no browser APIs, so Node can import this file directly.
//
// Police shape (state.js contract, plus health and chase bookkeeping):
//   { id, x, y, angle, speed, color, kind: 'car' | 'officer',
//     state: 'patrol' | 'chase' | 'arrest', health }
// Wanted lives on state.player.wanted (0-5). On arrest (busted) the player
// respawns at the police station; on death (wasted) at the hospital. Both
// cost part of the player's cash and clear the wanted level. flags.busted /
// flags.wasted are set so the game can show the moment, then cleared after
// ~2.5 s by this module (render.js only draws the BUSTED/WASTED overlay
// while flags.gameOver is set, and a stale flag would mislabel a later
// game over, so the flags must not linger).
// NOTE on main.js: it also watches player.health <= 0 and sets gameOver.
// This module respawns first (health back to 100), so a death plays as a
// hospital respawn, GTA-style, and main.js's game-over path stays unused
// unless another system kills the player without this module running.
import * as world from './world.js';
import { addMessage } from './state.js';

export const WORLD_W = 3200;
export const WORLD_H = 3200;

const TAU = Math.PI * 2;

// How many police each wanted level calls for.
const WANTED_TABLE = {
  0: { cars: 0, foot: 0 },
  1: { cars: 1, foot: 1 },
  2: { cars: 1, foot: 2 },
  3: { cars: 2, foot: 2 },
  4: { cars: 3, foot: 3 },
  5: { cars: 4, foot: 4 },
};

const HOSPITAL = { x: 500, y: 500 };
const POLICE_STATION = { x: 2700, y: 2700 };
const HIDDEN_RANGE = 600; // no police within this range counts as "out of sight"
const HIDDEN_SECONDS = 6; // ...for this long before wanted drops by one
const FLAG_CLEAR_SECONDS = 2.5; // busted/wasted flags clear themselves after this

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

function angleDiff(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

function rngOf(city) {
  if (city && typeof city.rng === 'function') return city.rng;
  return Math.random;
}

// The real world's randomRoadPoint / randomSidewalkPoint want an rng object
// with .pick/.float (see random.js createRandom); a bare function is adapted.
function toRng(rng) {
  if (rng && typeof rng.pick === 'function' && typeof rng.float === 'function') return rng;
  const next = typeof rng === 'function' ? rng : Math.random;
  return {
    next,
    pick(list) { return list[Math.floor(next() * list.length)]; },
    float(min = 0, max = 1) { return min + next() * (max - min); },
    int(min, max) { return Math.floor(min + next() * (max - min + 1)); },
    chance(p) { return next() < p; },
  };
}

// Only a real generated city (roads + buildings) is safe to hand to the
// world.js exports; mock cities carry their own methods instead.
function isRealCity(city) {
  return !!city && Array.isArray(city.roads) && Array.isArray(city.buildings);
}

function isBlockedAt(city, x, y, r) {
  if (city && typeof city.isBlocked === 'function') return city.isBlocked(x, y, r);
  if (isRealCity(city) && typeof world.isBlocked === 'function') return world.isBlocked(city, x, y, r);
  return x < r || y < r || x > WORLD_W - r || y > WORLD_H - r;
}

function isOnRoadAt(city, x, y) {
  if (city && typeof city.isOnRoad === 'function') return city.isOnRoad(x, y);
  if (isRealCity(city) && typeof world.isOnRoad === 'function') return world.isOnRoad(city, x, y);
  return true;
}

function roadPoint(city, rng) {
  if (city && typeof city.randomRoadPoint === 'function') {
    const p = city.randomRoadPoint(rng);
    if (p && typeof p.x === 'number') return p;
  }
  if (isRealCity(city) && typeof world.randomRoadPoint === 'function') {
    const p = world.randomRoadPoint(city, toRng(rng));
    if (p && typeof p.x === 'number') return p;
  }
  return {
    x: 120 + rng() * (WORLD_W - 240),
    y: 120 + rng() * (WORLD_H - 240),
    angle: rng() * TAU,
  };
}

function sidewalkPoint(city, rng) {
  if (city && typeof city.randomSidewalkPoint === 'function') {
    const p = city.randomSidewalkPoint(rng);
    if (p && typeof p.x === 'number') return p;
  }
  if (isRealCity(city) && typeof world.randomSidewalkPoint === 'function') {
    const p = world.randomSidewalkPoint(city, toRng(rng));
    if (p && typeof p.x === 'number') return p;
  }
  return null;
}

// Find a nearby spot that is not inside a building (rings around x, y).
function findSafeSpot(city, x, y) {
  if (!isBlockedAt(city, x, y, 16)) return { x, y };
  for (const radius of [40, 80, 130, 200, 300, 420]) {
    for (let k = 0; k < 8; k += 1) {
      const a = (k / 8) * TAU;
      const sx = clamp(x + Math.cos(a) * radius, 24, WORLD_W - 24);
      const sy = clamp(y + Math.sin(a) * radius, 24, WORLD_H - 24);
      if (!isBlockedAt(city, sx, sy, 16)) return { x: sx, y: sy };
    }
  }
  return { x: clamp(x, 24, WORLD_W - 24), y: clamp(y, 24, WORLD_H - 24) };
}

function nextPoliceId(state) {
  if (typeof state._nextPoliceId !== 'number') state._nextPoliceId = 1;
  const id = state._nextPoliceId;
  state._nextPoliceId += 1;
  return id;
}

/** Raise (or lower, with a negative n) the wanted level, clamped to 0-5. */
export function addWanted(state, n) {
  const p = state.player;
  if (!p) return 0;
  p.wanted = clamp((p.wanted || 0) + n, 0, 5);
  return p.wanted;
}

function makePoliceCar(state, city, rng, px, py) {
  let x = px;
  let y = py;
  let angle = 0;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const spot = roadPoint(city, rng);
    const d = dist(spot.x, spot.y, px, py);
    if (d > 520 && d < 850) {
      x = spot.x;
      y = spot.y;
      angle = typeof spot.angle === 'number' ? spot.angle : rng() * TAU;
      break;
    }
    x = spot.x;
    y = spot.y;
    angle = typeof spot.angle === 'number' ? spot.angle : rng() * TAU;
  }
  return {
    id: nextPoliceId(state),
    x, y, angle, speed: 120, kind: 'car', color: '#e8e8e8', state: 'chase',
    health: 120,
    cruiseSpeed: 360, _stuckTime: 0, _reverseTimer: 0, _ramCd: 0, roadblock: false,
  };
}

function makeOfficer(state, city, rng) {
  const sw = sidewalkPoint(city, rng);
  let x;
  let y;
  if (sw) {
    x = sw.x;
    y = sw.y;
  } else {
    const spot = roadPoint(city, rng);
    const perp = (typeof spot.angle === 'number' ? spot.angle : 0) + Math.PI / 2;
    const side = rng() < 0.5 ? 1 : -1;
    x = spot.x + Math.cos(perp) * 34 * side;
    y = spot.y + Math.sin(perp) * 34 * side;
    if (isBlockedAt(city, x, y, 12)) {
      x = spot.x;
      y = spot.y;
    }
  }
  return {
    id: nextPoliceId(state),
    x, y, angle: rng() * TAU, speed: 0, kind: 'officer', color: '#1f3a93',
    state: 'chase', health: 60,
  };
}

function cashPenalty(player) {
  const penalty = Math.min(player.cash || 0, 100 + 100 * (player.wanted || 0));
  player.cash = Math.max(0, (player.cash || 0) - penalty);
  return penalty;
}

function respawnPlayer(state, city, at, label) {
  const p = state.player;
  if (p.inVehicle != null) {
    const v = (state.vehicles || []).find((car) => car.id === p.inVehicle);
    if (v) v.driver = null;
    p.inVehicle = null;
  }
  const spot = findSafeSpot(city, at.x, at.y);
  p.x = spot.x;
  p.y = spot.y;
  p.angle = 0;
  p.speed = 0;
  p.onFoot = true;
  p.health = 100;
  p.wanted = 0;
  if (Array.isArray(state.bullets)) state.bullets.length = 0;
  state.police = [];
  state._policeHidden = 0;
  state._roadblockTimer = 0;
  addMessage(state, `${label} — lost some cash, wanted level cleared.`);
}

/**
 * Wanted decay, police spawning / pursuit / ramming, arrest and death.
 * Call once per frame as updatePolice(state, city, dt).
 */
export function updatePolice(state, city, dt) {
  const p = state.player;
  if (!p) return;
  const step = clamp(dt, 0, 0.05);
  const rng = rngOf(city);
  if (!Array.isArray(state.police)) state.police = [];
  if (typeof state._policeHidden !== 'number') state._policeHidden = 0;
  if (typeof state._roadblockTimer !== 'number') state._roadblockTimer = 0;

  // Busted / wasted flags clear themselves so a later game over is labelled
  // with the right word and the audio does not stay muted.
  if (state.flags.busted) {
    state._bustedTimer = Math.max(0, (state._bustedTimer || FLAG_CLEAR_SECONDS) - step);
    if (state._bustedTimer <= 0) state.flags.busted = false;
  }
  if (state.flags.wasted) {
    state._wastedTimer = Math.max(0, (state._wastedTimer || FLAG_CLEAR_SECONDS) - step);
    if (state._wastedTimer <= 0) state.flags.wasted = false;
  }

  const wanted = clamp(p.wanted || 0, 0, 5);

  // --- Wasted: health hit zero ----------------------------------------------
  if (p.health <= 0 && !state.flags.wasted) {
    state.flags.wasted = true;
    state._wastedTimer = FLAG_CLEAR_SECONDS;
    cashPenalty(p);
    respawnPlayer(state, city, HOSPITAL, 'You woke up in the hospital');
    return;
  }

  // --- Wanted decay: out of sight for a while -------------------------------
  let nearest = Infinity;
  for (const cop of state.police) nearest = Math.min(nearest, dist(cop.x, cop.y, p.x, p.y));
  if (wanted > 0 && nearest > HIDDEN_RANGE) {
    state._policeHidden += step;
    if (state._policeHidden >= HIDDEN_SECONDS) {
      state._policeHidden = 0;
      addWanted(state, -1);
      addMessage(state, 'You lost the cops — wanted level down.');
    }
  } else {
    state._policeHidden = 0;
  }

  // --- Match police numbers to the wanted level ------------------------------
  const want = WANTED_TABLE[wanted];
  const cars = state.police.filter((c) => c.kind === 'car');
  const foot = state.police.filter((c) => c.kind === 'officer');
  for (let i = cars.length; i < want.cars; i += 1) {
    state.police.push(makePoliceCar(state, city, rng, p.x, p.y));
  }
  for (let i = foot.length; i < want.foot; i += 1) {
    state.police.push(makeOfficer(state, city, rng));
  }
  if (cars.length > want.cars || foot.length > want.foot) {
    // Shed the farthest extras first.
    state.police.sort((a, b) => dist(b.x, b.y, p.x, p.y) - dist(a.x, a.y, p.x, p.y));
    let overCars = Math.max(0, cars.length - want.cars);
    let overFoot = Math.max(0, foot.length - want.foot);
    state.police = state.police.filter((cop) => {
      if (cop.kind === 'car' && overCars > 0) {
        overCars -= 1;
        return false;
      }
      if (cop.kind === 'officer' && overFoot > 0) {
        overFoot -= 1;
        return false;
      }
      return true;
    });
  }

  // --- Roadblock at 4-5 stars: two parked cruisers ahead of the player -------
  if (wanted >= 4) {
    state._roadblockTimer -= step;
    const hasBlock = state.police.some((c) => c.roadblock);
    if (!hasBlock && state._roadblockTimer <= 0) {
      state._roadblockTimer = 25;
      for (let i = 0; i < 2; i += 1) {
        const ahead = p.angle || 0;
        const bx = p.x + Math.cos(ahead) * (320 + i * 60);
        const by = p.y + Math.sin(ahead) * (320 + i * 60);
        const spot = findSafeSpot(city, bx, by);
        state.police.push({
          id: nextPoliceId(state),
          x: spot.x, y: spot.y, angle: ahead + Math.PI / 2, speed: 0,
          kind: 'car', color: '#e8e8e8', state: 'chase',
          health: 120, cruiseSpeed: 0,
          _stuckTime: 0, _reverseTimer: 0, _ramCd: 0, roadblock: true,
        });
      }
      addMessage(state, 'Roadblock ahead!');
    }
  }

  // --- Move the police ---------------------------------------------------------
  for (let i = state.police.length - 1; i >= 0; i -= 1) {
    const cop = state.police[i];
    if (typeof cop.health !== 'number') cop.health = cop.kind === 'car' ? 120 : 60;
    if (cop.health <= 0) {
      state.police.splice(i, 1);
      continue;
    }
    cop._ramCd = Math.max(0, (cop._ramCd || 0) - step);

    if (cop.kind === 'car') {
      if (cop.roadblock) {
        cop.speed = 0;
        // A roadblock that waited out its timer joins the chase.
        if (state._roadblockTimer <= 0) {
          cop.roadblock = false;
          cop.cruiseSpeed = 360 + wanted * 30;
        }
        continue;
      }
      const chaseSpeed = 340 + wanted * 30;
      const desired = Math.atan2(p.y - cop.y, p.x - cop.x);
      cop._reverseTimer = Math.max(0, (cop._reverseTimer || 0) - step);
      if (cop._reverseTimer > 0) {
        cop.speed = Math.max(-140, cop.speed - 300 * step);
        cop.angle -= 1.6 * step;
      } else {
        // Pick the heading that best balances "toward the player" with
        // "stays on a road and out of buildings".
        const candidates = [desired, desired - 0.8, desired + 0.8, desired - 1.6, desired + 1.6, cop.angle];
        let bestAngle = cop.angle;
        let bestScore = Infinity;
        for (const cand of candidates) {
          const px = cop.x + Math.cos(cand) * 70;
          const py = cop.y + Math.sin(cand) * 70;
          let score = Math.abs(angleDiff(cand, desired)) * 120;
          if (!isOnRoadAt(city, px, py)) score += 400;
          if (isBlockedAt(city, px, py, 18)) score += 10000;
          if (score < bestScore) {
            bestScore = score;
            bestAngle = cand;
          }
        }
        if (bestScore >= 10000) {
          // Dead end in every direction: back up and turn around.
          cop._reverseTimer = 0.8;
          cop._stuckTime = 0;
        } else {
          const turn = clamp(angleDiff(cop.angle, bestAngle), -1, 1);
          cop.angle += turn * 2.6 * step * clamp(Math.abs(cop.speed) / 120, 0.25, 1);
        }
        if (cop.speed < chaseSpeed) cop.speed += 300 * step;
        else cop.speed -= 120 * step;
      }
      const nx = cop.x + Math.cos(cop.angle) * cop.speed * step;
      const ny = cop.y + Math.sin(cop.angle) * cop.speed * step;
      if (!isBlockedAt(city, nx, cop.y, 18)) cop.x = nx;
      if (!isBlockedAt(city, cop.x, ny, 18)) cop.y = ny;
      cop.x = clamp(cop.x, 20, WORLD_W - 20);
      cop.y = clamp(cop.y, 20, WORLD_H - 20);

      // Stuck against something: back up and turn around.
      if (Math.abs(cop.speed) < 30 && cop._reverseTimer <= 0) {
        cop._stuckTime = (cop._stuckTime || 0) + step;
        if (cop._stuckTime > 2) {
          cop._stuckTime = 0;
          cop._reverseTimer = 0.8;
        }
      } else {
        cop._stuckTime = 0;
      }

      // Ram the player's vehicle, or run down a player on foot.
      const d = dist(cop.x, cop.y, p.x, p.y);
      if (p.inVehicle != null && d < 48 && cop._ramCd <= 0) {
        cop._ramCd = 0.6;
        const v = (state.vehicles || []).find((car) => car.id === p.inVehicle)
          || (typeof p.inVehicle === 'object' ? p.inVehicle : null);
        if (v) {
          if (typeof v.health !== 'number') v.health = 100;
          v.health -= 7;
          v.speed *= 0.72;
          cop.speed *= 0.8;
          if (Math.abs(v.speed) > 200) {
            p.health = Math.max(0, p.health - 3);
          }
        }
      } else if (p.inVehicle == null && d < 26 && cop._ramCd <= 0) {
        cop._ramCd = 0.8;
        p.health = Math.max(0, p.health - 12);
        const away = Math.atan2(p.y - cop.y, p.x - cop.x);
        p.x += Math.cos(away) * 18;
        p.y += Math.sin(away) * 18;
      }
    } else {
      // Officer on foot: run at the player, slide around walls, arrest on contact.
      const d = dist(cop.x, cop.y, p.x, p.y);
      if (d < 30 && p.onFoot !== false && p.inVehicle == null) {
        if (!state.flags.busted) {
          state.flags.busted = true;
          state._bustedTimer = FLAG_CLEAR_SECONDS;
          cashPenalty(p);
          respawnPlayer(state, city, POLICE_STATION, 'Busted — the police took you in');
        }
        return;
      }
      const desired = Math.atan2(p.y - cop.y, p.x - cop.x);
      cop.angle += clamp(angleDiff(cop.angle, desired), -1, 1) * 3.2 * step;
      cop.speed = 150;
      const nx = cop.x + Math.cos(cop.angle) * cop.speed * step;
      const ny = cop.y + Math.sin(cop.angle) * cop.speed * step;
      if (!isBlockedAt(city, nx, cop.y, 12)) cop.x = nx;
      else cop.angle += (Math.PI / 2) * step * 4;
      if (!isBlockedAt(city, cop.x, ny, 12)) cop.y = ny;
      cop.x = clamp(cop.x, 16, WORLD_W - 16);
      cop.y = clamp(cop.y, 16, WORLD_H - 16);
    }
  }

  // Light separation so cruisers do not stack on each other.
  for (let a = 0; a < state.police.length; a += 1) {
    for (let b = a + 1; b < state.police.length; b += 1) {
      const A = state.police[a];
      const B = state.police[b];
      const d = dist(A.x, A.y, B.x, B.y);
      if (d < 46 && d > 0.01) {
        const push = (46 - d) / 2;
        const ux = (A.x - B.x) / d;
        const uy = (A.y - B.y) / d;
        A.x += ux * push;
        A.y += uy * push;
        B.x -= ux * push;
        B.y -= uy * push;
      }
    }
  }

  // No wanted level: police that drift far away quietly leave.
  if (wanted === 0) {
    state.police = state.police.filter((cop) => dist(cop.x, cop.y, p.x, p.y) < 900);
  }
}
