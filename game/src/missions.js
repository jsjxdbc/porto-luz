// Missions for Porto Luz: story jobs and a repeatable taxi side job.
//
// Pure logic, no browser APIs at module top level, so Node can import this
// file directly. It only reads and writes the shared `state` object:
//
//   state.player.{x,y,onFoot,health,armor,cash,wanted,weapon,ammo,inVehicle}
//   state.peds[]            (hostile rivals are {hostile:true, alive:true, ...})
//   state.mission           {id,stage,title,objective,target,done,...runtime}
//   state.flags.completedMissions   (ids of finished story jobs, in order)
//   state.messages[]        ({text, ttl} feed, aged here)
//   state.missionMenu       {open, selected}
//
// A `city` object supplies the map (world.js's generateCity: 3200x3200,
// {buildings, roads, parks, beach, water}; it has no named locations, so
// the mission spots below are fractions of the map, overridable through
// city.locations when a world provides them).
//
// Step shape: {text, target, check(state), onEnter(state, city), timer?, hold?, wanted?}
//   target: {x,y} or (state, city) => {x,y}; resolved when the step starts.
//   timer:  seconds the step allows before it fails (bank grab).
//   hold:   seconds the player must stay near the target (grabbing the cash).
//   wanted: wanted level applied when the step starts.
//
// Story order is fixed: wheels -> getaway -> payback -> big-one. The taxi
// job is always open and repeatable. Jobs start from the map markers
// (walk up and press E) or from the jobs menu (M).

import { addWanted } from './police.js';
import { isBlocked, randomRoadPoint as worldRoadPoint } from './world.js';
import { createRandom } from './random.js';
import { START_CLOCK, TIME_SCALE } from './config.js';

// 22:00 in game time: clock = START_CLOCK (08:00) + time * 60, so a night
// mission sets state.time to this value (14 hours after the 08:00 start).
const NIGHT_TIME = (22 * 3600 - START_CLOCK) / 60; // 840 seconds

