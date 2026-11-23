// Porto Luz — the city: a road grid, block buildings, parks, a south beach
// and the sea. Pure module: no browser APIs at the top level, so Node can
// import it directly for a syntax check.
//
// Layout (3200x3200): vertical roads at x = 200, 600, ... 3000 and
// horizontal roads at y = 200, 600, ... 2600, each 72 wide. The blocks
// between them hold 1-4 buildings; three interior blocks are parks. The
// strip along the south edge is beach (y 2800-2960) and then water
// (y 2960-3200), which blocks movement.

import { createRandom } from './random.js';
import { ROOF_COLORS } from './config.js';

export const WORLD = { width: 3200, height: 3200 };

const ROAD_WIDTH = 72;
const ROAD_HALF = ROAD_WIDTH / 2;
const ROAD_CENTERS_X = [200, 600, 1000, 1400, 1800, 2200, 2600, 3000];
const ROAD_CENTERS_Y = [200, 600, 1000, 1400, 1800, 2200, 2600];
const BEACH_TOP = 2800;
const WATER_TOP = 2960;

/** Block spans between neighbouring roads (edge strips included). */
function blockBounds(centers, limit) {
  const out = [];
  let prev = 0;
  for (const c of centers) {
    out.push([prev, c - ROAD_HALF]);
    prev = c + ROAD_HALF;
  }
  out.push([prev, limit]);
  return out;
}

/**
 * Build the city for a seed. Returns
 * { buildings: [{x,y,w,h,roof}], roads: [{x1,y1,x2,y2,w,vertical}],
 *   parks: [{x,y,w,h,trees:[{x,y,r}]}], beach: {x,y,w,h}, water: {x,y,w,h},
 *   bounds: {width,height}, locations: {garage,bank,pier,safehouse,
 *   packageSpot,taxiStand,spawn} }.
 * `locations` names the mission places explicitly; systems that do not know
 * them fall back to their own fractions of the same map.
 */
export function generateCity(seed) {
  const rng = createRandom(seed);
  const roads = [];
  for (const x of ROAD_CENTERS_X) {
    // Vertical roads stop at the beach; they never run into the sea.
    roads.push({ x1: x, y1: 0, x2: x, y2: BEACH_TOP, w: ROAD_WIDTH, vertical: true });
  }
  for (const y of ROAD_CENTERS_Y) {
    roads.push({ x1: 0, y1: y, x2: WORLD.width, y2: y, w: ROAD_WIDTH, vertical: false });
  }

  const colBounds = blockBounds(ROAD_CENTERS_X, WORLD.width);
  const rowBounds = blockBounds(ROAD_CENTERS_Y, BEACH_TOP);

  // Three interior blocks become parks.
  const parkCells = new Set();
  while (parkCells.size < 3) {
    const c = rng.int(1, colBounds.length - 2);
    const r = rng.int(1, rowBounds.length - 2);
    parkCells.add(`${c}:${r}`);
  }

  const buildings = [];
  const parks = [];
  colBounds.forEach(([x0, x1], c) => {
    rowBounds.forEach(([y0, y1], r) => {
      if (parkCells.has(`${c}:${r}`)) {
        const trees = [];
        const n = rng.int(4, 8);
        for (let i = 0; i < n; i += 1) {
          trees.push({
            x: rng.float(x0 + 20, x1 - 20),
            y: rng.float(y0 + 20, y1 - 20),
            r: rng.float(8, 14),
          });
        }
        parks.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, trees });
        return;
      }
      const bw = x1 - x0;
      const bh = y1 - y0;
      const cols = bw > 240 ? 2 : 1;
      const rows = bh > 240 ? 2 : 1;
      const total = cols * rows;
      for (let i = 0; i < cols; i += 1) {
        for (let j = 0; j < rows; j += 1) {
          if (total > 1 && rng.chance(0.25)) continue; // leave a gap sometimes
          const cw = bw / cols;
          const ch = bh / rows;
          const m = 12;
          const w = rng.float(cw * 0.55, cw - m * 2);
          const h = rng.float(ch * 0.55, ch - m * 2);
          const x = x0 + i * cw + (cw - w) / 2 + rng.float(-6, 6);
          const y = y0 + j * ch + (ch - h) / 2 + rng.float(-6, 6);
          buildings.push({ x, y, w, h, roof: rng.pick(ROOF_COLORS) });
        }
      }
    });
  });

  return {
    buildings,
    roads,
    parks,
    beach: { x: 0, y: BEACH_TOP, w: WORLD.width, h: WATER_TOP - BEACH_TOP },
    water: { x: 0, y: WATER_TOP, w: WORLD.width, h: WORLD.height - WATER_TOP },
    bounds: { width: WORLD.width, height: WORLD.height },
    locations: {
      garage: { x: 1000, y: 1400 },
      bank: { x: 1400, y: 1000 },
      pier: { x: 2200, y: 2860 },
      safehouse: { x: 600, y: 600 },
      packageSpot: { x: 1800, y: 200 },
      taxiStand: { x: 1400, y: 1400 },
      spawn: { x: 1000, y: 1000 },
    },
  };
}

