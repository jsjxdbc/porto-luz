// Porto Luz — boot and the one fixed-step loop: input is read every frame,
// the world advances in fixed 1/60 s steps (several in a slow frame, none
// in a fast one), and the renderer paints what is there. The game moves
// between four screens: title, play, paused and game over.
//
// ?seed=N fixes the city. ?shot=start|play|end (with &seed=N) stages that
// scene instead of running the loop, paints it twice and sets
// window.__shotReady for a screenshot.
//
// Systems: the main loop never imports the other builders' modules
// directly. It keeps a `systems` registry of { name, update(state, city, dt) }
// and loads them by dynamic import, so a module that is not written yet is
// simply skipped and the core loop still runs. The agreed update signature
// is update(state, city, dt); the core player/camera update lives here.

import {
  CAMERA_ZOOM_FOOT,
  CAMERA_ZOOM_VEHICLE,
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  MAX_FRAME,
  PLAYER_RADIUS,
  PLAYER_RUN_SPEED,
  PLAYER_WALK_SPEED,
  START_CLOCK,
  STEP,
  TIME_SCALE,
} from './config.js';
import { addMessage, applySave, createState, loadGame, saveGame } from './state.js';
import { WORLD, generateCity, isBlocked } from './world.js';
import { createInput } from './input.js';
import { render } from './render.js';
import { renderHUD } from './hud.js';
import { setupShot } from './shots.js';
import {
  isMissionMenuOpen,
  menuConfirm,
  menuMove,
  nearestMarker,
  startMission,
  toggleMissionMenu,
} from './missions.js';

/** The update systems, in the order they run each step. */
export const systems = [];
const failedSystems = new Set();

/** [file, exported update function] for the other builders' systems. */
const SYSTEM_MODULES = [
  ['vehicles', 'updateVehicles'],
  ['traffic', 'updateTraffic'],
  ['police', 'updatePolice'],
  ['combat', 'updateCombat'],
  ['missions', 'updateMissions'],
  ['audio', 'updateAudio'],
];

/**
 * How each system is called. Most take (state, city, dt); vehicles takes
 * (state, city, dt, input), so it is adapted here. `input` is always
 * state.input. Combat takes the same four arguments since it reads the
 * input for punching and shooting (an older three-argument call shape is
 * still accepted by combat.js, but it loses wall checks for bullets).
 */
const SYSTEM_ADAPTERS = {
  combat: (fn) => (state, city, dt) => fn(state, city, dt, state.input),
  vehicles: (fn) => (state, city, dt) => fn(state, city, dt, state.input),
};

/** Load every system module that exists; a missing one is skipped, not fatal. */
async function loadSystems() {
  for (const [file, fn] of SYSTEM_MODULES) {
    try {
      const mod = await import(`./${file}.js`);
      if (typeof mod[fn] !== 'function') continue;
      const adapter = SYSTEM_ADAPTERS[file];
      systems.push({ name: file, update: adapter ? adapter(mod[fn]) : mod[fn] });
    } catch {
      // Not written yet — the core loop runs without it.
    }
  }
}

function moveWithCollision(p, city, vx, vy) {
  if (!isBlocked(city, p.x + vx, p.y, PLAYER_RADIUS)) p.x += vx;
  if (!isBlocked(city, p.x, p.y + vy, PLAYER_RADIUS)) p.y += vy;
}

function nearestVehicle(state, maxDist) {
  const p = state.player;
  let best = null;
  let bestD = maxDist;
  for (const v of state.vehicles) {
    const d = Math.hypot(v.x - p.x, v.y - p.y);
    if (d < bestD) {
      bestD = d;
      best = v;
    }
  }
  return best;
}

function findExitSpot(city, v) {
  const offsets = [
    { x: -Math.sin(v.angle) * 34, y: Math.cos(v.angle) * 34 },
    { x: Math.sin(v.angle) * 34, y: -Math.cos(v.angle) * 34 },
    { x: -Math.cos(v.angle) * 40, y: -Math.sin(v.angle) * 40 },
    { x: Math.cos(v.angle) * 40, y: Math.sin(v.angle) * 40 },
  ];
  for (const o of offsets) {
    const x = v.x + o.x;
    const y = v.y + o.y;
    if (!isBlocked(city, x, y, PLAYER_RADIUS)) return { x, y };
  }
  return { x: v.x, y: v.y };
}

