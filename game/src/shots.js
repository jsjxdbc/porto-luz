// Porto Luz — screenshot scenes behind ?shot=start|chase|mission|street.
// Each scene stages a fixed, deterministic moment of the game (fixed
// positions, fixed clock, fixed wanted level) so the same seed always
// gives the same frame. The one step boot runs after staging only nudges
// things; police are staged at exactly the counts the wanted level calls
// for, and auto-seeding is switched off, so nothing random is added.
//
//   start   — the title screen over the city.
//   chase   — the cover: Danny fleeing in a sports car at 3 stars, police
//             cruisers behind him, HUD, minimap and mission objective live.
//   mission — The Getaway in progress: driving north to the package with
//             a 2-star tail and the waypoint marker ahead.
//   street  — on foot downtown: parked cars, pedestrians, traffic, the
//             first job waiting on the HUD.

import { addMessage } from './state.js';

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
    // Cover: 3 wanted stars call for 2 cruisers + 2 officers (police.js's
    // table); both are staged, so the step adds none of its own.
    state.flags.started = true;
    state.time = 150; // 10:30: the clock is START_CLOCK + time * TIME_SCALE
    p.cash = 850;
    p.health = 100;
    p.armor = 25;
    p.weapon = 'pistol';
    p.ammo = 24;
    p.wanted = 3;
    const ride = car('shot-car', 1200, 1400, 0, 380, '#e74c3c', 'sports', 'player');
    state.vehicles = [
      ride,
      car('shot-ai-1', 1520, 1400, 0, 120, '#2e6dc2', 'sedan', 'ped'),
      car('shot-ai-2', 1740, 1364, 0, 110, '#f7c948', 'taxi', 'ped'),
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
      ped('shot-ped-2', 1350, 1400, Math.PI, '#4a8a5a', 1200, 1400),
    ];
    state.police = [
      copCar('shot-cop-1', 1060, 1400, 0, 330),
      copCar('shot-cop-2', 900, 1400, 0, 310),
      officer('shot-off-1', 300, 300),
      officer('shot-off-2', 2900, 400),
    ];
    state.mission = stagedMission({
      id: 'getaway', stage: 1, title: 'The Getaway',
      objective: 'Deliver the package to the drop-off',
      target: { x: 600, y: 600 },
    });
    addMessage(state, 'Marisol: Lose them, Danny!', 6);
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

  // Any other name: just start the game.
  state.flags.started = true;
}
