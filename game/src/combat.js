// combat.js — Melee and shooting for Porto Luz.
// Pure game logic: no browser APIs, so Node can import this file directly.
//
// Uses the shared state shape:
//   state.player = { x, y, angle, speed, onFoot, health, armor, cash, wanted,
//                    weapon: 'fists' | 'pistol', ammo, inVehicle,
//                    aimAngle, punchTimer, muzzleTimer }
//   state.bullets = [{ x, y, angle, speed, life, damage, from }]
//   state.input = { keys: {}, mouse: { x, y, down } }  (screen pixels on the
//   1280x720 canvas; converted to world coordinates through the camera)
//   state.mission = { id, stage, title, objective, target, done }
// F punches, mouse aims, click fires the pistol. Ammo is refilled when a new
// mission starts. Hitting peds or police raises wanted.
// Called by main.js as updateCombat(state, city, dt).
import * as world from './world.js';
import { addWanted } from './police.js';
import { addMessage } from './state.js';
import { CANVAS_HEIGHT, CANVAS_WIDTH } from './config.js';

export const WORLD_W = 3200;
export const WORLD_H = 3200;

const TAU = Math.PI * 2;
const PUNCH_RANGE = 48;
const PUNCH_ARC = 1.3; // radians either side of the aim direction
const PUNCH_DAMAGE = 20;
const PUNCH_COOLDOWN = 0.35;
const PISTOL_DAMAGE = 34;
const PISTOL_COOLDOWN = 0.22;
const PISTOL_AMMO_ON_MISSION = 24;
const BULLET_SPEED = 900;
const BULLET_LIFE = 0.8;

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

function isRealCity(city) {
  return !!city && Array.isArray(city.roads) && Array.isArray(city.buildings);
}

function isBlockedAt(city, x, y, r) {
  if (city && typeof city.isBlocked === 'function') return city.isBlocked(x, y, r);
  if (isRealCity(city) && typeof world.isBlocked === 'function') return world.isBlocked(city, x, y, r);
  return x < r || y < r || x > WORLD_W - r || y > WORLD_H - r;
}

function ensureCombat(state) {
  if (!state._combat) {
    state._combat = { punchCd: 0, fireCd: 0, missionId: null, noAmmoCd: 0 };
  }
  if (!Array.isArray(state.bullets)) state.bullets = [];
  return state._combat;
}

function hurtPed(state, ped, damage, fromX, fromY) {
  if (typeof ped.health !== 'number') ped.health = 100;
  ped.health -= damage;
  const away = Math.atan2(ped.y - fromY, ped.x - fromX);
  ped.x += Math.cos(away) * 16;
  ped.y += Math.sin(away) * 16;
  if (ped.health <= 0) {
    ped.state = 'dead';
    ped.timer = 5;
  } else {
    ped.state = 'flee';
    ped.panic = 1;
  }
}

function hurtCop(cop, damage) {
  if (typeof cop.health !== 'number') cop.health = cop.kind === 'car' ? 120 : 60;
  cop.health -= damage;
}

function hurtVehicle(v, damage, state) {
  if (typeof v.health !== 'number') v.health = 100;
  v.health -= damage;
  if (v.health <= 0) {
    v.wrecked = true;
    v.speed = 0;
    const p = state.player;
    if (v.driver === 'player' && p) {
      p.inVehicle = null;
      p.onFoot = true;
      p.speed = 0;
    }
    v.driver = null;
  }
}

/**
 * Melee (F) and shooting (mouse) plus bullet flight and hits.
 * Called by main.js as updateCombat(state, city, dt); the input is read
 * from state.input. (An older call shape updateCombat(state, dt, input)
 * is still accepted.)
 */
