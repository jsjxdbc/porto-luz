// vehicles.js — Player driving, carjacking and vehicle collisions for Porto Luz.
// Pure game logic: no browser APIs, so Node can import this file directly.
//
// Contract with main.js / state.js (the integration truth):
//   - player.inVehicle holds a vehicle ID (number), or null on foot.
//     main.js owns the E key: it enters/exits cars and flips v.driver.
//     This module watches for that driver flip (null/'ped' -> 'player') and
//     applies the carjacking consequences once per car (wanted +1, the AI
//     driver bailing out on foot). enterVehicle / exitVehicle are kept as
//     the direct API for missions and other callers, with the same rules.
//   - vehicle shape: { id, x, y, angle, speed, color, kind, model,
//     driver: null | 'player' | 'ped', maxSpeed, accel, health }.
//     `kind` ('car' | 'taxi' | 'truck' | 'bike') is what render.js draws;
//     `model` ('sedan' | 'sports' | 'van' | 'taxi') picks the physics.
//   - messages go through state.addMessage (objects { text, ttl }); main.js
//     decrements ttl and render.js reads m.text / m.ttl.
//   - world helpers (isBlocked / isOnRoad / randomRoadPoint /
//     randomSidewalkPoint) are resolved from ./world.js exports first, then
//     from methods on the city object, then from safe fallbacks.
import * as world from './world.js';
import { addWanted } from './police.js';
import { addMessage } from './state.js';
import { explodeVehicle } from './explosions.js';

export const WORLD_W = 3200;
export const WORLD_H = 3200;

const TAU = Math.PI * 2;

// Model table: road kind for the renderer, physics, body size, paint.
const MODELS = {
  sedan: {
    kind: 'car', maxSpeed: 380, accel: 260, reverseMax: 120, length: 46, width: 22,
    colors: ['#c0392b', '#2e4053', '#7d8a96', '#e8e8e8', '#1f618d', '#6c3483'],
  },
  sports: {
    kind: 'car', maxSpeed: 520, accel: 340, reverseMax: 140, length: 44, width: 21,
    colors: ['#e74c3c', '#f1c40f', '#16a085', '#e67e22', '#f5f5f5'],
  },
  van: {
    kind: 'truck', maxSpeed: 300, accel: 200, reverseMax: 100, length: 54, width: 24,
    colors: ['#f5f5f5', '#5d6d7e', '#7b241c', '#2e86c1'],
  },
  taxi: {
    kind: 'taxi', maxSpeed: 400, accel: 280, reverseMax: 120, length: 46, width: 22,
    colors: ['#f7c948', '#f7c948', '#f7c948'],
  },
};

const MODEL_KEYS = Object.keys(MODELS);
const MODEL_WEIGHTS = { sedan: 0.4, sports: 0.2, van: 0.2, taxi: 0.2 };

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

function rngOf(city) {
  if (city && typeof city.rng === 'function') return city.rng;
  return Math.random;
}

// The real world's randomRoadPoint wants an rng object with .pick/.float
// (see random.js createRandom); a bare function is adapted to one.
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

// --- World helpers, with fallbacks -------------------------------------------

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
  return true; // no road data: treat everywhere as drivable
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

// Which way the road runs under (x, y): probe the neighbours.
function inferRoadAngle(city, x, y, rng) {
  const h = isOnRoadAt(city, x + 30, y) || isOnRoadAt(city, x - 30, y);
  const v = isOnRoadAt(city, x, y + 30) || isOnRoadAt(city, x, y - 30);
  if (h && !v) return rng() < 0.5 ? 0 : Math.PI;
  if (v && !h) return rng() < 0.5 ? Math.PI / 2 : -Math.PI / 2;
  const choices = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
  return choices[Math.floor(rng() * choices.length)];
}

