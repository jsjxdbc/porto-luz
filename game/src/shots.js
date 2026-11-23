// Porto Luz — screenshot scenes behind ?shot=start|chase|mission|street|heist|night.
// Each scene stages a fixed, deterministic moment of the game (fixed
// positions, fixed clock, fixed wanted level) so the same seed always
// gives the same frame. The one step boot runs after staging only nudges
// things; police are staged at exactly the counts the wanted level calls
// for, and auto-seeding is switched off, so nothing random is added.
// Visual dressing (explosions, skid marks, muzzle flashes, neon pools) is
// staged as fixed coordinates on the state; render.js draws it.
//
//   start   — the title screen over the city.
//   chase   — the cover: Danny fleeing in a sports car at 5 stars, four
//             cruisers behind him, a fireball in the road, sunset light.
//   mission — The Getaway in progress: driving north to the package with
//             a 2-star tail and the waypoint marker ahead.
//   street  — on foot downtown: parked cars, pedestrians, traffic, the
//             first job waiting on the HUD.
//   heist   — The Big One: the getaway from the bank at 4 stars, dusk,
//             a blast at the bank doors and an officer firing.
//   night   — a neon-lit night cruise: sports car on a wet downtown
//             street, pink and cyan light spilling on the asphalt.

import { addMessage } from './state.js';

/** A staged explosion: {x, y, r} — render.js draws the fireball. */
function explosion(x, y, r) {
  return { x, y, r };
}

/** Deterministic smoke-and-fire particles frozen around a blast. */
function blastSmoke(x, y, r) {
  const spots = [
    [0, -r * 0.5, 16, 'rgba(255, 200, 90, 0.95)'],
    [-r * 0.4, r * 0.3, 13, 'rgba(255, 140, 40, 0.95)'],
    [r * 0.45, r * 0.2, 12, 'rgba(255, 90, 20, 0.9)'],
    [-r * 0.7, -r * 0.7, 15, 'rgba(45, 45, 52, 0.55)'],
    [r * 0.7, -r * 0.6, 14, 'rgba(45, 45, 52, 0.55)'],
    [0, -r * 1.1, 17, 'rgba(45, 45, 52, 0.5)'],
  ];
  return spots.map(([dx, dy, size, color]) => ({
    x: x + dx, y: y + dy, vx: 0, vy: -12,
    life: 1.1, maxLife: 1.1, color, size,
  }));
}

/** The mission object shape updateMissions expects (all runtime fields). */
function stagedMission(fields) {
  return {
    id: null, stage: 0, title: '', objective: '', target: null, done: false,
    kills: 0, spawned: 0, holdT: 0, timer: 0, fare: 0, banner: null, ending: null,
    ...fields,
  };
}

function car(id, x, y, angle, speed, color, model, driver) {
  return {
    id, x, y, angle, speed, color, model: model || 'sedan',
    kind: model === 'taxi' ? 'taxi' : model === 'van' ? 'truck' : 'car',
    driver: driver || null, maxSpeed: 420, accel: 300, health: 100,
    cruiseSpeed: 120, turnCooldown: 0,
  };
}

function copCar(id, x, y, angle, speed) {
  return {
    id, x, y, angle, speed, kind: 'car', color: '#e8e8e8', state: 'chase',
    health: 120, cruiseSpeed: 360, _stuckTime: 0, _reverseTimer: 0, _ramCd: 0,
    roadblock: false,
  };
}

function officer(id, x, y) {
  return {
    id, x, y, angle: 0, speed: 0, kind: 'officer', color: '#1f3a93',
    state: 'chase', health: 60,
  };
}

function ped(id, x, y, angle, color, targetX, targetY) {
  return {
    id, x, y, angle, speed: 55, color, state: 'walk',
    targetX, targetY, health: 100, panic: 0, timer: 0,
  };
}

