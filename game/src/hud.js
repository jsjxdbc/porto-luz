// HUD for Porto Luz: minimap, bars, cash, wanted stars, clock, speed,
// objective line, message feed, banners, and every screen (title, pause,
// busted, wasted, ending, jobs menu).
//
// Pure canvas drawing. Call renderHUD after the world is drawn and the
// transform is reset to the canvas backing store; layout is computed from
// ctx.canvas.width/height, so it fits any window. No browser APIs are
// touched at module top level, so Node can import this file directly.
//
// Note: render.js also draws a compact HUD of its own. This module is the
// fuller standalone alternative (minimap with job markers, speed, weapon
// and ammo, job-complete banner, ending card, jobs menu, start button);
// integration picks one of the two.
//
// Message entries are {text, ttl} (state.js's shape); plain strings and
// legacy {text, t} entries are also read defensively.

import { availableMissions, missionLocation } from './missions.js';

export { showMessage } from './missions.js';

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

const COLORS = {
  panel: 'rgba(12, 16, 24, 0.82)',
  panelEdge: 'rgba(255, 255, 255, 0.16)',
  text: '#f2f4f7',
  muted: '#9aa3b2',
  gold: '#f2c94c',
  green: '#4ade80',
  red: '#e5534b',
  blue: '#4fc3f7',
  road: '#6b7280',
  building: '#3a4152',
  mapBg: 'rgba(10, 14, 20, 0.85)',
  target: '#f2c94c',
  police: '#ff5252',
  taxi: '#38e1c6',
  job: '#ff9f43',
};

