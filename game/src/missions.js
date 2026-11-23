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
    const spot = { wheels: 'garage', getaway: 'packageSpot', payback: 'pier', 'big-one': 'bank' }[next.id];
    const at = missionLocation(city, spot);
    list.push({ id: next.id, title: next.title, briefing: next.briefing, x: at.x, y: at.y, kind: 'story' });
  }
  const stand = missionLocation(city, 'taxiStand');
  list.push({ id: 'taxi', title: 'Taxi Fare', briefing: 'Pick up a passenger, drop them off, get paid.', x: stand.x, y: stand.y, kind: 'side' });
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

function completeMission(state, def) {
  const mission = state.mission;
  const reward = mission.fare > 0 ? mission.fare : def.reward;
  state.player.cash += reward;
  if (def.ammoRefill) state.player.ammo = def.ammoRefill;
  if (!def.repeatable) state.flags.completedMissions.push(def.id);
  const banner = { title: 'JOB DONE', sub: `${def.title}  +$${reward}`, t: 4 };
  const ending = def.ending ? { lines: def.ending, t: 14 } : null;
  state.mission = idleMission();
  state.mission.banner = banner;
  state.mission.ending = ending;
  setWanted(state, 0);
  showMessage(state, `${def.title} complete — +$${reward}.`);
}

function failMission(state, reason) {
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
    completeMission(state, def);
    return;
  }

  if (typeof current.timer === 'number') {
    mission.timer -= step;
    if (mission.timer <= 0) {
      failMission(state, 'Too slow — the vault locked. The job is off.');
      return;
    }
  }
  if (typeof current.hold === 'number') {
    if (near(state, mission.target, 55) && state.player.onFoot) mission.holdT += step;
    else if (mission.holdT > 0) mission.holdT = Math.max(0, mission.holdT - step);
  }
  if (!current.check(state)) return;

  const nextStage = mission.stage + 1;
  if (nextStage >= def.steps.length) {
    completeMission(state, def);
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
