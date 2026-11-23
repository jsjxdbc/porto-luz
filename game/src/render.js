// Porto Luz — the renderer: ground, roads, parks, beach, sea, buildings,
// vehicles, pedestrians, police, the player, particles, then a day/night
// tint. Drawing only: it never changes state and touches no browser API at
// the top level, so Node can import it directly for a syntax check.
// The HUD (bars, minimap, screens) lives in hud.js and is drawn by main.js
// after this, so this file never draws interface on top of the world.

import { CANVAS_HEIGHT, CANVAS_WIDTH, COLORS } from './config.js';

/** Convert world coordinates to canvas pixels for the current camera. */
export function worldToScreen(camera, x, y) {
  return {
    x: (x - camera.x) * camera.zoom + CANVAS_WIDTH / 2,
    y: (y - camera.y) * camera.zoom + CANVAS_HEIGHT / 2,
  };
}

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const VEHICLE_SIZE = {
  car: { l: 46, w: 22 },
  taxi: { l: 46, w: 22 },
  truck: { l: 62, w: 26 },
  bike: { l: 30, w: 12 },
};

function drawVehicleBody(ctx, x, y, angle, color, kind, isPlayerCar) {
  const size = VEHICLE_SIZE[kind] || VEHICLE_SIZE.car;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
  ctx.beginPath();
  ctx.ellipse(x + 3, y + 4, size.l / 2, size.w / 2, angle, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = color;
  rr(ctx, -size.l / 2, -size.w / 2, size.l, size.w, 6);
  ctx.fill();
  // Windshield and roof.
  ctx.fillStyle = 'rgba(180, 220, 240, 0.85)';
  ctx.fillRect(size.l * 0.12, -size.w / 2 + 3, size.l * 0.2, size.w - 6);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
  ctx.fillRect(-size.l * 0.28, -size.w / 2 + 3, size.l * 0.3, size.w - 6);
  ctx.restore();
  if (isPlayerCar) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, size.l * 0.68, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawPerson(ctx, x, y, angle, color, radius) {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
  ctx.beginPath();
  ctx.ellipse(x + 2, y + 3, radius, radius * 0.8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius);
  ctx.stroke();
}

/** Paint one frame: the world, then the HUD and any overlay. */
export function render(ctx, state, city) {
  const { camera } = state;
  const vw = CANVAS_WIDTH / camera.zoom;
  const vh = CANVAS_HEIGHT / camera.zoom;
  const view = { x: camera.x - vw / 2, y: camera.y - vh / 2, w: vw, h: vh };
  const inView = (x, y, w, h) =>
    x + w >= view.x && x <= view.x + view.w && y + h >= view.y && y <= view.y + view.h;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = COLORS.ground;
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  ctx.save();
  ctx.translate(CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2);
  ctx.scale(camera.zoom, camera.zoom);
  ctx.translate(-camera.x, -camera.y);

  // Sea and beach.
  ctx.fillStyle = COLORS.water;
  ctx.fillRect(city.water.x, city.water.y, city.water.w, city.water.h);
  ctx.fillStyle = COLORS.beach;
  ctx.fillRect(city.beach.x, city.beach.y, city.beach.w, city.beach.h);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
  ctx.fillRect(city.beach.x, city.water.y - 10, city.beach.w, 10);
  // Animated wave lines.
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 3; i += 1) {
    const yBase = city.water.y + 40 + i * 70;
    if (yBase < view.y || yBase > view.y + view.h) continue;
    ctx.beginPath();
    let first = true;
    for (let x = Math.max(city.water.x, view.x); x <= Math.min(city.water.x + city.water.w, view.x + view.w); x += 24) {
      const y = yBase + Math.sin(x * 0.02 + state.time * 1.5 + i * 2) * 4;
      if (first) {
        ctx.moveTo(x, y);
        first = false;
      } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Parks and their trees.
  for (const park of city.parks) {
    if (!inView(park.x, park.y, park.w, park.h)) continue;
    ctx.fillStyle = COLORS.park;
    ctx.fillRect(park.x, park.y, park.w, park.h);
    for (const tree of park.trees) {
      ctx.fillStyle = COLORS.parkTree;
      ctx.beginPath();
      ctx.arc(tree.x, tree.y, tree.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.beginPath();
      ctx.arc(tree.x - 3, tree.y - 3, tree.r * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Roads with centre dashes.
  for (const road of city.roads) {
    ctx.fillStyle = COLORS.road;
    if (road.vertical) {
      if (road.x1 + road.w / 2 < view.x || road.x1 - road.w / 2 > view.x + view.w) continue;
      const top = Math.max(road.y1, view.y);
      const bottom = Math.min(road.y2, view.y + view.h);
      ctx.fillRect(road.x1 - road.w / 2, top, road.w, bottom - top);
      ctx.fillStyle = COLORS.roadLine;
      const yStart = Math.max(road.y1, Math.floor(view.y / 48) * 48);
      const yEnd = Math.min(road.y2, view.y + view.h);
      for (let y = yStart; y < yEnd; y += 48) ctx.fillRect(road.x1 - 2, y, 4, 24);
    } else {
      if (road.y1 + road.w / 2 < view.y || road.y1 - road.w / 2 > view.y + view.h) continue;
      const left = Math.max(road.x1, view.x);
      const right = Math.min(road.x2, view.x + view.w);
      ctx.fillRect(left, road.y1 - road.w / 2, right - left, road.w);
      ctx.fillStyle = COLORS.roadLine;
      const xStart = Math.max(road.x1, Math.floor(view.x / 48) * 48);
      const xEnd = Math.min(road.x2, view.x + view.w);
      for (let x = xStart; x < xEnd; x += 48) ctx.fillRect(x, road.y1 - 2, 24, 4);
    }
  }

  // Skid marks (staged by shots.js): dark rubber trails on the asphalt.
  if (state.skids && state.skids.length) {
    ctx.strokeStyle = 'rgba(18, 18, 22, 0.5)';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    for (const s of state.skids) {
      ctx.beginPath();
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x2, s.y2);
      ctx.stroke();
    }
  }

  // Buildings: shadow, body, roof.
  for (const b of city.buildings) {
    if (!inView(b.x, b.y, b.w, b.h)) continue;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.fillRect(b.x + 6, b.y + 7, b.w, b.h);
    ctx.fillStyle = COLORS.buildingSide;
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.fillStyle = b.roof;
    ctx.fillRect(b.x + 5, b.y + 5, b.w - 10, b.h - 10);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 2;
    ctx.strokeRect(b.x + 5, b.y + 5, b.w - 10, b.h - 10);
  }

  // Mission target marker.
  if (state.mission.target && !state.mission.done) {
    const t = state.mission.target;
    const pulse = 1 + Math.sin(state.time * 4) * 0.15;
    ctx.strokeStyle = '#ffd94a';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(t.x, t.y, 22 * pulse, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#ffd94a';
    ctx.beginPath();
    ctx.arc(t.x, t.y, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  // Vehicles (wet-road reflection first, so the glow sits under the car).
  for (const v of state.vehicles) {
    if (!inView(v.x - 40, v.y - 40, 80, 80)) continue;
    if (reflectAtNight(state.clock)) drawWetReflection(ctx, v.x, v.y, v.angle, v.color, v.kind);
    drawVehicleBody(ctx, v.x, v.y, v.angle, v.color, v.kind, v.driver === 'player');
  }

  // Pedestrians.
  for (const ped of state.peds) {
    if (!inView(ped.x - 12, ped.y - 12, 24, 24)) continue;
    drawPerson(ctx, ped.x, ped.y, ped.angle, ped.color, 8);
  }

  // Police: cars look like cars with a light bar, officers are navy dots.
  for (const cop of state.police) {
    if (!inView(cop.x - 40, cop.y - 40, 80, 80)) continue;
    if (cop.kind === 'car') {
      if (reflectAtNight(state.clock)) drawWetReflection(ctx, cop.x, cop.y, cop.angle, '#e8e8e8', 'car');
      drawVehicleBody(ctx, cop.x, cop.y, cop.angle, '#e8e8e8', 'car', false);
      ctx.save();
      ctx.translate(cop.x, cop.y);
      ctx.rotate(cop.angle);
      ctx.fillStyle = '#1f3a93';
      ctx.fillRect(-6, -11, 12, 22);
      ctx.fillStyle = '#c23b2e';
      ctx.fillRect(-8, -11, 6, 5);
      ctx.fillStyle = '#2e6dc2';
      ctx.fillRect(-8, 6, 6, 5);
      ctx.restore();
    } else {
      drawPerson(ctx, cop.x, cop.y, cop.angle, '#1f3a93', 9);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cop.x, cop.y, 9, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Muzzle flashes (staged by shots.js): a bright four-point star where a
  // gun just fired.
  for (const f of state.flashes || []) {
    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.strokeStyle = 'rgba(255, 240, 160, 0.95)';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    for (const a of [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4]) {
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * -11, Math.sin(a) * -11);
      ctx.lineTo(Math.cos(a) * 11, Math.sin(a) * 11);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255, 250, 210, 0.95)';
    ctx.beginPath();
    ctx.arc(0, 0, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // The player on foot (in a car, the ring on the car marks them).
  const p = state.player;
  if (p.onFoot) drawPerson(ctx, p.x, p.y, p.angle, COLORS.player, 13);

  // Staged explosions (shots.js): a fireball core, a hot glow and fixed
  // smoke puffs — all fixed coordinates, so the frame is deterministic.
  for (const ex of state.explosions || []) {
    const glow = ctx.createRadialGradient(ex.x, ex.y, 4, ex.x, ex.y, ex.r * 1.7);
    glow.addColorStop(0, 'rgba(255, 220, 120, 0.55)');
    glow.addColorStop(0.5, 'rgba(255, 120, 30, 0.28)');
    glow.addColorStop(1, 'rgba(255, 80, 20, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(ex.x, ex.y, ex.r * 1.7, 0, Math.PI * 2);
    ctx.fill();
    const core = ctx.createRadialGradient(ex.x, ex.y, 2, ex.x, ex.y, ex.r);
    core.addColorStop(0, '#fff6c8');
    core.addColorStop(0.45, '#ffb03a');
    core.addColorStop(0.8, '#e85a1e');
    core.addColorStop(1, 'rgba(160, 40, 10, 0.85)');
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(ex.x, ex.y, ex.r, 0, Math.PI * 2);
    ctx.fill();
    // Smoke: five puffs at fixed polar offsets around the fireball.
    for (let i = 0; i < 5; i += 1) {
      const a = i * 2.4 + 0.6;
      const d = ex.r * 0.95;
      const sx = ex.x + Math.cos(a) * d;
      const sy = ex.y + Math.sin(a) * d - ex.r * 0.35;
      ctx.fillStyle = 'rgba(38, 38, 44, 0.5)';
      ctx.beginPath();
      ctx.arc(sx, sy, ex.r * 0.34, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Particles.
  for (const pt of state.particles) {
    ctx.globalAlpha = Math.max(0, pt.life / pt.maxLife);
    ctx.fillStyle = pt.color;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, pt.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  ctx.restore();

  // Time-of-day lighting: a warm sunset wash with a low sun glow at
  // golden hour, a violet wash at dusk, deep blue at night. Day scenes
  // (07:00–17:00) are untouched.
  const light = lightingFor(state.clock);
  if (light.tint) {
    ctx.fillStyle = light.tint;
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  }
  if (light.glow) {
    const g = ctx.createRadialGradient(light.glow.x, light.glow.y, 10, light.glow.x, light.glow.y, light.glow.r);
    g.addColorStop(0, light.glow.color);
    g.addColorStop(1, 'rgba(255, 140, 40, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  }

  // Neon spill (night scenes, staged by shots.js): drawn over the tint so
  // the colour glows instead of being dulled by it.
  if (state.neon && state.neon.length) {
    ctx.save();
    ctx.translate(CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.x, -camera.y);
    for (const n of state.neon) {
      const [r, g, b] = n.rgb;
      const grad = ctx.createRadialGradient(n.x, n.y, 4, n.x, n.y, n.r);
      grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.55)`);
      grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  // The HUD (hud.js) is drawn by main.js after this returns.
}

/** Wet-road reflections under cars: only once it is properly dark. */
function reflectAtNight(clock) {
  const h = (clock / 3600) % 24;
  return h >= 19 || h < 6;
}

/** A soft coloured sheen under a car, as if the wet asphalt mirrors it. */
function drawWetReflection(ctx, x, y, angle, color, kind) {
  const size = VEHICLE_SIZE[kind] || VEHICLE_SIZE.car;
  ctx.save();
  ctx.translate(x, y + 20);
  ctx.rotate(angle);
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.16;
  ctx.beginPath();
  ctx.ellipse(0, 0, size.l * 0.6, size.w * 0.45, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 0.1;
  ctx.beginPath();
  ctx.ellipse(0, 6, size.l * 0.42, size.w * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.globalAlpha = 1;
}

/**
 * Lighting for a clock time (seconds since midnight): a warm sunset wash
 * peaking at 18:15 with a low sun glow, a violet dusk wash, deep blue
 * night. Day (07:00–17:00) gets no overlay at all.
 */
function lightingFor(clock) {
  const h = (clock / 3600) % 24;
  if (h >= 7 && h < 17) return { tint: null, glow: null };
  if (h >= 17 && h < 19) {
    const peak = 18.25; // 18:15, the strongest sunset
    const a = 0.04 + 0.16 * Math.max(0, 1 - Math.abs(h - peak));
    return {
      tint: `rgba(255, 110, 30, ${a.toFixed(3)})`,
      glow: { x: 1080, y: 110, r: 320, color: 'rgba(255, 170, 60, 0.5)' },
    };
  }
  if (h >= 19 && h < 20) {
    return { tint: `rgba(70, 50, 130, ${(0.12 * (20 - h)).toFixed(3)})`, glow: null };
  }
  if (h >= 20 || h < 6) return { tint: 'rgba(10, 16, 48, 0.34)', glow: null };
  return { tint: `rgba(10, 16, 48, ${(0.34 * (7 - h)).toFixed(3)})`, glow: null };
}