function pickModel(rng) {
  const roll = rng();
  let acc = 0;
  for (const key of MODEL_KEYS) {
    acc += MODEL_WEIGHTS[key];
    if (roll <= acc) return key;
  }
  return 'sedan';
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

function makeVehicle(state, city, rng, parked) {
  const model = pickModel(rng);
  const def = MODELS[model];
  let x = 0;
  let y = 0;
  let angle = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const p = roadPoint(city, rng);
    x = p.x;
    y = p.y;
    angle = typeof p.angle === 'number' ? p.angle : inferRoadAngle(city, x, y, rng);
    if (parked) {
      // Parked cars sit on the roadside, perpendicular offset from the centre.
      const perp = angle + Math.PI / 2;
      const side = rng() < 0.5 ? 1 : -1;
      const ox = x + Math.cos(perp) * 30 * side;
      const oy = y + Math.sin(perp) * 30 * side;
      if (!isBlockedAt(city, ox, oy, 20)) {
        x = ox;
        y = oy;
        break;
      }
      const ox2 = x - Math.cos(perp) * 30 * side;
      const oy2 = y - Math.sin(perp) * 30 * side;
      if (!isBlockedAt(city, ox2, oy2, 20)) {
        x = ox2;
        y = oy2;
        break;
      }
    }
    if (!isBlockedAt(city, x, y, 20)) break;
  }
  if (parked) {
    angle += rng() < 0.5 ? 0 : Math.PI;
  } else if (rng() < 0.5) {
    angle += Math.PI; // opposite direction of travel
  }
  return {
    id: nextVehicleId(state),
    x,
    y,
    angle,
    speed: parked ? 0 : 110 + rng() * 70,
    color: def.colors[Math.floor(rng() * def.colors.length)],
    kind: def.kind,
    model,
    driver: parked ? null : 'ped',
    maxSpeed: def.maxSpeed,
    accel: def.accel,
    health: 100,
  };
}

/**
 * Spawn `n` vehicles: a mix of parked cars (driver null) and cars already
 * driving with a pedestrian driver. Appends to state.vehicles and returns it.
 */
export function spawnVehicles(state, city, n) {
  if (!Array.isArray(state.vehicles)) state.vehicles = [];
  const rng = rngOf(city);
  for (let i = 0; i < n; i += 1) {
    state.vehicles.push(makeVehicle(state, city, rng, rng() < 0.6));
  }
  return state.vehicles;
}

// --- Enter / exit -------------------------------------------------------------

// The vehicle the player is driving, resolved from the ID main.js stores.
function drivenVehicle(state) {
  const p = state.player;
  if (!p || p.inVehicle == null) return null;
  if (typeof p.inVehicle === 'object') return p.inVehicle;
  return (state.vehicles || []).find((v) => v.id === p.inVehicle) || null;
}

function damageVehicle(v, amount) {
  if (typeof v.health !== 'number') v.health = 100;
  v.health -= amount;
}

// Apply the carjacking consequences once per car: wanted +1, and a pedestrian
// driver bails out and flees on foot.
function applyCarjack(state, vehicle, hadDriver) {
  if (!vehicle.stolenOnce) {
    vehicle.stolenOnce = true;
    addWanted(state, 1);
    addMessage(state, 'Car stolen! Wanted +1.');
  }
  if (hadDriver === 'ped' && !vehicle._driverBailed) {
    vehicle._driverBailed = true;
    if (Array.isArray(state.peds)) {
      state.peds.push({
        id: nextPedId(state),
        x: vehicle.x + 26, y: vehicle.y + 26,
        angle: Math.random() * TAU, speed: 150,
        state: 'flee', health: 100, panic: 1, timer: 0, color: '#8d6e63',
        targetX: vehicle.x + 200, targetY: vehicle.y + 200,
      });
    }
  }
}

/**
 * Put the player into a vehicle. Stealing a car that is not already theirs
 * raises wanted by 1 (once per car). Returns true on success.
 * (main.js normally enters cars itself on E; this is the direct API for
 * missions and other callers, and updateVehicles applies the same rules
 * when it sees main.js flip a car's driver to 'player'.)
 */
export function enterVehicle(state, player, vehicle) {
  if (!vehicle || vehicle.wrecked) return false;
  if (player.inVehicle === vehicle.id || player.inVehicle === vehicle) return true;
  if (player.inVehicle != null) return false; // already driving something else
  const hadDriver = vehicle.driver;
  applyCarjack(state, vehicle, hadDriver);
  vehicle.driver = 'player';
  player.inVehicle = vehicle.id;
  player.onFoot = false;
  player.x = vehicle.x;
  player.y = vehicle.y;
  player.angle = vehicle.angle;
  player.speed = vehicle.speed;
  return true;
}

/**
 * Get the player out of a vehicle, standing beside it. Returns true on success.
 */