/** A short fist swing: cosmetic particles only; combat handles any damage. */
function swingFist(state) {
  const p = state.player;
  for (let i = -1; i <= 1; i += 1) {
    const a = p.angle + i * 0.35;
    state.particles.push({
      x: p.x + Math.cos(a) * 26,
      y: p.y + Math.sin(a) * 26,
      vx: Math.cos(a) * 120,
      vy: Math.sin(a) * 120,
      life: 0.18,
      maxLife: 0.18,
      color: 'rgba(255, 255, 255, 0.9)',
      size: 5,
    });
  }
}

/** Core player update: on-foot movement, getting in/out of cars, the clock. */
function updatePlayer(state, city, dt) {
  const p = state.player;
  const input = state.input;
  if (!state.flags.started || state.flags.paused || state.flags.gameOver) return;
  state.time += dt;
  state.clock = (START_CLOCK + state.time * TIME_SCALE) % 86400;

  if (p.onFoot) {
    let dx = 0;
    let dy = 0;
    if (input.down('up')) dy -= 1;
    if (input.down('down')) dy += 1;
    if (input.down('left')) dx -= 1;
    if (input.down('right')) dx += 1;
    if (dx !== 0 || dy !== 0) {
      const len = Math.hypot(dx, dy);
      const speed = input.down('run') ? PLAYER_RUN_SPEED : PLAYER_WALK_SPEED;
      p.angle = Math.atan2(dy, dx);
      p.speed = speed;
      moveWithCollision(p, city, (dx / len) * speed * dt, (dy / len) * speed * dt);
    } else {
      p.speed = 0;
    }
    if (input.pressed('enterVehicle')) {
      // A job marker beats a car door: E starts the job waiting here.
      const marker = nearestMarker(state, city, 90);
      if (marker && startMission(state, marker.id, city)) return;
      const v = nearestVehicle(state, 80);
      if (v) {
        p.inVehicle = v.id;
        p.onFoot = false;
        v.driver = 'player';
        addMessage(state, 'You took the car.');
      }
    }
    if (input.pressed('punch')) swingFist(state);
  } else {
    // Driving: the vehicles system moves the car; the player rides along.
    const v = state.vehicles.find((car) => car.id === p.inVehicle);
    if (!v) {
      p.onFoot = true;
      p.inVehicle = null;
    } else {
      p.x = v.x;
      p.y = v.y;
      p.angle = v.angle;
      p.speed = v.speed || 0;
      if (input.pressed('enterVehicle')) {
        const spot = findExitSpot(city, v);
        p.x = spot.x;
        p.y = spot.y;
        p.onFoot = true;
        p.inVehicle = null;
        v.driver = null;
        v.speed = 0;
      }
    }
  }
}

function updateCamera(state, dt) {
  const p = state.player;
  const targetZoom = p.onFoot ? CAMERA_ZOOM_FOOT : CAMERA_ZOOM_VEHICLE;
  state.camera.zoom += (targetZoom - state.camera.zoom) * Math.min(1, dt * 3);
  const vw = CANVAS_WIDTH / state.camera.zoom;
  const vh = CANVAS_HEIGHT / state.camera.zoom;
  state.camera.x =
    vw >= WORLD.width ? WORLD.width / 2 : Math.min(Math.max(p.x, vw / 2), WORLD.width - vw / 2);
  state.camera.y =
    vh >= WORLD.height ? WORLD.height / 2 : Math.min(Math.max(p.y, vh / 2), WORLD.height - vh / 2);
}

/** One fixed step: core player update, then every registered system. */
function step(state, city, dt) {
  updatePlayer(state, city, dt);
  for (const sys of systems) {
    if (failedSystems.has(sys.name)) continue;
    try {
      sys.update(state, city, dt);
    } catch (err) {
      failedSystems.add(sys.name);
      console.error(`Porto Luz: system ${sys.name} failed and was disabled`, err);
    }
  }
  for (const pt of state.particles) {
    pt.x += pt.vx * dt;
    pt.y += pt.vy * dt;
    pt.life -= dt;
  }
  state.particles = state.particles.filter((pt) => pt.life > 0);
  // The message feed is aged by updateMissions (which also normalises the
  // plain strings other systems push); aging it here too would halve its life.
  // Death is GTA-style and handled by the police system (hospital respawn
  // on wasted, station respawn on busted) — never a game-over screen.
  updateCamera(state, dt);
}

