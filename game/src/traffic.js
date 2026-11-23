// traffic.js — Ambient AI cars and pedestrians for Porto Luz.
// Pure game logic: no browser APIs, so Node can import this file directly.
//
// Pedestrian shape (state.js contract, plus health/panic/timer extras this
// module and combat/vehicles use):
//   { id, x, y, angle, speed, color, state: 'walk' | 'idle' | 'flee',
//     targetX, targetY, health, panic, timer }
// AI cars are plain vehicles from state.vehicles with driver 'ped' plus the
// extra fields cruiseSpeed / turnCooldown, maintained here.
import * as world from './world.js';

export const WORLD_W = 3200;
export const WORLD_H = 3200;

const TAU = Math.PI * 2;
const TARGET_AI_CARS = 14;
const TARGET_PEDS = 24;
const DESPAWN_DIST = 1600;
const RESPAWN_DIST = 1500;

const PED_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#ecf0f1', '#1abc9c', '#e67e22'];

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

function inferRoadAngle(city, x, y, rng) {
  const h = isOnRoadAt(city, x + 30, y) || isOnRoadAt(city, x - 30, y);
  const v = isOnRoadAt(city, x, y + 30) || isOnRoadAt(city, x, y - 30);
  if (h && !v) return rng() < 0.5 ? 0 : Math.PI;
  if (v && !h) return rng() < 0.5 ? Math.PI / 2 : -Math.PI / 2;
  const choices = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
  return choices[Math.floor(rng() * choices.length)];
}

function cameraOf(state) {
  if (state.camera) return state.camera;
  const p = state.player;
  return { x: p ? p.x : WORLD_W / 2, y: p ? p.y : WORLD_H / 2 };
}

function nextVehicleId(state) {
  if (typeof state._nextVehicleId !== 'number') {
    let max = 0;
    for (const v of state.vehicles || []) {
      if (typeof v.id === 'number') max = Math.max(max, v.id);
    }
    state._nextVehicleId = max + 1;
  }
  const id = state._nextVehicleId;
  state._nextVehicleId += 1;
  return id;
}

function nextPedId(state) {
  if (typeof state._nextPedId !== 'number') state._nextPedId = 1;
  const id = state._nextPedId;
  state._nextPedId += 1;
  return id;
}

function makeAiCar(state, city, rng) {
  const p = roadPoint(city, rng);
  const angle = typeof p.angle === 'number'
    ? p.angle + (rng() < 0.5 ? Math.PI : 0)
    : inferRoadAngle(city, p.x, p.y, rng);
  return {
    id: nextVehicleId(state),
    x: p.x,
    y: p.y,
    angle,
    speed: 100 + rng() * 60,
    color: ['#c0392b', '#2e4053', '#7d8a96', '#e8e8e8', '#1f618d', '#f1c40f'][Math.floor(rng() * 6)],
    kind: 'car',
    model: 'sedan',
    driver: 'ped',
    maxSpeed: 380,
    accel: 260,
    health: 100,
    cruiseSpeed: 110 + rng() * 60,
    turnCooldown: 0,
  };
}

function makePed(state, city, rng, cx, cy) {
  // Sidewalk spot beside a road, falling back to near the camera.
  let x = cx + (rng() - 0.5) * 700;
  let y = cy + (rng() - 0.5) * 700;
  const sw = sidewalkPoint(city, rng);
  if (sw) {
    x = sw.x;
    y = sw.y;
  } else {
    const p = roadPoint(city, rng);
    if (typeof p.x === 'number') {
      const angle = typeof p.angle === 'number' ? p.angle : inferRoadAngle(city, p.x, p.y, rng);
      const perp = angle + Math.PI / 2;
      const side = rng() < 0.5 ? 1 : -1;
      const ox = p.x + Math.cos(perp) * 36 * side;
      const oy = p.y + Math.sin(perp) * 36 * side;
      if (!isBlockedAt(city, ox, oy, 12)) {
        x = ox;
        y = oy;
      } else if (!isBlockedAt(city, p.x, p.y, 12)) {
        x = p.x;
        y = p.y;
      }
    }
  }
  x = clamp(x, 20, WORLD_W - 20);
  y = clamp(y, 20, WORLD_H - 20);
  return {
    id: nextPedId(state),
    x,
    y,
    angle: rng() * TAU,
    speed: 40 + rng() * 30,
    state: 'walk',
    health: 100,
    panic: 0,
    timer: 1 + rng() * 3,
    color: PED_COLORS[Math.floor(rng() * PED_COLORS.length)],
    targetX: x,
    targetY: y,
  };
}

/**
 * Fill the streets with AI cars and pedestrians around the camera.
 * Safe to call at game start and again later; it only tops the counts up.
 */