const CITY_W = 3200;
const CITY_H = 3200;

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function dist(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

function near(state, point, radius) {
  if (!point) return false;
  return dist(state.player.x, state.player.y, point.x, point.y) <= radius;
}

const TAU = Math.PI * 2;

function angleDiff(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

function ordinal(n) {
  if (n === 1) return 'st';
  if (n === 2) return 'nd';
  if (n === 3) return 'rd';
  return 'th';
}

/**
 * The player's live placing in the street race: rivals rank by how many
 * checkpoints they have cleared, then by how close they are to the next
 * one (a rival who already finished counts as ahead). 1 = leading.
 */
function liveRacePlacement(state) {
  const m = state.mission;
  if (!m.checkpoints) return 1;
  const score = (cp, x, y, done) => {
    if (done) return 1e9;
    const next = m.checkpoints[Math.min(cp, m.checkpoints.length - 1)];
    return cp * 1e6 - (next ? dist(x, y, next.x, next.y) : 0);
  };
  const playerCp = m.cpIndex || 0;
  const playerNext = m.checkpoints[Math.min(playerCp, m.checkpoints.length - 1)];
  const playerScore = playerCp >= m.checkpoints.length ? 1e9
    : playerCp * 1e6 - (playerNext ? dist(state.player.x, state.player.y, playerNext.x, playerNext.y) : 0);
  let place = 1;
  for (const racer of m.racers || []) {
    if (score(racer.raceCp || 0, racer.x, racer.y, racer.raceDone) > playerScore) place += 1;
  }
  return place;
}

function inVehicle(state) {
  return !state.player.onFoot;
}

function boundsOf(city) {
  const b = (city && city.bounds) || {};
  return { width: b.width || CITY_W, height: b.height || CITY_H };
}

// Named places, as fractions of the 3200x3200 map (roads at x/y = 200, 600,
// ...; beach y 2800-2960, water from 2960). Used when city.locations lacks one.
const DEFAULT_SPOTS = {
  garage: { fx: 0.3125, fy: 0.4375 }, // (1000, 1400) downtown
  bank: { fx: 0.4375, fy: 0.3125 }, // (1400, 1000) downtown
  pier: { fx: 0.6875, fy: 0.89375 }, // (2200, 2860) on the beach
  safehouse: { fx: 0.1875, fy: 0.1875 }, // (600, 600)
  packageSpot: { fx: 0.5625, fy: 0.0625 }, // (1800, 200) north lot
  taxiStand: { fx: 0.4375, fy: 0.4375 }, // (1400, 1400)
  raceStart: { fx: 0.625, fy: 0.5625 }, // (2000, 1800) east side street
  spawn: { fx: 0.3125, fy: 0.3125 }, // (1000, 1000), the player spawn
};

export function missionLocation(city, name) {
  const placed = city && city.locations && city.locations[name];
  if (placed && typeof placed.x === 'number' && typeof placed.y === 'number') {
    return { x: placed.x, y: placed.y };
  }
  const b = boundsOf(city);
  const spot = DEFAULT_SPOTS[name] || DEFAULT_SPOTS.spawn;
  return { x: spot.fx * b.width, y: spot.fy * b.height };
}

// A point on (or near) a road, for taxi pickups and drop-offs. Prefers
// world.js's randomRoadPoint; rejects water (y >= 2960) and blocked spots;
// falls back to a road segment midpoint, then to any in-bounds point.
function randomRoadPoint(city, nearPoint, minDist, maxDist) {
  const b = boundsOf(city);
  const rng = createRandom((Math.random() * 4294967296) >>> 0);
  const roads = (city && city.roads) || [];
  const blocked = (x, y) => {
    if (y >= 2960 || x < 40 || y < 40 || x > b.width - 40 || y > b.height - 40) return true;
    try {
      return isBlocked(city, x, y, 12);
    } catch {
      return false;
    }
  };
  for (let tries = 0; tries < 30; tries += 1) {
    let point = null;
    if (roads.length > 0) {
      try {
        point = worldRoadPoint(city, rng);
      } catch {
        point = null;
      }
    }
    if (!point && roads.length > 0) {
      const road = roads[Math.floor(Math.random() * roads.length)];
      if (typeof road.x1 === 'number') {
        const along = Math.random();
        point = { x: road.x1 + (road.x2 - road.x1) * along, y: road.y1 + (road.y2 - road.y1) * along };
      } else {
        point = { x: road.x + Math.random() * road.w, y: road.y + Math.random() * road.h };
      }
    }
    if (!point) {
      point = { x: 80 + Math.random() * (b.width - 160), y: 80 + Math.random() * (b.height - 160) };
    }
    if (blocked(point.x, point.y)) continue;
    if (!nearPoint) return point;
    const d = dist(point.x, point.y, nearPoint.x, nearPoint.y);
    if (d >= minDist && d <= maxDist) return point;
  }
  // Fallback: a point at a fixed bearing from `nearPoint`, clamped to land.
  const angle = Math.random() * Math.PI * 2;
  const d = (minDist + maxDist) / 2;
  return {
    x: clamp(nearPoint.x + Math.cos(angle) * d, 60, b.width - 60),
    y: clamp(nearPoint.y + Math.sin(angle) * d, 60, Math.min(b.height - 60, 2900)),
  };
}

function setWanted(state, level) {
  // police.js owns the level; set it absolutely through its relative API.
  addWanted(state, clamp(level | 0, 0, 5) - (state.player.wanted || 0));
}

function idleMission() {
  return {
    id: null, stage: 0, title: '', objective: '', target: null, done: false,
    kills: 0, spawned: 0, holdT: 0, timer: 0, fare: 0, banner: null, ending: null,
    nightPrev: null,
  };
}

function ensureMissionState(state) {
  if (!state.mission || typeof state.mission !== 'object') state.mission = idleMission();
  if (!state.flags) state.flags = {};
  if (!Array.isArray(state.flags.completedMissions)) state.flags.completedMissions = [];
  if (!Array.isArray(state.messages)) state.messages = [];
  return state.mission;
}

function aliveHostiles(state) {
  // combat.js marks the defeated 'dead' (or 'down'); `hostile` is this
  // module's tag so civilians never count toward the fight.
  return (state.peds || []).filter((ped) => ped.hostile && ped.state !== 'dead' && ped.state !== 'down');
}

export const MISSIONS = [
  {
    id: 'wheels',
    title: 'First Wheels',
    briefing: 'Marisol needs a driver she can trust. Borrow a car — any car — and bring it to her garage.',
    reward: 300,
    steps: [
      {
        text: 'Steal any car (walk up to one and press E)',
        check: (state) => inVehicle(state),
        onEnter: (state) => showMessage(state, 'Marisol: any car will do. Just bring it to my garage.'),
      },
      {
        text: "Drive to Marisol's garage",
        target: (state, city) => missionLocation(city, 'garage'),
        check: (state) => inVehicle(state) && near(state, state.mission.target, 70),
        onEnter: (state) => showMessage(state, 'Follow the yellow marker to the garage.'),
      },
    ],
  },
  {
    id: 'getaway',
    title: 'The Getaway',
    briefing: 'A package is waiting at the north lot. Grab it and run it across town — the law will be on you the whole way.',
    reward: 600,
    wantedOnStart: 2,
    steps: [
      {
        text: 'Pick up the package at the north lot',
        target: (state, city) => missionLocation(city, 'packageSpot'),
        check: (state) => near(state, state.mission.target, 55),
        onEnter: (state) => showMessage(state, 'Two stars and counting. Grab the package and move.'),
      },
      {
        text: 'Deliver the package to the drop-off',
        target: (state, city) => missionLocation(city, 'safehouse'),
        check: (state) => near(state, state.mission.target, 65),
        onEnter: (state) => showMessage(state, 'Package secured. Now get it across town.'),
      },
    ],
  },
  {
    id: 'payback',
    title: 'Payback',
    briefing: 'Three rivals jumped one of Marisol’s couriers at the pier. Go settle it — and come back in one piece.',
    reward: 800,
    ammoRefill: 120,
    steps: [
      {
        text: 'Go to the pier',
        target: (state, city) => missionLocation(city, 'pier'),
        check: (state) => near(state, state.mission.target, 90),
        onEnter: (state) => showMessage(state, 'They are waiting at the pier. Make it hurt.'),
      },
      {
        text: 'Take down all 3 rivals',
        target: (state, city) => missionLocation(city, 'pier'),
        check: (state) => {
          const mission = state.mission;
          if (mission.kills >= 3) return true;
          return mission.spawned > 0 && aliveHostiles(state).length === 0;
        },
        onEnter: (state, city) => {
          const pier = missionLocation(city, 'pier');
          const peds = state.peds || (state.peds = []);
          const spots = [[-70, -40], [60, -70], [10, 60]];
          for (let i = 0; i < 3; i += 1) {
            peds.push({
              id: `rival-${i + 1}`,
              x: pier.x + spots[i][0], y: pier.y + spots[i][1],
              angle: 0, speed: 0, color: '#8a2f2f', state: 'idle',
              targetX: pier.x, targetY: pier.y,
              health: 100, hostile: true,
            });
          }
          state.mission.spawned = 3;
          state.mission.kills = 0;
          showMessage(state, 'Three rivals. No witnesses, no mercy.');
        },
      },
      {
        text: "Report back to Marisol's garage",
        target: (state, city) => missionLocation(city, 'garage'),
        check: (state) => near(state, state.mission.target, 70),
        onEnter: (state) => showMessage(state, 'Done. Marisol is waiting at the garage.'),
      },
    ],
  },
  {
    id: 'big-one',
    title: 'The Big One',
    briefing: 'The Luz City Bank keeps its vault light on Sunday mornings. Drive there, walk in, empty it — and outrun everything.',
    reward: 2500,
    ending: [
      'PORTO LUZ IS YOURS',
      'Danny Reyes walks out of the sunrise with $2,500 and a city that finally knows his name.',
      'Marisol smiles. The next job is already waiting.',
    ],
    steps: [
      {
        text: 'Drive to the Luz City Bank',
        target: (state, city) => missionLocation(city, 'bank'),
        check: (state) => near(state, state.mission.target, 75),
        onEnter: (state) => showMessage(state, 'Park close. Sundays the vault crew is thin.'),
      },
      {
        text: 'Get out and walk into the bank',
        target: (state, city) => missionLocation(city, 'bank'),
        check: (state) => state.player.onFoot && near(state, state.mission.target, 55),
        onEnter: (state) => showMessage(state, 'On foot now. Walk in like you own the place.'),
      },
      {
        text: 'Grab the cash — stay inside the vault (45s)',
        target: (state, city) => missionLocation(city, 'bank'),
        timer: 45,
        hold: 5,
        check: (state) => state.mission.holdT >= 5,
        onEnter: (state) => showMessage(state, 'Empty the drawers! The clock is running.'),
      },
      {
        text: 'Lose the heat — escape to the safehouse',
        target: (state, city) => missionLocation(city, 'safehouse'),
        wanted: 4,
        check: (state) => near(state, state.mission.target, 65),
        onEnter: (state) => showMessage(state, 'Four stars! Run — the safehouse is the only quiet place left.'),
      },
    ],
  },
  {
    id: 'night-run',
    title: 'Night Run',
    briefing: 'A hot package has to cross Porto Luz tonight — after dark, with three stars on you the whole way. Fast car, faster nerves.',
    reward: 1200,
    wantedOnStart: 3,
    steps: [
      {
        text: 'Meet Marisol at the garage after dark',
        target: (state, city) => missionLocation(city, 'garage'),
        check: (state) => near(state, state.mission.target, 70),
        onEnter: (state) => {
          // Night falls for the run: remember the old clock and jump to 22:00.
          // (updatePlayer recomputes clock from time every frame; the clock
          // is set here too so the state is already night before the next step.)
          state.mission.nightPrev = state.time;
          state.time = NIGHT_TIME;
          state.clock = 22 * 3600;
          showMessage(state, 'Night in Porto Luz. Three stars and a hot package — move.');
        },
      },
      {
        text: 'Pick up the package at the pier',
        target: (state, city) => missionLocation(city, 'pier'),
        check: (state) => near(state, state.mission.target, 55),
        onEnter: (state) => showMessage(state, 'Package in hand. The whole city is watching now.'),
      },
      {
        text: 'Deliver to the safehouse before dawn (150s)',
        target: (state, city) => missionLocation(city, 'safehouse'),
        timer: 150,
        failText: 'Dawn caught you — the drop went cold. The job is off.',
        check: (state) => near(state, state.mission.target, 65),
        onEnter: (state) => showMessage(state, '150 seconds. Lose the heat and get it to the safehouse.'),
      },
    ],
    // When the run ends (done or failed), give the clock back.
    onEnd: (state) => {
      if (typeof state.mission.nightPrev === 'number') {
        state.time = state.mission.nightPrev;
        state.clock = (START_CLOCK + state.mission.nightPrev * TIME_SCALE) % 86400;
      }
    },
  },
  {
    id: 'taxi',
    title: 'Taxi Fare',
    briefing: 'Someone always needs a ride in Porto Luz. Pick up the passenger and drop them off — the meter pays by distance.',
    reward: 0, // Fare is distance-based; set on state.mission.fare at drop-off time.
    repeatable: true,
    steps: [
      {
        text: 'Pick up the passenger',
        target: (state, city) => {
          if (!state.mission.pickup) {
            state.mission.pickup = randomRoadPoint(city, { x: state.player.x, y: state.player.y }, 150, 700);
          }
          return state.mission.pickup;
        },
        check: (state) => near(state, state.mission.target, 55),
        onEnter: (state) => showMessage(state, 'Passenger waiting at the yellow marker.'),
      },
      {
        text: 'Drop the passenger at the destination',
        target: (state, city) => {
          if (!state.mission.dropoff) {
            state.mission.dropoff = randomRoadPoint(city, state.mission.pickup, 350, 900);
            const d = dist(
              state.mission.pickup.x, state.mission.pickup.y,
              state.mission.dropoff.x, state.mission.dropoff.y,
            );
            state.mission.fare = clamp(20 + Math.round(d / 25), 20, 60);
          }
          return state.mission.dropoff;
        },
        check: (state) => near(state, state.mission.target, 55),
        onEnter: (state) => showMessage(state, 'Passenger aboard. Drive smooth — the meter is running.'),
      },
    ],
  },
  {
    id: 'race',
    title: 'Street Race',
    briefing: 'Three rivals, five checkpoints, one winner. First across the line takes the pot — last takes the long way home.',
    reward: 0, // Prize is set on state.mission.fare by placement at the finish.
    repeatable: true,
    requiresVehicle: true,
    steps: [
      {
        text: 'Race the checkpoints — beat all 3 rivals',
        timer: 300,
        failText: 'Out of time — the rivals took the pot. The race is over.',
        target: (state) => {
          const m = state.mission;
          return m.checkpoints && m.checkpoints[m.cpIndex] ? m.checkpoints[m.cpIndex] : null;
        },
        check: (state) => !!state.mission.raceDone,
        onEnter: (state, city) => {
          const m = state.mission;
          // Five checkpoints: the first near the player, each next a
          // few blocks further on (all on roads, never in the water).
          const points = [];
          let from = { x: state.player.x, y: state.player.y };
          for (let i = 0; i < 5; i += 1) {
            const next = randomRoadPoint(city, from, i === 0 ? 150 : 450, i === 0 ? 400 : 900);
            points.push(next);
            from = next;
          }
          m.checkpoints = points;
          m.cpIndex = 0;
          m.raceFinishers = [];
          m.raceDone = false;
          m.target = points[0];
          // Three AI rivals in sports cars, each with their own pace.
          const names = ['Vex', 'Roxy', 'Turbo'];
          const colors = ['#e74c3c', '#9b59b6', '#f39c12'];
          m.racers = names.map((name, i) => {
            const spot = randomRoadPoint(city, { x: state.player.x, y: state.player.y }, 60, 160);
            return {
              id: `race-${i + 1}`,
              x: spot.x, y: spot.y,
              angle: Math.atan2(points[0].y - spot.y, points[0].x - spot.x),
              speed: 0, color: colors[i], kind: 'car', model: 'sports',
              driver: 'ped', maxSpeed: 520, accel: 340, health: 100,
              racer: true, raceCp: 0, raceSpeed: 375 + i * 20,
              raceDone: false, raceName: name, cruiseSpeed: 0, turnCooldown: 0,
            };
          });
          for (const racer of m.racers) state.vehicles.push(racer);
          showMessage(state, 'Green light! Five checkpoints — beat Vex, Roxy and Turbo.');
        },
      },
    ],
    // Every frame of the race: drive the rivals, advance the player's
    // checkpoints, and keep the objective line (and the map marker) current.
    update: (state, city, dt) => {
      const m = state.mission;
      const step = dt || 0;
      if (!m.checkpoints || m.raceDone) return;
      // --- Rivals: steer at their next checkpoint, dodge walls. ---
      for (const racer of m.racers || []) {
        if (racer.wrecked || racer.raceDone) continue;
        const cp = m.checkpoints[racer.raceCp];
        if (!cp) {
          racer.raceDone = true;
          continue;
        }
        const desired = Math.atan2(cp.y - racer.y, cp.x - racer.x);
        const probeX = racer.x + Math.cos(racer.angle) * 70;
        const probeY = racer.y + Math.sin(racer.angle) * 70;
        const targetAngle = isBlocked(city, probeX, probeY, 18) ? racer.angle + 1.4 : desired;
        const turn = clamp(angleDiff(racer.angle, targetAngle), -1, 1);
        racer.angle += turn * 2.2 * step;
        if (racer.speed < racer.raceSpeed) {
          racer.speed = Math.min(racer.raceSpeed, racer.speed + 320 * step);
        }
        const nx = racer.x + Math.cos(racer.angle) * racer.speed * step;
        const ny = racer.y + Math.sin(racer.angle) * racer.speed * step;
        if (!isBlocked(city, nx, racer.y, 18)) racer.x = nx;
        if (!isBlocked(city, racer.x, ny, 18)) racer.y = ny;
        racer.x = clamp(racer.x, 20, CITY_W - 20);
        racer.y = clamp(racer.y, 20, CITY_H - 20);
        if (dist(racer.x, racer.y, cp.x, cp.y) <= 70) {
          racer.raceCp += 1;
          if (racer.raceCp >= m.checkpoints.length) {
            racer.raceDone = true;
            m.raceFinishers.push(racer.raceName);
            showMessage(state, `${racer.raceName} finished the race!`);
          }
        }
      }
      // --- The player: crossing a checkpoint advances the race. ---
      if (m.cpIndex < m.checkpoints.length) {
        const cp = m.checkpoints[m.cpIndex];
        if (cp && near(state, cp, 70)) {
          m.cpIndex += 1;
          if (m.cpIndex >= m.checkpoints.length) {
            const place = 1 + (m.raceFinishers || []).length;
            const prizes = [400, 300, 200, 150];
            m.fare = prizes[place - 1];
            m.raceDone = true;
            showMessage(state, `You finished ${place}${ordinal(place)} — +$${m.fare}!`);
          } else {
            showMessage(state, `Checkpoint ${m.cpIndex}/${m.checkpoints.length}!`);
            m.target = m.checkpoints[m.cpIndex];
          }
        }
      }
      // --- Objective line: checkpoint count and live placing. ---
      const place = liveRacePlacement(state);
      m.objective = `Checkpoint ${Math.min(m.cpIndex + 1, m.checkpoints.length)}/${m.checkpoints.length} — ${place}${ordinal(place)} place`;
    },
    // The race is over: the rivals go back to being ordinary traffic.
    onEnd: (state) => {
      for (const racer of state.mission.racers || []) {
        delete racer.racer;
        racer.cruiseSpeed = 150;
        racer.speed = Math.min(racer.speed, 150);
      }
      state.mission.racers = [];
      state.mission.checkpoints = [];
    },
  },
];

export function missionById(id) {
  return MISSIONS.find((mission) => mission.id === id) || null;
}

function nextStoryMission(state) {
  const done = ensureMissionState(state) && state.flags.completedMissions;
  const story = MISSIONS.filter((mission) => !mission.repeatable);
  return story.find((mission) => !done.includes(mission.id)) || null;
}

/**
 * Jobs the player can start right now, for the map markers and the jobs
 * menu: the next story job (if any) plus the repeatable taxi job.
 */
export function availableMissions(state, city) {
  ensureMissionState(state);
  const list = [];
  const next = nextStoryMission(state);
  if (next) {
    const spot = { wheels: 'garage', getaway: 'packageSpot', payback: 'pier', 'big-one': 'bank', 'night-run': 'garage' }[next.id];
    const at = missionLocation(city, spot);
    list.push({ id: next.id, title: next.title, briefing: next.briefing, x: at.x, y: at.y, kind: 'story' });
  }
  const stand = missionLocation(city, 'taxiStand');
  list.push({ id: 'taxi', title: 'Taxi Fare', briefing: 'Pick up a passenger, drop them off, get paid.', x: stand.x, y: stand.y, kind: 'side' });
  const raceAt = missionLocation(city, 'raceStart');
  list.push({ id: 'race', title: 'Street Race', briefing: 'Five checkpoints, three rivals. Fastest wins the pot.', x: raceAt.x, y: raceAt.y, kind: 'side' });
  return list;
}

/** Closest startable job marker within `maxDist` of the player, else null. */
export function nearestMarker(state, city, maxDist) {
  const range = maxDist || 90;
  let best = null;
  let bestDist = Infinity;
  for (const marker of availableMissions(state, city)) {
    const d = dist(state.player.x, state.player.y, marker.x, marker.y);
    if (d <= range && d < bestDist) {
      best = marker;
      bestDist = d;
    }
  }
  return best === null ? null : { ...best, dist: bestDist };
}

function resolveTarget(step, state, city) {
  if (!step.target) return null;
  return typeof step.target === 'function' ? step.target(state, city) : step.target;
}

function enterStep(state, city, def, stageIndex) {
  const mission = state.mission;
  const step = def.steps[stageIndex];
  mission.stage = stageIndex;
  mission.objective = step.text;
  mission.target = resolveTarget(step, state, city);
  mission.holdT = 0;
  mission.timer = typeof step.timer === 'number' ? step.timer : 0;
  if (typeof step.wanted === 'number') setWanted(state, step.wanted);
  if (typeof step.onEnter === 'function') step.onEnter(state, city);
}

export function showMessage(state, text) {
  if (!Array.isArray(state.messages)) state.messages = [];
  state.messages.push({ text, ttl: 4 });
  while (state.messages.length > 5) state.messages.shift();
}

/**
 * Start a job. Returns true when it started. Refuses when another job is
 * running or a story job is locked behind an earlier one. `city` is
 * optional; targets that need it resolve again on the first update.
 */
export function startMission(state, id, city) {
  ensureMissionState(state);
  const def = missionById(id);
  if (!def) return false;
  if (state.mission.id) {
    showMessage(state, 'Finish your current job first.');
    return false;
  }
  if (!def.repeatable) {
    const next = nextStoryMission(state);
    if (!next || next.id !== id) {
      showMessage(state, 'That job is not open yet.');
      return false;
    }
  }
  if (def.requiresVehicle && state.player.onFoot) {
    showMessage(state, 'You need a car for this one — steal one first.');
    return false;
  }
  state.mission = idleMission();
  state.mission.id = def.id;
  state.mission.title = def.title;
  if (def.wantedOnStart) setWanted(state, def.wantedOnStart);
  showMessage(state, `${def.title}: ${def.briefing}`);
  enterStep(state, city, def, 0);
  return true;
}

/** Combat (or any system) calls this when a hostile goes down. Combat does
 *  not call it yet — the payback check reads ped states directly — but the
 *  hook stays for a future wiring. */
export function onOpponentDown(state) {
  const mission = ensureMissionState(state);
  if (mission.id === 'payback' && mission.stage === 1) mission.kills += 1;
}

function completeMission(state, def, city) {
  const mission = state.mission;
  const reward = mission.fare > 0 ? mission.fare : def.reward;
  state.player.cash += reward;
  if (def.ammoRefill) state.player.ammo = def.ammoRefill;
  if (!def.repeatable) state.flags.completedMissions.push(def.id);
  if (typeof def.onEnd === 'function') def.onEnd(state, city);
  const banner = { title: 'JOB DONE', sub: `${def.title}  +$${reward}`, t: 4 };
  const ending = def.ending ? { lines: def.ending, t: 14 } : null;
  state.mission = idleMission();
  state.mission.banner = banner;
  state.mission.ending = ending;
  setWanted(state, 0);
  showMessage(state, `${def.title} complete — +$${reward}.`);
}

function failMission(state, def, reason, city) {
  if (def && typeof def.onEnd === 'function') def.onEnd(state, city);
  showMessage(state, reason);
  state.mission = idleMission();
  setWanted(state, Math.min(state.player.wanted, 2));
}

/**
 * Advance the active job one frame. Call every tick with the frame's dt.
 * Also ages the message feed and the job-complete banner / ending card.
 */
export function updateMissions(state, city, dt) {
  const mission = ensureMissionState(state);
  const step = dt || 0;

  // Age the message feed. Entries are {text, ttl} (state.js's shape);
  // plain strings (police.js / combat.js push those) are normalised first.
  for (let i = 0; i < state.messages.length; i += 1) {
    if (typeof state.messages[i] === 'string') {
      state.messages[i] = { text: state.messages[i], ttl: 4 };
    } else if (typeof state.messages[i].ttl !== 'number') {
      state.messages[i].ttl = typeof state.messages[i].t === 'number' ? Math.max(0, 4 - state.messages[i].t) : 4;
    }
  }
  for (const message of state.messages) message.ttl -= step;
  state.messages = state.messages.filter((message) => message.ttl > 0);
  if (mission.banner) {
    mission.banner.t -= step;
    if (mission.banner.t <= 0) mission.banner = null;
  }
  if (mission.ending) {
    mission.ending.t -= step;
    if (mission.ending.t <= 0) mission.ending = null;
  }
  if (!mission.id) return;

  const def = missionById(mission.id);
  if (!def) return; // A foreign mission (e.g. a staged scene): leave it alone.
  const current = def.steps[mission.stage];
  if (!current) {
    completeMission(state, def, city);
    return;
  }

  if (typeof current.timer === 'number') {
    mission.timer -= step;
    if (mission.timer <= 0) {
      failMission(state, def, current.failText || 'Too slow — the vault locked. The job is off.', city);
      return;
    }
  }
  if (typeof current.hold === 'number') {
    if (near(state, mission.target, 55) && state.player.onFoot) mission.holdT += step;
    else if (mission.holdT > 0) mission.holdT = Math.max(0, mission.holdT - step);
  }
  // A mission with its own per-frame logic (the street race drives its
  // rivals and watches its checkpoints here) runs it before the check.
  if (typeof def.update === 'function') def.update(state, city, step);
  if (!current.check(state)) return;

  const nextStage = mission.stage + 1;
  if (nextStage >= def.steps.length) {
    completeMission(state, def, city);
    return;
  }
  enterStep(state, city, def, nextStage);
}

// ---- Jobs menu (M key) -------------------------------------------------

export function toggleMissionMenu(state) {
  ensureMissionState(state);
  if (!state.missionMenu) state.missionMenu = { open: false, selected: 0 };
  state.missionMenu.open = !state.missionMenu.open;
  state.missionMenu.selected = 0;
  return state.missionMenu.open;
}

export function isMissionMenuOpen(state) {
  return !!(state.missionMenu && state.missionMenu.open);
}

export function menuMove(state, direction) {
  if (!isMissionMenuOpen(state)) return;
  const count = availableMissions(state).length;
  const menu = state.missionMenu;
  menu.selected = (menu.selected + direction + count) % count;
}

export function menuConfirm(state, city) {
  if (!isMissionMenuOpen(state)) return false;
  const jobs = availableMissions(state, city);
  const job = jobs[state.missionMenu.selected] || jobs[0];
  state.missionMenu.open = false;
  return startMission(state, job.id, city);
}
