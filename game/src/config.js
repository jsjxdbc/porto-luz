// Porto Luz — constants: canvas, world, palette, speeds, key bindings.
// Pure module: no browser APIs at the top level, so Node can import it
// directly for a syntax check.

export const CANVAS_WIDTH = 1280;
export const CANVAS_HEIGHT = 720;

export const WORLD_WIDTH = 3200;
export const WORLD_HEIGHT = 3200;

/** Fixed simulation step (seconds) and the longest frame the loop catches up on. */
export const STEP = 1 / 60;
export const MAX_FRAME = 0.25;

/** In-game minutes per real second: one real second is one game minute. */
export const TIME_SCALE = 60;
/** The clock starts at 08:00 (seconds since midnight). */
export const START_CLOCK = 8 * 3600;
export const START_CASH = 250;

export const PLAYER_WALK_SPEED = 175;
export const PLAYER_RUN_SPEED = 265;
export const PLAYER_RADIUS = 14;

export const CAMERA_ZOOM_FOOT = 1;
export const CAMERA_ZOOM_VEHICLE = 0.82;

export const SAVE_KEY = 'porto-luz-save-v1';

/** Key bindings (KeyboardEvent.code values). */
export const KEYS = {
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  run: ['ShiftLeft', 'ShiftRight'],
  enterVehicle: ['KeyE'],
  handbrake: ['Space'],
  punch: ['KeyF'],
  missions: ['KeyM'],
  pause: ['Escape'],
  confirm: ['Enter'],
  restart: ['KeyR'],
  load: ['KeyL'],
};

/** Palette for the sunny coast city. */
export const COLORS = {
  ground: '#a8a58e',
  road: '#3d3f45',
  roadLine: '#d8c95a',
  park: '#5d8a4a',
  parkTree: '#3f6b32',
  beach: '#e3cd96',
  water: '#2e7fa8',
  waterDeep: '#256b8f',
  buildingSide: '#6f6a5e',
  player: '#d8a03a',
  playerDark: '#7a5a1a',
  hudText: '#ffffff',
  hudShadow: 'rgba(0, 0, 0, 0.55)',
  star: '#ffd94a',
};

/** Roof colours, picked per building. */
export const ROOF_COLORS = ['#b0563a', '#7a6a8a', '#4a7a8a', '#8a7a4a', '#6a5a6a', '#a85a6a', '#5a7a4a'];