export function spawnTraffic(state, city) {
  if (!Array.isArray(state.vehicles)) state.vehicles = [];
  if (!Array.isArray(state.peds)) state.peds = [];
  const rng = rngOf(city);
  const cam = cameraOf(state);
  const aiCars = state.vehicles.filter((v) => v.driver === 'ped' && !v.wrecked).length;
  for (let i = aiCars; i < TARGET_AI_CARS; i += 1) {
    state.vehicles.push(makeAiCar(state, city, rng));
  }
  for (let i = state.peds.length; i < TARGET_PEDS; i += 1) {
    state.peds.push(makePed(state, city, rng, cam.x, cam.y));
  }
  return { cars: state.vehicles.length, peds: state.peds.length };
}

/**
 * Advance AI cars and pedestrians one frame, as updateTraffic(state, city, dt).
 * Cars follow roads, steer around buildings, slow for traffic ahead, and
 * respawn near the camera when they drift too far away. Pedestrians walk the
 * sidewalks and run from the player when a crime is happening nearby.
 * The first started frame seeds the streets if main.js left them empty.
 */
export function updateTraffic(state, city, dt) {
  const step = clamp(dt, 0, 0.05);
  const rng = rngOf(city);
  const cam = cameraOf(state);
  const p = state.player;
  // Shot mode (screenshots): the scene is fully staged, so no random
  // top-ups, no lane drift and no random flee angles — the frame must be
  // identical every time it is taken.
  const shotMode = !!state._shotMode;

  if (state.flags.started && !state._trafficSeeded
    && Array.isArray(state.peds) && state.peds.length === 0) {
    state._trafficSeeded = true;
    spawnTraffic(state, city);
  }

  // --- AI cars ---------------------------------------------------------------
  const cars = (state.vehicles || []).filter((v) => v.driver === 'ped' && !v.wrecked);
  for (const car of cars) {
    if (typeof car.cruiseSpeed !== 'number') car.cruiseSpeed = 120;
    if (typeof car.turnCooldown !== 'number') car.turnCooldown = 0;
    car.turnCooldown = Math.max(0, car.turnCooldown - step);

    // Ease towards cruising speed.
    const accel = 120;
    if (car.speed < car.cruiseSpeed) car.speed = Math.min(car.cruiseSpeed, car.speed + accel * step);
    else if (car.speed > car.cruiseSpeed) car.speed = Math.max(car.cruiseSpeed, car.speed - accel * 1.5 * step);

    // Slow down for a vehicle right ahead instead of piling into it.
    const aheadX = car.x + Math.cos(car.angle) * 55;
    const aheadY = car.y + Math.sin(car.angle) * 55;
    for (const other of state.vehicles || []) {
      if (other === car || other.wrecked) continue;
      if (dist(aheadX, aheadY, other.x, other.y) < 34) {
        car.speed = Math.max(0, car.speed - 260 * step);
        break;
      }
    }

    // Steer: score a few candidate headings and keep the one that stays on
    // a road and out of buildings, preferring to hold the current course.
    // (Block interiors are open ground with scattered buildings, so a plain
    // "blocked ahead" check lets cars cut across blocks; the road bonus
    // below is what keeps traffic on the roads.)
    const probe = 70;
    const candidates = [car.angle, car.angle - 0.5, car.angle + 0.5,
      car.angle - 1.1, car.angle + 1.1, car.angle + Math.PI];
    let bestAngle = car.angle;
    let bestScore = Infinity;
    for (const cand of candidates) {
      const px = car.x + Math.cos(cand) * probe;
      const py = car.y + Math.sin(cand) * probe;
      let score = Math.abs(angleDiff(cand, car.angle)) * 60;
      if (!isOnRoadAt(city, px, py)) score += 400;
      if (isBlockedAt(city, px, py, 18)) score += 10000;
      if (score < bestScore) {
        bestScore = score;
        bestAngle = cand;
      }
    }
    if (bestScore >= 10000) {
      // Nowhere to go: turn around slowly.
      car.angle += Math.PI * step * 1.2;
      car.speed = Math.max(30, car.speed * 0.6);
      car.turnCooldown = 0.4;
    } else if (bestAngle !== car.angle) {
      const turn = clamp(angleDiff(car.angle, bestAngle), -1, 1);
      car.angle += turn * 2.0 * step;
      car.turnCooldown = 0.4;
    } else if (!shotMode && car.turnCooldown <= 0 && rng() < step * 0.12) {
      // Occasional gentle lane drift so traffic does not look railed.
      car.angle += (rng() - 0.5) * 0.25;
    }

    car.x += Math.cos(car.angle) * car.speed * step;
    car.y += Math.sin(car.angle) * car.speed * step;
    car.x = clamp(car.x, 20, WORLD_W - 20);
    car.y = clamp(car.y, 20, WORLD_H - 20);

    // Too far from the camera: recycle the car onto a road near the camera.
    if (dist(car.x, car.y, cam.x, cam.y) > RESPAWN_DIST) {
      const spot = roadPoint(city, rng);
      car.x = spot.x;
      car.y = spot.y;
      car.angle = typeof spot.angle === 'number'
        ? spot.angle : inferRoadAngle(city, spot.x, spot.y, rng);
      car.speed = car.cruiseSpeed;
      if (typeof car.health === 'number') car.health = 100;
    }
  }

  // Keep the AI car count steady near the camera (not in shot mode).
  const liveCars = (state.vehicles || []).filter((v) => v.driver === 'ped' && !v.wrecked);
  if (!shotMode && liveCars.length < TARGET_AI_CARS) {
    for (let i = liveCars.length; i < TARGET_AI_CARS; i += 1) {
      const car = makeAiCar(state, city, rng);
      // Spawn it on a road within a few hundred px of the camera.
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const spot = roadPoint(city, rng);
        if (dist(spot.x, spot.y, cam.x, cam.y) < 900) {
          car.x = spot.x;
          car.y = spot.y;
          car.angle = typeof spot.angle === 'number'
            ? spot.angle : inferRoadAngle(city, spot.x, spot.y, rng);
          break;
        }
      }
      state.vehicles.push(car);
    }
  }

  // --- Pedestrians -----------------------------------------------------------
  const peds = state.peds || [];
  for (let i = peds.length - 1; i >= 0; i -= 1) {
    const ped = peds[i];
    if (typeof ped.health !== 'number') ped.health = 100;
    if (ped.state === 'dead') {
      ped.timer -= step;
      if (ped.timer <= 0) peds.splice(i, 1);
      continue;
    }
    if (ped.state === 'down') {
      ped.timer -= step;
      if (ped.timer <= 0) {
        if (ped.health <= 0) {
          ped.state = 'dead';
          ped.timer = 5;
        } else {
          ped.state = 'walk';
          ped.health = Math.max(ped.health, 30);
          ped.timer = 1 + rng() * 3;
        }
      }
      continue;
    }

    // Fear: wanted player nearby, or a fast car bearing down on them.
    let scared = false;
    if (p && (p.wanted || 0) > 0 && dist(ped.x, ped.y, p.x, p.y) < 280) scared = true;
    if (ped.panic > 0) scared = true;
    if (!scared) {
      for (const v of state.vehicles || []) {
        if (v.wrecked) continue;
        if (Math.abs(v.speed) > 150 && dist(ped.x, ped.y, v.x, v.y) < 90) {
          scared = true;
          break;
        }
      }
    }

    if (scared) {
      ped.state = 'flee';
      ped.panic = Math.max(ped.panic, 0.6);
      const away = p ? Math.atan2(ped.y - p.y, ped.x - p.x) : ped.angle;
      ped.angle = shotMode ? away : away + (rng() - 0.5) * 0.5;
      ped.speed = 165;
    } else if (ped.state === 'flee') {
      ped.panic = Math.max(0, ped.panic - step * 0.25);
      if (ped.panic <= 0 && (!p || dist(ped.x, ped.y, p.x, p.y) > 320)) {
        ped.state = 'walk';
        ped.speed = shotMode ? 55 : 40 + rng() * 30;
      } else {
        if (!shotMode) ped.angle += (rng() - 0.5) * 0.4;
        ped.speed = 165;
      }
    } else {
      // Strolling: change direction now and then, turn away from walls.
      ped.timer -= step;
      if (ped.timer <= 0) {
        ped.angle += (rng() - 0.5) * 2.2;
        ped.timer = 2 + rng() * 3;
      }
      const nx = ped.x + Math.cos(ped.angle) * ped.speed * step;
      const ny = ped.y + Math.sin(ped.angle) * ped.speed * step;
      if (isBlockedAt(city, nx, ny, 10)) {
        ped.angle += Math.PI / 2 + (rng() - 0.5) * 0.8;
        ped.timer = 0.5 + rng();
      }
    }

    if (ped.state === 'flee' || ped.state === 'walk') {
      const nx = ped.x + Math.cos(ped.angle) * ped.speed * step;
      const ny = ped.y + Math.sin(ped.angle) * ped.speed * step;
      if (!isBlockedAt(city, nx, ped.y, 10)) ped.x = nx;
      if (!isBlockedAt(city, ped.x, ny, 10)) ped.y = ny;
      ped.x = clamp(ped.x, 16, WORLD_W - 16);
      ped.y = clamp(ped.y, 16, WORLD_H - 16);
      ped.targetX = ped.x + Math.cos(ped.angle) * 60;
      ped.targetY = ped.y + Math.sin(ped.angle) * 60;
    }

    // Far from the camera: recycle the pedestrian near the camera.
    if (dist(ped.x, ped.y, cam.x, cam.y) > DESPAWN_DIST) {
      const fresh = makePed(state, city, rng, cam.x, cam.y);
      peds[i] = fresh;
    }
  }

  // Keep the pedestrian count steady near the camera (not in shot mode).
  if (!shotMode && peds.length < TARGET_PEDS) {
    for (let i = peds.length; i < TARGET_PEDS; i += 1) {
      state.peds.push(makePed(state, city, rng, cam.x, cam.y));
    }
  }
}