function fmtMoney(cash) {
  const value = Math.max(0, Math.floor(cash || 0));
  return '$' + String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtClock(clockSeconds) {
  // clock is seconds since midnight (START_CLOCK = 08:00).
  const total = Math.floor(clockSeconds || 0);
  const hours = Math.floor(total / 3600) % 24;
  const minutes = Math.floor(total / 60) % 60;
  return String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0');
}

function text(ctx, value, x, y, size, color, align, weight) {
  ctx.font = `${weight || 400} ${size}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = align || 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(value, x, y);
}

function bar(ctx, x, y, width, height, frac, fill, bg) {
  const f = Math.max(0, Math.min(1, frac));
  ctx.fillStyle = bg;
  ctx.fillRect(x, y, width, height);
  if (f > 0) {
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, width * f, height);
  }
}

function panel(ctx, x, y, width, height, fill) {
  ctx.fillStyle = fill || COLORS.panel;
  ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = COLORS.panelEdge;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
}

/** Where the start button sits, so the game loop can hit-test clicks. */
export function getStartButtonRect(width, height) {
  const u = Math.min(width / 1280, height / 720);
  const w = 300 * u;
  const h = 64 * u;
  return { x: width / 2 - w / 2, y: height * 0.68, w, h };
}

function drawMinimap(ctx, state, city, x, y, size, u) {
  const bounds = (city && city.bounds) || { width: 3200, height: 3200 };
  const scale = size / Math.max(bounds.width, bounds.height);
  const toMapX = (wx) => x + wx * scale;
  const toMapY = (wy) => y + wy * scale;

  ctx.fillStyle = COLORS.mapBg;
  ctx.fillRect(x, y, size, size);
  ctx.strokeStyle = COLORS.panelEdge;
  ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);

  // Sea, beach and parks first (world.js's city shape).
  if (city && city.water) {
    ctx.fillStyle = '#256b8f';
    ctx.fillRect(x, y + city.water.y * scale, size, Math.max(1, city.water.h * scale));
  }
  if (city && city.beach) {
    ctx.fillStyle = '#e3cd96';
    ctx.fillRect(x, y + city.beach.y * scale, size, Math.max(1, city.beach.h * scale));
  }
  const parks = (city && city.parks) || [];
  ctx.fillStyle = '#5d8a4a';
  for (const park of parks) {
    ctx.fillRect(toMapX(park.x), toMapY(park.y), Math.max(1, park.w * scale), Math.max(1, park.h * scale));
  }

  const roads = (city && city.roads) || [];
  ctx.strokeStyle = COLORS.road;
  for (const road of roads) {
    ctx.lineWidth = Math.max(1, (road.w || 3) * scale);
    ctx.beginPath();
    if (typeof road.x1 === 'number') {
      ctx.moveTo(toMapX(road.x1), toMapY(road.y1));
      ctx.lineTo(toMapX(road.x2), toMapY(road.y2));
    } else {
      ctx.rect(toMapX(road.x), toMapY(road.y), Math.max(1, road.w * scale), Math.max(1, road.h * scale));
    }
    ctx.stroke();
  }

  const buildings = (city && city.buildings) || [];
  for (const b of buildings) {
    ctx.fillStyle = b.roof || COLORS.building;
    ctx.fillRect(toMapX(b.x), toMapY(b.y), Math.max(1, b.w * scale), Math.max(1, b.h * scale));
  }

  // Job markers: next story job (orange !) and the taxi stand (teal T).
  for (const marker of availableMissions(state, city)) {
    const mx = toMapX(marker.x);
    const my = toMapY(marker.y);
    ctx.fillStyle = marker.kind === 'story' ? COLORS.job : COLORS.taxi;
    ctx.beginPath();
    ctx.arc(mx, my, 5 * u, 0, Math.PI * 2);
    ctx.fill();
    text(ctx, marker.kind === 'story' ? '!' : 'T', mx, my + 4 * u, 11 * u, '#10141b', 'center', 700);
  }

  // Active mission target: pulsing yellow dot.
  const target = state.mission && state.mission.target;
  if (target) {
    const pulse = 1 + 0.25 * Math.sin((state.time || 0) * 5);
    ctx.fillStyle = COLORS.target;
    ctx.beginPath();
    ctx.arc(toMapX(target.x), toMapY(target.y), 6 * u * pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = COLORS.target;
    ctx.beginPath();
    ctx.arc(toMapX(target.x), toMapY(target.y), 10 * u * pulse, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Police: red dots.
  ctx.fillStyle = COLORS.police;
  for (const cop of state.police || []) {
    ctx.beginPath();
    ctx.arc(toMapX(cop.x), toMapY(cop.y), 3.5 * u, 0, Math.PI * 2);
    ctx.fill();
  }

  // Player: white arrow, rotated to the facing angle.
  const px = toMapX(state.player.x);
  const py = toMapY(state.player.y);
  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(state.player.angle || 0);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(8 * u, 0);
  ctx.lineTo(-6 * u, -5 * u);
  ctx.lineTo(-6 * u, 5 * u);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  text(ctx, 'N', x + size / 2, y - 6 * u, 13 * u, COLORS.muted, 'center', 700);
}

function drawWanted(ctx, state, x, y, u) {
  const wanted = state.player.wanted || 0;
  for (let i = 0; i < 5; i += 1) {
    text(ctx, '★', x + i * 26 * u, y, 24 * u, i < wanted ? COLORS.gold : 'rgba(255,255,255,0.22)', 'left', 700);
  }
}

function drawObjective(ctx, state, width, u) {
  const mission = state.mission || {};
  const title = mission.id ? mission.title : 'Free Roam';
  const objective = mission.id ? mission.objective : 'Press M for jobs — walk to a marker and press E to start one.';
  text(ctx, title.toUpperCase(), width / 2, 30 * u, 20 * u, COLORS.gold, 'center', 700);
  text(ctx, objective, width / 2, 56 * u, 16 * u, COLORS.text, 'center');
}

function drawMessages(ctx, state, width, height, u) {
  const messages = (state.messages || []).slice(-3);
  const baseY = height - 92 * u;
  messages.forEach((message, index) => {
    const value = typeof message === 'string' ? message : message.text;
    let alpha = 1;
    if (message && typeof message.ttl === 'number') alpha = Math.max(0, Math.min(1, message.ttl));
    else if (message && typeof message.t === 'number') alpha = message.t > 4 ? Math.max(0, 5 - message.t) : 1;
    ctx.globalAlpha = alpha;
    text(ctx, value, width / 2, baseY - (messages.length - 1 - index) * 24 * u, 16 * u, COLORS.text, 'center');
  });
  ctx.globalAlpha = 1;
}

function drawBanner(ctx, state, width, height, u) {
  const banner = state.mission && state.mission.banner;
  if (!banner) return;
  const alpha = banner.t < 1 ? Math.max(0, banner.t) : 1;
  ctx.globalAlpha = alpha;
  text(ctx, banner.title, width / 2, height * 0.32, 54 * u, COLORS.gold, 'center', 800);
  text(ctx, banner.sub, width / 2, height * 0.32 + 44 * u, 24 * u, COLORS.text, 'center', 600);
  ctx.globalAlpha = 1;
}

function drawEnding(ctx, state, width, height, u) {
  const ending = state.mission && state.mission.ending;
  if (!ending) return;
  const barH = height * 0.12;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, barH);
  ctx.fillRect(0, height - barH, width, barH);
  ending.lines.forEach((line, index) => {
    text(ctx, line, width / 2, height / 2 - 30 * u + index * 36 * u, index === 0 ? 30 * u : 20 * u, index === 0 ? COLORS.gold : COLORS.text, 'center', index === 0 ? 800 : 400);
  });
}

function drawStartScreen(ctx, state, width, height, u) {
  ctx.fillStyle = 'rgba(8, 12, 20, 0.78)';
  ctx.fillRect(0, 0, width, height);
  text(ctx, 'PORTO LUZ', width / 2, height * 0.26, 84 * u, COLORS.gold, 'center', 800);
  text(ctx, 'A sun-soaked open-world crime story', width / 2, height * 0.26 + 44 * u, 22 * u, COLORS.text, 'center');
  const lines = [
    'WASD / Arrow keys — drive & walk      E — enter car / start job',
    'Mouse — aim      Click — shoot      F — punch      Space — handbrake',
    'M — jobs menu      Esc — pause      R — restart (pause menu)',
    '',
    'Danny Reyes just got out. Marisol Vega has work for him.',
    'Steal a car, run the jobs, and take the city.',
  ];
  lines.forEach((line, index) => {
    text(ctx, line, width / 2, height * 0.42 + index * 30 * u, 17 * u, COLORS.muted, 'center');
  });
  const button = getStartButtonRect(width, height);
  ctx.fillStyle = COLORS.gold;
  ctx.fillRect(button.x, button.y, button.w, button.h);
  text(ctx, 'START ENGINE', width / 2, button.y + button.h / 2 + 9 * u, 24 * u, '#10141b', 'center', 800);
  text(ctx, 'or press Enter', width / 2, button.y + button.h + 30 * u, 15 * u, COLORS.muted, 'center');
}

function drawPaused(ctx, width, height, u) {
  ctx.fillStyle = 'rgba(8, 12, 20, 0.66)';
  ctx.fillRect(0, 0, width, height);
  text(ctx, 'PAUSED', width / 2, height * 0.4, 56 * u, COLORS.text, 'center', 800);
  text(ctx, 'Press Esc to keep driving', width / 2, height * 0.4 + 44 * u, 20 * u, COLORS.muted, 'center');
  text(ctx, 'Press R to restart the game', width / 2, height * 0.4 + 76 * u, 18 * u, COLORS.muted, 'center');
}

function drawEndScreen(ctx, state, width, height, u, kind) {
  ctx.fillStyle = 'rgba(8, 12, 20, 0.72)';
  ctx.fillRect(0, 0, width, height);
  const title = kind === 'busted' ? 'BUSTED' : 'WASTED';
  const color = kind === 'busted' ? COLORS.blue : COLORS.red;
  const line = kind === 'busted'
    ? 'The Porto Luz police processed you — and let you walk.'
    : 'Danny Reyes went down — and woke up in the hospital.';
  text(ctx, title, width / 2, height * 0.38, 72 * u, color, 'center', 800);
  text(ctx, line, width / 2, height * 0.38 + 44 * u, 20 * u, COLORS.text, 'center');
  text(ctx, `Cash kept: ${fmtMoney(state.player.cash)}`, width / 2, height * 0.38 + 82 * u, 20 * u, COLORS.gold, 'center', 600);
  text(ctx, 'Back on the streets — the city keeps moving.', width / 2, height * 0.38 + 126 * u, 18 * u, COLORS.muted, 'center');
}

function drawMissionMenu(ctx, state, city, width, height, u) {
  const jobs = availableMissions(state, city);
  const menu = state.missionMenu || { selected: 0 };
  const w = 560 * u;
  const h = 150 * u + jobs.length * 64 * u;
  const x = width / 2 - w / 2;
  const y = height / 2 - h / 2;
  panel(ctx, x, y, w, h);
  text(ctx, 'JOBS — PORTO LUZ', x + 24 * u, y + 44 * u, 22 * u, COLORS.gold, 'left', 700);
  jobs.forEach((job, index) => {
    const rowY = y + 84 * u + index * 64 * u;
    if (index === menu.selected) {
      ctx.fillStyle = 'rgba(242, 201, 76, 0.16)';
      ctx.fillRect(x + 10 * u, rowY - 26 * u, w - 20 * u, 52 * u);
    }
    text(ctx, (index === menu.selected ? '▶ ' : '   ') + job.title, x + 24 * u, rowY, 20 * u, COLORS.text, 'left', 600);
    text(ctx, job.kind === 'story' ? 'STORY' : 'SIDE — repeatable', x + w - 24 * u, rowY, 14 * u, COLORS.muted, 'right');
    text(ctx, job.briefing, x + 24 * u, rowY + 22 * u, 14 * u, COLORS.muted, 'left');
  });
  text(ctx, '↑ ↓ choose    E start job    M close', x + w / 2, y + h - 18 * u, 15 * u, COLORS.muted, 'center');
}

/**
 * Draw the whole HUD for one frame. `ctx` is a 2D canvas context already
 * reset to screen space; `city` may be sparse (see missions.js).
 */
export function renderHUD(ctx, state, city) {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  const u = Math.min(width / 1280, height / 720);
  const flags = state.flags || {};
  const player = state.player;

  ctx.save();

  if (!flags.started) {
    drawStartScreen(ctx, state, width, height, u);
    ctx.restore();
    return;
  }

  // Minimap, top right.
  const mapSize = 200 * u;
  drawMinimap(ctx, state, city, width - mapSize - 16 * u, 16 * u, mapSize, u);

  // Wanted stars under the minimap.
  drawWanted(ctx, state, width - mapSize - 16 * u, mapSize + 52 * u, u);

  // Clock and cash, top left.
  text(ctx, fmtClock(state.clock), 20 * u, 34 * u, 26 * u, COLORS.text, 'left', 700);
  text(ctx, fmtMoney(player.cash), 20 * u, 66 * u, 22 * u, COLORS.gold, 'left', 600);
  if (player.weapon) {
    text(ctx, `${player.weapon}  •  ${player.ammo}`, 20 * u, 94 * u, 17 * u, COLORS.muted, 'left');
  }

  // Objective, top centre.
  drawObjective(ctx, state, width, u);

  // Health and armour, bottom left.
  bar(ctx, 20 * u, height - 58 * u, 220 * u, 14 * u, (player.health || 0) / 100, COLORS.green, 'rgba(255,255,255,0.18)');
  text(ctx, 'HP', 248 * u, height - 46 * u, 14 * u, COLORS.text, 'left', 700);
  bar(ctx, 20 * u, height - 38 * u, 220 * u, 10 * u, (player.armor || 0) / 100, COLORS.blue, 'rgba(255,255,255,0.18)');
  text(ctx, 'ARMOR', 248 * u, height - 29 * u, 14 * u, COLORS.text, 'left', 700);

  // Speed, bottom right, while driving.
  if (!player.onFoot) {
    const kmh = Math.round((player.speed || 0) * 0.36);
    text(ctx, `${kmh}`, width - 20 * u, height - 30 * u, 40 * u, COLORS.text, 'right', 800);
    text(ctx, 'km/h', width - 20 * u, height - 64 * u, 14 * u, COLORS.muted, 'right');
  }

  // Message feed, banner, ending card.
  drawMessages(ctx, state, width, height, u);
  drawBanner(ctx, state, width, height, u);
  drawEnding(ctx, state, width, height, u);

  // Overlays.
  if (state.missionMenu && state.missionMenu.open) drawMissionMenu(ctx, state, city, width, height, u);
  if (flags.paused) drawPaused(ctx, width, height, u);
  else if (flags.busted) drawEndScreen(ctx, state, width, height, u, 'busted');
  else if (flags.wasted || flags.gameOver) drawEndScreen(ctx, state, width, height, u, 'wasted');

  ctx.restore();
}