/** Stage `shot` on a fresh state and city. */
export function setupShot(state, city, shot) {
  const p = state.player;
  // Nothing random may join the scene after staging.
  state._shotMode = true;
  state._vehiclesSeeded = true;
  state._trafficSeeded = true;
  state._policeHidden = 0;
  state._roadblockTimer = 25;

  if (shot === 'start') {
    state.flags.started = false;
    p.x = 1600;
    p.y = 1500;
    p.angle = -Math.PI / 2;
    p.cash = 250;
    return;
  }

  if (shot === 'chase') {
    // Cover: 5 wanted stars call for 4 cruisers + 4 officers (police.js's
    // table); all are staged, so the step adds none of its own. Sunset at
    // 18:15, a fireball in the road ahead, skid trails behind the car.
    state.flags.started = true;
    state.time = 615; // 18:15: the clock is START_CLOCK + time * TIME_SCALE
    p.cash = 850;
    p.health = 100;
    p.armor = 25;
    p.weapon = 'pistol';
    p.ammo = 24;
    p.wanted = 5;
    const ride = car('shot-car', 1200, 1400, 0, 380, '#e74c3c', 'sports', 'player');
    state.vehicles = [
      ride,
      car('shot-ai-1', 1520, 1400, 0, 120, '#2e6dc2', 'sedan', 'ped'),
      car('shot-ai-2', 1740, 1364, 0, 110, '#f7c948', 'taxi', 'ped'),
      car('shot-ai-3', 1900, 1364, 0, 130, '#9b59b6', 'sedan', 'ped'),
      car('shot-parked-1', 1000, 1330, 0, 0, '#7d8a96', 'sedan', null),
    ];
    p.inVehicle = 'shot-car';
    p.onFoot = false;
    p.x = ride.x;
    p.y = ride.y;
    p.angle = ride.angle;
    p.speed = ride.speed;
    state.peds = [
      ped('shot-ped-1', 1150, 1400, 0, '#7a4a8a', 1300, 1400),
      ped('shot-ped-2', 1440, 1362, Math.PI, '#4a8a5a', 1200, 1400),
    ];
    state.police = [
      copCar('shot-cop-1', 1060, 1400, 0, 330),
      copCar('shot-cop-2', 900, 1400, 0, 310),
      copCar('shot-cop-3', 1020, 1330, 0.15, 320),
      copCar('shot-cop-4', 860, 1330, -0.15, 300),
      officer('shot-off-1', 1150, 1330),
      officer('shot-off-2', 1250, 1470),
      officer('shot-off-3', 700, 1400),
      officer('shot-off-4', 1600, 1364),
    ];
    // A blast in the road just ahead of the car, with smoke and skid
    // trails behind it — the blockbuster frame.
    state.explosions = [explosion(1310, 1400, 42)];
    state.particles = blastSmoke(1310, 1400, 42);
    state.skids = [
      { x1: 1080, y1: 1390, x2: 1130, y2: 1395 },
      { x1: 1130, y1: 1395, x2: 1180, y2: 1398 },
      { x1: 1080, y1: 1410, x2: 1130, y2: 1406 },
      { x1: 1130, y1: 1406, x2: 1180, y2: 1402 },
    ];
    state.flashes = [];
    state.neon = [];
    state.mission = stagedMission({
      id: 'getaway', stage: 1, title: 'The Getaway',
      objective: 'Deliver the package to the drop-off',
      target: { x: 600, y: 600 },
    });
    addMessage(state, 'Marisol: Five stars! Lose them, Danny!', 6);
    return;
  }

  if (shot === 'mission') {
    // The Getaway, first leg: driving north up 10th Avenue to the package,
    // 2 stars behind (1 cruiser + 2 officers, per the table).
    state.flags.started = true;
    state.time = 180; // 11:00: the clock is START_CLOCK + time * TIME_SCALE
    p.cash = 550;
    p.health = 100;
    p.armor = 0;
    p.weapon = 'fists';
    p.ammo = 0;
    p.wanted = 2;
    const ride = car('shot-car', 1800, 1800, -Math.PI / 2, 300, '#16a085', 'sports', 'player');
    state.vehicles = [
      ride,
      car('shot-ai-1', 1800, 1400, -Math.PI / 2, 120, '#f1c40f', 'sedan', 'ped'),
      car('shot-ai-2', 1800, 1100, Math.PI / 2, 110, '#e8e8e8', 'sedan', 'ped'),
    ];
    p.inVehicle = 'shot-car';
    p.onFoot = false;
    p.x = ride.x;
    p.y = ride.y;
    p.angle = ride.angle;
    p.speed = ride.speed;
    state.peds = [
      ped('shot-ped-1', 1800, 1700, 0, '#8a6a4a', 1800, 1900),
    ];
    state.police = [
      copCar('shot-cop-1', 1800, 2020, -Math.PI / 2, 310),
      officer('shot-off-1', 300, 300),
      officer('shot-off-2', 2900, 400),
    ];
    state.mission = stagedMission({
      id: 'getaway', stage: 0, title: 'The Getaway',
      objective: 'Pick up the package at the north lot',
      target: { x: 1800, y: 200 },
    });
    addMessage(state, 'Marisol: Two stars and counting. Grab the package and move.', 6);
    return;
  }

  if (shot === 'street') {
    // On foot downtown at 08:00: parked cars to steal, walkers on the
    // sidewalks, one cab rolling past, the first job on the HUD.
    state.flags.started = true;
    state.time = 0; // 08:00, morning light
    p.cash = 250;
    p.health = 100;
    p.armor = 0;
    p.weapon = 'fists';
    p.ammo = 0;
    p.wanted = 0;
    p.x = 1000;
    p.y = 1000;
    p.angle = 0;
    p.onFoot = true;
    p.inVehicle = null;
    p.speed = 0;
    state.vehicles = [
      car('shot-car-1', 940, 1000, 0, 0, '#c0392b', 'sedan', null),
      car('shot-car-2', 1080, 1000, Math.PI, 0, '#2e4053', 'sedan', null),
      car('shot-taxi', 1000, 900, Math.PI / 2, 0, '#f7c948', 'taxi', null),
      car('shot-ai-1', 1000, 620, Math.PI / 2, 120, '#16a085', 'sedan', 'ped'),
    ];
    state.peds = [
      ped('shot-ped-1', 1000, 960, 0, '#7a4a8a', 1000, 1100),
      ped('shot-ped-2', 1000, 1040, Math.PI, '#4a8a5a', 1000, 900),
      ped('shot-ped-3', 1040, 1000, 0, '#8a6a4a', 1200, 1000),
      ped('shot-ped-4', 960, 1000, Math.PI / 2, '#5a6a8a', 800, 1000),
    ];
    state.police = [];
    state.mission = stagedMission({
      id: 'wheels', stage: 0, title: 'First Wheels',
      objective: 'Steal any car (walk up to one and press E)',
      target: { x: 1000, y: 1400 },
    });
    addMessage(state, "Marisol: Danny, the pier. Don't keep me waiting.", 6);
    return;
  }

  if (shot === 'heist') {
    // The Big One, escape leg: Danny fleeing west from the Luz City Bank
    // (1400, 1000) toward the safehouse at dusk, 18:45. 4 stars call for
    // 3 cruisers + 3 officers; a blast still burns at the bank doors and
    // an officer by the bank is firing.
    state.flags.started = true;
    state.time = 645; // 18:45: dusk light
    p.cash = 2750;
    p.health = 100;
    p.armor = 50;
    p.weapon = 'pistol';
    p.ammo = 30;
    p.wanted = 4;
    const ride = car('shot-car', 1150, 1000, Math.PI, 380, '#5b2a86', 'sports', 'player');
    state.vehicles = [
      ride,
      car('shot-ai-1', 900, 1000, Math.PI, 120, '#f7c948', 'taxi', 'ped'),
      car('shot-ai-2', 1600, 960, Math.PI, 110, '#2e6dc2', 'sedan', 'ped'),
      car('shot-parked-1', 700, 1070, 0, 0, '#7d8a96', 'sedan', null),
    ];
    p.inVehicle = 'shot-car';
    p.onFoot = false;
    p.x = ride.x;
    p.y = ride.y;
    p.angle = ride.angle;
    p.speed = ride.speed;
    state.peds = [
      ped('shot-ped-1', 1450, 1040, 0, '#7a4a8a', 1600, 1100),
      ped('shot-ped-2', 1470, 960, Math.PI, '#4a8a5a', 1600, 900),
    ];
    state.police = [
      copCar('shot-cop-1', 1350, 1000, Math.PI, 330),
      copCar('shot-cop-2', 1500, 1000, Math.PI, 310),
      copCar('shot-cop-3', 1300, 1070, Math.PI + 0.3, 300),
      officer('shot-off-1', 1380, 950),
      officer('shot-off-2', 1500, 1060),
      officer('shot-off-3', 1100, 1060),
    ];
    state.explosions = [explosion(1420, 990, 38)];
    state.particles = blastSmoke(1420, 990, 38);
    state.skids = [
      { x1: 1250, y1: 992, x2: 1200, y2: 996 },
      { x1: 1200, y1: 996, x2: 1175, y2: 998 },
      { x1: 1250, y1: 1008, x2: 1200, y2: 1004 },
      { x1: 1200, y1: 1004, x2: 1175, y2: 1002 },
    ];
    state.flashes = [{ x: 1372, y: 942 }];
    state.neon = [];
    state.mission = stagedMission({
      id: 'big-one', stage: 3, title: 'The Big One',
      objective: 'Lose the heat — escape to the safehouse',
      target: { x: 600, y: 600 },
    });
    addMessage(state, 'Marisol: Four stars! Run — the safehouse is the only quiet place left.', 6);
    return;
  }

  if (shot === 'night') {
    // Neon cruise at 22:00: Danny's cyan sports car rolling down a wet
    // downtown street, pink and cyan light spilling on the asphalt, the
    // taxi job waiting on the HUD. No heat — just the city at night.
    state.flags.started = true;
    state.time = 840; // 22:00: full night, neon on
    p.cash = 1200;
    p.health = 100;
    p.armor = 0;
    p.weapon = 'fists';
    p.ammo = 0;
    p.wanted = 0;
    const ride = car('shot-car', 1400, 1400, 0, 200, '#22d3ee', 'sports', 'player');
    state.vehicles = [
      ride,
      car('shot-parked-1', 1150, 1330, 0, 0, '#c0392b', 'sedan', null),
      car('shot-parked-2', 1700, 1470, Math.PI, 0, '#7a4a8a', 'sedan', null),
      car('shot-ai-1', 1800, 1400, 0, 110, '#f7c948', 'taxi', 'ped'),
      car('shot-ai-2', 1000, 1364, Math.PI, 100, '#16a085', 'sedan', 'ped'),
    ];
    p.inVehicle = 'shot-car';
    p.onFoot = false;
    p.x = ride.x;
    p.y = ride.y;
    p.angle = ride.angle;
    p.speed = ride.speed;
    state.peds = [
      ped('shot-ped-1', 1300, 1330, 0, '#7a4a8a', 1300, 1500),
      ped('shot-ped-2', 1500, 1470, Math.PI, '#4a8a5a', 1500, 1300),
      ped('shot-ped-3', 1600, 1330, 0, '#8a6a4a', 1700, 1330),
    ];
    state.police = [];
    state.explosions = [];
    state.particles = [];
    state.skids = [];
    state.flashes = [];
    state.neon = [
      { x: 1250, y: 1400, r: 90, rgb: [255, 46, 136] },
      { x: 1650, y: 1400, r: 90, rgb: [34, 211, 238] },
      { x: 1400, y: 1330, r: 70, rgb: [168, 85, 247] },
      { x: 1000, y: 1400, r: 70, rgb: [255, 46, 136] },
    ];
    state.mission = stagedMission({
      id: 'taxi', stage: 0, title: 'Taxi Fare',
      objective: 'Pick up the passenger',
      target: { x: 1400, y: 1100 },
    });
    addMessage(state, 'Marisol: The city never sleeps, Danny.', 6);
    return;
  }

  // Any other name: just start the game.
  state.flags.started = true;
}
