// explosions.js — Vehicle explosions for Porto Luz.
//
// When a vehicle's health hits 0 it detonates: a fireball of particles, a
// damage radius that hurts nearby peds, cars, police and the player, a
// synthesized boom, and a shake signal the renderer can consume
// (state.shake = { t, mag }; render.js is owned by the visuals builder).
// Chain reactions: a blast that kills another car detonates that car too.
//
// Pure logic, no browser APIs at module top level, so Node can import this
// file directly. It only reads and writes the shared `state` object:
//
//   state.vehicles[]  { id, x, y, angle, speed, driver, health, wrecked, ... }
//   state.peds[]      { x, y, health, state, panic }
//   state.police[]    { kind: 'car' | 'officer', x, y, health }
//   state.particles[] { x, y, vx, vy, life, maxLife, color, size }
//   state.player      { x, y, health, armor, inVehicle, onFoot }
//
// Called by vehicles.js (driven car / collisions), combat.js (bullets) and
// police.js (cruisers shot to pieces). This module imports only state.js
// and audio.js, so none of those callers can form an import cycle with it.

import { addMessage } from './state.js';
import { getAudio } from './audio.js';

const BLAST_RADIUS = 150;
const BLAST_VS_PED = 90;
const BLAST_VS_VEHICLE = 45;
const BLAST_VS_COP = 55;
const BLAST_VS_PLAYER = 35;

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

function damagePlayer(state, amount) {
  const p = state.player;
  if (!p) return;
  let rest = amount;
  if (p.armor > 0) {
    const absorbed = Math.min(p.armor, rest * 0.5);
    p.armor -= absorbed;
    rest -= absorbed;
  }
  p.health = Math.max(0, p.health - rest);
}

function spawnFireball(state, x, y) {
  if (!Array.isArray(state.particles)) state.particles = [];
  const fireColors = ['#ffd94a', '#ff9f1c', '#ff5e1c', '#ff3b1c', '#fff3b0'];
  for (let i = 0; i < 36; i += 1) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 60 + Math.random() * 360;
    state.particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 0.4 + Math.random() * 0.7,
      maxLife: 1.1,
      color: fireColors[Math.floor(Math.random() * fireColors.length)],
      size: 6 + Math.random() * 8,
    });
  }
  // Smoke that lingers after the flash.
  for (let i = 0; i < 14; i += 1) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 20 + Math.random() * 70;
    state.particles.push({
      x: x + (Math.random() - 0.5) * 30,
      y: y + (Math.random() - 0.5) * 30,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 30,
      life: 1.2 + Math.random() * 1.0,
      maxLife: 2.2,
      color: 'rgba(60, 60, 60, 0.7)',
      size: 12 + Math.random() * 10,
    });
  }
}

function blastDamage(state, x, y, source) {
  // Pedestrians caught in the blast.
  for (const ped of state.peds || []) {
    if (ped.state === 'dead' || ped.state === 'down') continue;
    if (dist(x, y, ped.x, ped.y) > BLAST_RADIUS) continue;
    if (typeof ped.health !== 'number') ped.health = 100;
    ped.health -= BLAST_VS_PED;
    if (ped.health <= 0) {
      ped.state = 'dead';
      ped.timer = 5;
    } else {
      ped.state = 'flee';
      ped.panic = 1;
    }
  }
  // Other vehicles: dented, and a kill chains into another blast.
  for (const v of state.vehicles || []) {
    if (v === source || v.wrecked) continue;
    if (dist(x, y, v.x, v.y) > BLAST_RADIUS) continue;
    if (typeof v.health !== 'number') v.health = 100;
    v.health -= BLAST_VS_VEHICLE;
    if (v.health <= 0) explodeVehicle(state, v);
  }
  // Police cruisers in the blast.
  for (const cop of state.police || []) {
    if (cop.kind !== 'car') continue;
    if (dist(x, y, cop.x, cop.y) > BLAST_RADIUS) continue;
    if (typeof cop.health !== 'number') cop.health = 120;
    cop.health -= BLAST_VS_COP;
  }
  // The player, on foot or just thrown clear of the wreck.
  const p = state.player;
  if (p && dist(x, y, p.x, p.y) <= BLAST_RADIUS) {
    damagePlayer(state, BLAST_VS_PLAYER);
  }
}

function detonate(state, x, y, source) {
  spawnFireball(state, x, y);
  blastDamage(state, x, y, source);
  state.shake = { t: 0.5, mag: 14 };
  try {
    const audio = getAudio();
    if (audio && typeof audio.explosion === 'function') audio.explosion();
  } catch {
    // No audio in this environment; the blast still plays visually.
  }
}

/**
 * Detonate a vehicle from state.vehicles. Marks it wrecked and exploded,
 * throws the player clear if they were driving it, and lets the blast
 * hurt everything nearby. Returns true when it blew up, false when the
 * vehicle was already gone (the chain-reaction guard).
 */
export function explodeVehicle(state, vehicle) {
  if (!vehicle || vehicle.exploded) return false;
  vehicle.exploded = true;
  vehicle.wrecked = true;
  vehicle.speed = 0;
  const p = state.player;
  if (vehicle.driver === 'player' && p) {
    p.inVehicle = null;
    p.onFoot = true;
    p.speed = 0;
    p.x = vehicle.x;
    p.y = vehicle.y;
  }
  vehicle.driver = null;
  detonate(state, vehicle.x, vehicle.y, vehicle);
  addMessage(state, 'Boom! A car just went up in flames.');
  return true;
}

/**
 * Detonate a police cruiser from state.police. The caller still removes
 * the cruiser from the list (police.js splices health <= 0 cops on its
 * next pass); this only stages the blast itself.
 */
export function explodePoliceCar(state, cop) {
  if (!cop || cop.exploded) return false;
  cop.exploded = true;
  detonate(state, cop.x, cop.y, null);
  addMessage(state, 'Boom! A police cruiser just went up in flames.');
  return true;
}