export function exitVehicle(state, player, vehicle) {
  if (!vehicle) return false;
  if (player.inVehicle !== vehicle.id && player.inVehicle !== vehicle) return false;
  vehicle.driver = null;
  player.inVehicle = null;
  player.onFoot = true;
  player.speed = 0;
  // Step out to the side that is not blocked, if we can tell.
  const perp = vehicle.angle + Math.PI / 2;
  const city = state._city || null;
  let placed = false;
  for (const side of [1, -1]) {
    const x = vehicle.x + Math.cos(perp) * 36 * side;
    const y = vehicle.y + Math.sin(perp) * 36 * side;
    if (!city || !isBlockedAt(city, x, y, 14)) {
      player.x = x;
      player.y = y;
      placed = true;
      break;
    }
  }
  if (!placed) {
    player.x = vehicle.x + Math.cos(perp) * 36;
    player.y = vehicle.y + Math.sin(perp) * 36;
  }
  player.angle = vehicle.angle;
  return true;
}

// --- Per-frame update ---------------------------------------------------------

function keysOf(input, state) {
  if (input && input.keys) return input.keys;
  if (input && typeof input === 'object') return input;
  if (state && state.input && state.input.keys) return state.input.keys;
  return {};
}

function damagePlayer(player, amount) {
  let rest = amount;
  if (player.armor > 0) {
    const absorbed = Math.min(player.armor, rest * 0.5);
    player.armor -= absorbed;
    rest -= absorbed;
  }
  player.health = Math.max(0, player.health - rest);
}

function wreckVehicle(state, vehicle) {
  if (vehicle.wrecked) return;
  vehicle.wrecked = true;
  vehicle.speed = 0;
  if (vehicle.driver === 'player' && state.player) {
    const p = state.player;
    p.inVehicle = null;
    p.onFoot = true;
    p.speed = 0;
    p.x = vehicle.x;
    p.y = vehicle.y;
  }
  vehicle.driver = null;
  addMessage(state, '车报废了！');
}

/**
 * Player driving physics + collisions. Call once per frame as
 * updateVehicles(state, city, dt); the input is read from state.input
 * (an optional 4th argument overrides it, for tests).
 * main.js owns the E key and the camera; this module owns the car itself.
 */
