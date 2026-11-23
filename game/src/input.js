// Porto Luz — keyboard and mouse input.
// createInput(canvas) returns { keys, mouse, down(action), pressed(action),
// endFrame(), destroy() }. `down` is true while a bound key is held;
// `pressed` is true only on the frame the key went down (cleared by
// endFrame(), which the main loop calls once per frame). Bindings live in
// config.js. Listeners are attached inside the function, never at the top
// level, so Node can import this module for a syntax check.

import { KEYS } from './config.js';

const ALL_CODES = new Set(Object.values(KEYS).flat());

export function createInput(canvas) {
  const keys = {};
  const mouse = { x: 0, y: 0, down: false };
  const justPressed = new Set();

  function onKeyDown(event) {
    if (ALL_CODES.has(event.code)) event.preventDefault();
    if (!event.repeat) justPressed.add(event.code);
    keys[event.code] = true;
  }
  function onKeyUp(event) {
    keys[event.code] = false;
  }
  function onBlur() {
    for (const code of Object.keys(keys)) keys[code] = false;
  }
  function onMouseMove(event) {
    const rect = canvas.getBoundingClientRect();
    // The canvas is drawn at 1280x720 but may be displayed scaled.
    mouse.x = (event.clientX - rect.left) * (canvas.width / rect.width);
    mouse.y = (event.clientY - rect.top) * (canvas.height / rect.height);
  }
  function onMouseDown(event) {
    onMouseMove(event);
    mouse.down = true;
  }
  function onMouseUp() {
    mouse.down = false;
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);

  return {
    keys,
    mouse,
    /** True while any key bound to `action` is held. */
    down(action) {
      return (KEYS[action] || []).some((code) => !!keys[code]);
    },
    /** True only on the frame a key bound to `action` went down. */
    pressed(action) {
      return (KEYS[action] || []).some((code) => justPressed.has(code));
    },
    /** Clear the one-shot presses; call once per frame after updates. */
    endFrame() {
      justPressed.clear();
    },
    destroy() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
    },
  };
}