async function boot() {
  const params = new URLSearchParams(window.location.search);
  const shot = params.get('shot');
  const seedParam = Number.parseInt(params.get('seed') ?? '', 10);
  const seed = Number.isInteger(seedParam) ? seedParam : Math.floor(Math.random() * 4294967296);

  const canvas = document.getElementById('game');
  const status = document.getElementById('status');
  const ctx = canvas.getContext('2d');
  const input = createInput(canvas);

  let state = createState(seed);
  let city = generateCity(seed);
  state.input = input;
  // The combat system converts mouse pixels to world coordinates through
  // this; the canvas is always 1280x720.
  state.viewport = { w: CANVAS_WIDTH, h: CANVAS_HEIGHT };
  state.flags.hasSave = loadGame() !== null;

  const announce = (message) => {
    status.textContent = message;
  };

  await loadSystems();

  window.__game = { state, city, systems };

  function resetGame() {
    state = createState(seed);
    city = generateCity(seed);
    state.input = input;
    state.viewport = { w: CANVAS_WIDTH, h: CANVAS_HEIGHT };
    state.flags.hasSave = loadGame() !== null;
    window.__game.state = state;
    window.__game.city = city;
    failedSystems.clear();
  }

  // Screenshot mode: stage the scene, paint it twice, report ready.
  if (shot) {
    setupShot(state, city, shot);
    step(state, city, STEP);
    render(ctx, state, city);
    renderHUD(ctx, state, city);
    render(ctx, state, city);
    renderHUD(ctx, state, city);
    window.__shotReady = true;
    return;
  }

  let last = performance.now();
  let accumulator = 0;
  let lastSave = 0;

  function handleGlobalKeys() {
    const f = state.flags;
    if (!f.started) {
      if (input.pressed('confirm') || input.mouse.down) {
        f.started = true;
        addMessage(state, 'Marisol: First job — meet me at the pier, Danny.', 6);
        announce('Playing.');
      } else if (input.pressed('load')) {
        const data = loadGame();
        if (data) {
          applySave(state, data);
          f.started = true;
          addMessage(state, 'Save loaded.');
          announce('Playing.');
        }
      }
      return;
    }
    // Jobs menu (M): arrows move, Enter/E starts the selected job, M/Esc closes.
    if (isMissionMenuOpen(state)) {
      if (input.pressed('up')) menuMove(state, -1);
      else if (input.pressed('down')) menuMove(state, 1);
      else if (input.pressed('confirm') || input.pressed('enterVehicle')) menuConfirm(state, city);
      else if (input.pressed('missions') || input.pressed('pause')) toggleMissionMenu(state);
      return;
    }
    if (input.pressed('missions')) {
      toggleMissionMenu(state);
      return;
    }
    if (f.paused) {
      if (input.pressed('pause')) {
        f.paused = false;
        announce('Playing.');
      } else if (input.pressed('restart')) {
        resetGame();
        announce('Porto Luz. Press Enter to start.');
      }
      return;
    }
    if (input.pressed('pause')) {
      f.paused = !f.paused;
      announce(f.paused ? 'Paused.' : 'Playing.');
    }
  }

  function frame(now) {
    requestAnimationFrame(frame);
    const elapsed = Math.min((now - last) / 1000, MAX_FRAME);
    last = now;
    handleGlobalKeys();
    // The jobs menu freezes the world like a pause, without the pause flag.
    if (state.flags.started && !state.flags.paused && !isMissionMenuOpen(state)) {
      accumulator += elapsed;
      let guard = 0;
      while (accumulator >= STEP && guard < 8) {
        step(state, city, STEP);
        accumulator -= STEP;
        guard += 1;
      }
      if (guard >= 8) accumulator = 0;
      if (state.time - lastSave >= 30) {
        lastSave = state.time;
        saveGame(state);
      }
    } else {
      accumulator = 0;
    }
    render(ctx, state, city);
    renderHUD(ctx, state, city);
    input.endFrame();
  }

  // Leaving the tab pauses a running game rather than letting it run unseen.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.flags.started && !state.flags.paused) {
      state.flags.paused = true;
      announce('Paused.');
    }
  });

  announce('Porto Luz. Press Enter to start.');
  requestAnimationFrame(frame);
}

// Boot in a browser; in Node (syntax check) `document` is undefined, so
// importing this module has no side effects.
if (typeof document !== 'undefined') {
  boot();
}