export function updateCombat(state, city, dt, input) {
  // Legacy shape: updateCombat(state, dt, input).
  if (typeof city === 'number') {
    input = dt;
    dt = city;
    city = null;
  }
  const p = state.player;
  if (!p) return;
  if (!input) input = state.input;
  const step = clamp(dt, 0, 0.05);
  const keys = (input && input.keys) || (state.input && state.input.keys) || {};
  const mouse = (input && input.mouse) || (state.input && state.input.mouse)
    || { x: 0, y: 0, down: false };
  const combat = ensureCombat(state);
  combat.punchCd = Math.max(0, combat.punchCd - step);
  combat.fireCd = Math.max(0, combat.fireCd - step);
  combat.noAmmoCd = Math.max(0, combat.noAmmoCd - step);
  p.punchTimer = Math.max(0, (p.punchTimer || 0) - step);
  p.muzzleTimer = Math.max(0, (p.muzzleTimer || 0) - step);

  // Ammo is refilled when a new mission starts.
  if (state.mission && state.mission.id && state.mission.id !== combat.missionId) {
    combat.missionId = state.mission.id;
    if (p.weapon === 'pistol') {
      p.ammo = Math.max(p.ammo || 0, PISTOL_AMMO_ON_MISSION);
    }
  }

  if (p.onFoot === false || p.inVehicle != null) {
    // No fighting from inside a car; bullets still fly.
    updateBullets(state, city, step);
    return;
  }

  // --- Aim: mouse screen pixels -> world coordinates through the camera -----
  const cam = state.camera || { x: p.x, y: p.y, zoom: 1 };
  const zoom = cam.zoom || 1;
  let aimX;
  let aimY;
  if (state.viewport && typeof state.viewport.w === 'number') {
    aimX = cam.x + (mouse.x - state.viewport.w / 2) / zoom;
    aimY = cam.y + (mouse.y - state.viewport.h / 2) / zoom;
  } else {
    aimX = cam.x + (mouse.x - CANVAS_WIDTH / 2) / zoom;
    aimY = cam.y + (mouse.y - CANVAS_HEIGHT / 2) / zoom;
  }
  const aim = Math.atan2(aimY - p.y, aimX - p.x);
  p.aimAngle = aim;

  // --- Punch (F) ---------------------------------------------------------------
  if (keys.KeyF && combat.punchCd <= 0) {
    combat.punchCd = PUNCH_COOLDOWN;
    p.punchTimer = 0.18;
    let best = null;
    let bestD = PUNCH_RANGE;
    const targets = [];
    for (const ped of state.peds || []) {
      if (ped.state === 'dead' || ped.state === 'down') continue;
      targets.push({ kind: 'ped', obj: ped, x: ped.x, y: ped.y });
    }
    for (const cop of state.police || []) {
      if (cop.kind === 'officer' && cop.health !== 0) {
        targets.push({ kind: 'cop', obj: cop, x: cop.x, y: cop.y });
      }
    }
    for (const t of targets) {
      const d = dist(p.x, p.y, t.x, t.y);
      if (d > bestD) continue;
      const toTarget = Math.atan2(t.y - p.y, t.x - p.x);
      if (Math.abs(angleDiff(aim, toTarget)) > PUNCH_ARC) continue;
      bestD = d;
      best = t;
    }
    if (best) {
      if (best.kind === 'ped') {
        hurtPed(state, best.obj, PUNCH_DAMAGE, p.x, p.y);
      } else {
        hurtCop(best.obj, PUNCH_DAMAGE);
        const away = Math.atan2(best.obj.y - p.y, best.obj.x - p.x);
        best.obj.x += Math.cos(away) * 22;
        best.obj.y += Math.sin(away) * 22;
      }
      addWanted(state, 1);
    }
  }

  // --- Shoot (mouse click) ------------------------------------------------------
  if (mouse.down && combat.fireCd <= 0 && p.weapon === 'pistol') {
    if ((p.ammo || 0) > 0) {
      p.ammo -= 1;
      combat.fireCd = PISTOL_COOLDOWN;
      p.muzzleTimer = 0.06;
      state.bullets.push({
        x: p.x + Math.cos(aim) * 22,
        y: p.y + Math.sin(aim) * 22,
        angle: aim,
        speed: BULLET_SPEED,
        life: BULLET_LIFE,
        damage: PISTOL_DAMAGE,
        from: 'player',
      });
    } else {
      combat.fireCd = 0.25; // dry click, throttled
      if (combat.noAmmoCd <= 0) {
        combat.noAmmoCd = 2;
        addMessage(state, 'Out of ammo!');
      }
    }
  }

  updateBullets(state, city, step);
}

function updateBullets(state, city, step) {
  const p = state.player;
  const bullets = state.bullets || [];
  for (let i = bullets.length - 1; i >= 0; i -= 1) {
    const b = bullets[i];
    b.x += Math.cos(b.angle) * b.speed * step;
    b.y += Math.sin(b.angle) * b.speed * step;
    b.life -= step;
    let dead = b.life <= 0;
    if (!dead && city && isBlockedAt(city, b.x, b.y, 4)) dead = true; // wall hit
    if (!dead && (b.x < 0 || b.y < 0 || b.x > WORLD_W || b.y > WORLD_H)) dead = true;

    if (!dead) {
      // Pedestrians.
      for (const ped of state.peds || []) {
        if (ped.state === 'dead' || ped.state === 'down') continue;
        if (dist(b.x, b.y, ped.x, ped.y) < 16) {
          hurtPed(state, ped, b.damage, p ? p.x : b.x, p ? p.y : b.y);
          addWanted(state, 1);
          dead = true;
          break;
        }
      }
    }
    if (!dead) {
      // Police on foot and in cars.
      for (const cop of state.police || []) {
        const radius = cop.kind === 'car' ? 26 : 16;
        if (dist(b.x, b.y, cop.x, cop.y) < radius) {
          hurtCop(cop, b.damage);
          addWanted(state, 1);
          dead = true;
          break;
        }
      }
    }
    if (!dead) {
      // Vehicles (parked, pedestrian-driven, or the player's own parked car).
      for (const v of state.vehicles || []) {
        if (v.wrecked) continue;
        if (v.driver === 'player' && p && p.inVehicle === v.id) continue;
        if (dist(b.x, b.y, v.x, v.y) < 26) {
          hurtVehicle(v, b.damage, state);
          dead = true;
          break;
        }
      }
    }
    if (dead) bullets.splice(i, 1);
  }
}