function circleHitsRect(cx, cy, r, rx, ry, rw, rh) {
  const nx = Math.max(rx, Math.min(cx, rx + rw));
  const ny = Math.max(ry, Math.min(cy, ry + rh));
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}

/** True when a circle of radius r at (x, y) would hit a building, the water, or the world edge. */
export function isBlocked(city, x, y, r) {
  if (x - r < 0 || y - r < 0 || x + r > WORLD.width || y + r > WORLD.height) return true;
  const w = city.water;
  if (circleHitsRect(x, y, r, w.x, w.y, w.w, w.h)) return true;
  for (const b of city.buildings) {
    if (circleHitsRect(x, y, r, b.x, b.y, b.w, b.h)) return true;
  }
  return false;
}

/** True when the point lies on a road. */
export function isOnRoad(city, x, y) {
  for (const road of city.roads) {
    if (road.vertical) {
      if (Math.abs(x - road.x1) <= road.w / 2 && y >= road.y1 && y <= road.y2) return true;
    } else if (Math.abs(y - road.y1) <= road.w / 2 && x >= road.x1 && x <= road.x2) {
      return true;
    }
  }
  return false;
}

/** Accept a createRandom object, a bare () => [0,1) function, or nothing. */
function asRandom(rng) {
  if (rng && typeof rng.pick === 'function' && typeof rng.float === 'function') return rng;
  const next = typeof rng === 'function' ? rng : Math.random;
  return {
    next,
    float: (min = 0, max = 1) => min + (max - min) * next(),
    int: (min, max) => Math.floor(min + (max - min + 1) * next()),
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (p) => next() < p,
  };
}

/** A random point on a road (for spawning vehicles). */
export function randomRoadPoint(city, rng) {
  const r = asRandom(rng);
  const road = r.pick(city.roads);
  if (road.vertical) {
    return {
      x: road.x1 + r.float(-road.w / 2 + 8, road.w / 2 - 8),
      y: r.float(40, BEACH_TOP - 40),
    };
  }
  return {
    x: r.float(40, WORLD.width - 40),
    y: road.y1 + r.float(-road.w / 2 + 8, road.w / 2 - 8),
  };
}

/** A random point on a sidewalk beside a road (for spawning pedestrians). */
export function randomSidewalkPoint(city, rng) {
  const r = asRandom(rng);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const road = r.pick(city.roads);
    const side = r.pick([-1, 1]);
    const off = road.w / 2 + r.float(10, 26);
    let point;
    if (road.vertical) {
      point = { x: road.x1 + side * off, y: r.float(40, BEACH_TOP - 40) };
    } else {
      point = { x: r.float(40, WORLD.width - 40), y: road.y1 + side * off };
    }
    if (!isBlocked(city, point.x, point.y, 10)) return point;
  }
  return randomRoadPoint(city, rng);
}
