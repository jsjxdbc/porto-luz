// Porto Luz — the single shared state object, plus save/load.
// Every system (vehicles, traffic, police, combat, missions, audio) reads
// and writes this one object, so the field shapes below are the contract
// all builders code against. Do not rename these fields.
//
// Shared entity shapes:
//   vehicle: { id, x, y, angle, speed, color, kind: 'car'|'taxi'|'truck'|'bike',
//              driver: null|'player'|'ped', maxSpeed, accel }
//   ped:     { id, x, y, angle, speed, color, state: 'walk'|'idle'|'flee',
//              targetX, targetY }
//   police:  { id, x, y, angle, speed, color, kind: 'car'|'officer',
//              state: 'patrol'|'chase'|'arrest' }
//   particle:{ x, y, vx, vy, life, maxLife, color, size }
//   mission.target is { x, y } in world coordinates, or null.
//
// Browser APIs (localStorage) are only touched inside functions, never at
// the top level, so Node can import this module for a syntax check.

import { SAVE_KEY, START_CASH, START_CLOCK } from './config.js';

/** The fresh state for a new game. `seed` drives the city generation. */
export function createState(seed = 1) {
  return {
    seed,
    time: 0,
    clock: START_CLOCK,
    player: {
      x: 1000,
      y: 1000,
      angle: -Math.PI / 2,
      speed: 0,
      onFoot: true,
      health: 100,
      armor: 0,
      cash: START_CASH,
      wanted: 0,
      weapon: 'fists',
      ammo: 0,
      inVehicle: null,
    },
    vehicles: [],
    peds: [],
    police: [],
    particles: [],
    mission: { id: null, stage: 0, title: '', objective: '', target: null, done: false },
    camera: { x: 1000, y: 1000, zoom: 1 },
    input: { keys: {}, mouse: { x: 0, y: 0, down: false } },
    flags: { started: false, paused: false, gameOver: false, busted: false, wasted: false },
    messages: [],
  };
}

/** Push a short on-screen message (oldest drops off after five). */
export function addMessage(state, text, ttl = 4) {
  state.messages.push({ text, ttl });
  if (state.messages.length > 5) state.messages.shift();
}

/** Save the player's progress to localStorage. Returns false if it fails. */
export function saveGame(state) {
  try {
    const data = {
      seed: state.seed,
      time: state.time,
      clock: state.clock,
      player: { ...state.player },
      mission: { ...state.mission },
    };
    window.localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

/** Load saved progress, or null when there is no save (or it is corrupt). */
export function loadGame() {
  try {
    const raw = window.localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !data.player) return null;
    return data;
  } catch {
    return null;
  }
}

/** Apply a loaded save onto a fresh state object. */
export function applySave(state, data) {
  state.seed = data.seed ?? state.seed;
  state.time = data.time ?? 0;
  state.clock = data.clock ?? START_CLOCK;
  Object.assign(state.player, data.player);
  if (data.mission) Object.assign(state.mission, data.mission);
}