export function updateVehicles(state, city, dt, input) {
  const p = state.player;
  if (!p) return;
  state._city = city; // remembered only so exitVehicle can test the side step
  const step = clamp(dt, 0, 0.05);
  const keys = keysOf(input, state);

  // One-time seeding: main.js never spawns traffic, so the first started
  // frame fills the streets. Staged shots already have vehicles, so they
  // are left alone.
  if (state.flags.started && !state._vehiclesSeeded
    && Array.isArray(state.vehicles) && state.vehicles.length === 0) {
    state._vehiclesSeeded = true;
    spawnVehicles(state, city, 12);
  }

  // Carjacking watch: main.js flips v.driver to 'player' on E. Apply the
  // consequences once per car (wanted, driver bailing out).
  if (!state._vehDriverSeen) state._vehDriverSeen = {};
  for (const v of state.vehicles || []) {
    const prev = state._vehDriverSeen[v.id];
    if (prev !== undefined && prev !== 'player' && v.driver === 'player') {
      applyCarjack(state, v, prev);
    }
    state._vehDriverSeen[v.id] = v.driver;
  }

  const vehicle = drivenVehicle(state);
  if (vehicle && !vehicle.wrecked) {
    const def = MODELS[vehicle.model] || MODELS.sedan;
    const up = !!(keys.KeyW || keys.ArrowUp);
    const down = !!(keys.KeyS || keys.ArrowDown);
    const left = !!(keys.KeyA || keys.ArrowLeft);
    const right = !!(keys.KeyD || keys.ArrowRight);
    const brake = !!keys.Space;

    // Longitudinal: accelerate / brake / reverse / coast with drag.
    if (up) vehicle.speed += def.accel * step;
    if (down) {
      if (vehicle.speed > 5) vehicle.speed -= 420 * step;
      else vehicle.speed -= def.accel * 0.6 * step;
    }
    if (brake) vehicle.speed -= Math.sign(vehicle.speed) * 520 * step;
    if (!up && !down) vehicle.speed -= vehicle.speed * 0.55 * step;
    if (Math.abs(vehicle.speed) < 4 && !up && !down) vehicle.speed = 0;
    vehicle.speed = clamp(vehicle.speed, -def.reverseMax, def.maxSpeed);

    // Steering: stronger with speed, weaker at the very top end, reversed
    // while reversing.
    const steer = (left ? -1 : 0) + (right ? 1 : 0);
    const grip = clamp(Math.abs(vehicle.speed) / 130, 0, 1);
    const highSpeedCut = 1 - 0.3 * clamp(Math.abs(vehicle.speed) / def.maxSpeed, 0, 1);
    vehicle.angle += steer * 2.3 * grip * highSpeedCut * (vehicle.speed >= 0 ? 1 : -1) * step;

    // Move with axis separation so the car slides along walls.
    const nx = vehicle.x + Math.cos(vehicle.angle) * vehicle.speed * step;
    const ny = vehicle.y + Math.sin(vehicle.angle) * vehicle.speed * step;
    const radius = 20;
    vehicle._hitCd = Math.max(0, (vehicle._hitCd || 0) - step);
    let hitHard = false;
    if (!isBlockedAt(city, nx, vehicle.y, radius)) {
      vehicle.x = nx;
    } else if (Math.abs(vehicle.speed) > 60) {
      hitHard = true;
    }
    if (!isBlockedAt(city, vehicle.x, ny, radius)) {
      vehicle.y = ny;
    } else if (Math.abs(vehicle.speed) > 60) {
      hitHard = true;
    }
    if (hitHard) {
      const impact = Math.abs(vehicle.speed);
      vehicle.speed *= -0.22;
      if (vehicle._hitCd <= 0 && impact > 170) {
        vehicle._hitCd = 0.4;
        damageVehicle(vehicle, impact * 0.06);
        damagePlayer(p, impact * 0.03);
      } else if (vehicle._hitCd <= 0) {
        vehicle._hitCd = 0.25;
      }
    }
    vehicle.x = clamp(vehicle.x, radius, WORLD_W - radius);
    vehicle.y = clamp(vehicle.y, radius, WORLD_H - radius);

    // Bump into other vehicles: push apart, trade some speed, dent both.
    for (const other of state.vehicles || []) {
      if (other === vehicle || other.wrecked) continue;
      const d = dist(vehicle.x, vehicle.y, other.x, other.y);
      if (d < 42 && d > 0.01) {
        const push = (42 - d) / 2;
        const ux = (vehicle.x - other.x) / d;
        const uy = (vehicle.y - other.y) / d;
        vehicle.x += ux * push;
        vehicle.y += uy * push;
        other.x -= ux * push;
        other.y -= uy * push;
        const closing = Math.abs(vehicle.speed - other.speed);
        if (closing > 140) {
          damageVehicle(vehicle, closing * 0.02);
          damageVehicle(other, closing * 0.02);
          vehicle.speed *= 0.75;
          other.speed *= 0.75;
        }
      }
    }

    // Run over pedestrians: fast hits hurt them and raise wanted (once each).
    for (const ped of state.peds || []) {
      if (ped.state === 'dead' || ped.state === 'down') continue;
      const d = dist(vehicle.x, vehicle.y, ped.x, ped.y);
      if (d < 28) {
        const spd = Math.abs(vehicle.speed);
        if (spd > 45) {
          if (typeof ped.health !== 'number') ped.health = 100;
          ped.health -= 60 + spd * 0.12;
          ped.state = 'down';
          ped.timer = 3;
          const kx = Math.cos(vehicle.angle);
          const ky = Math.sin(vehicle.angle);
          ped.x += kx * 26;
          ped.y += ky * 26;
          if (!ped._counted) {
            ped._counted = true;
            addWanted(state, 1);
          }
        } else {
          // Slow nudge: shove them aside instead of hurting them.
          const away = Math.atan2(ped.y - vehicle.y, ped.x - vehicle.x);
          ped.x += Math.cos(away) * 30 * step * 10;
          ped.y += Math.sin(away) * 30 * step * 10;
        }
      }
    }

    if (vehicle.health <= 0) explodeVehicle(state, vehicle);

    // Keep the player glued to the car (main.js does the same next step).
    if (p.inVehicle === vehicle.id || p.inVehicle === vehicle) {
      p.x = vehicle.x;
      p.y = vehicle.y;
      p.angle = vehicle.angle;
      p.speed = vehicle.speed;
      p.onFoot = false;
    }
  } else if (vehicle && vehicle.wrecked
    && (p.inVehicle === vehicle.id || p.inVehicle === vehicle)) {
    wreckVehicle(state, vehicle);
  }

  // Any car whose health hit zero this frame — rammed in a pile-up, shot
  // while parked — detonates. (The driven car is covered above; bullets
  // detonate through combat.js; this sweep catches the rest.)
  for (const v of state.vehicles || []) {
    if (!v.wrecked && typeof v.health === 'number' && v.health <= 0) {
      explodeVehicle(state, v);
    }
  }
}
