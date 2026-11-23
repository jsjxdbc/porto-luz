// Sound for Porto Luz, synthesized live with WebAudio — no audio files.
// Every sound is an oscillator (or filtered noise) through one master gain.
// The AudioContext is created lazily inside createAudio's methods, never at
// module top level, so Node can import this file directly.

const BASSLINE = [55, 0, 65.41, 0, 49, 0, 58.27, 73.42]; // A1 C2 G1 Bb1 D2, 8th notes
const STEP_MS = 210;

export function createAudio() {
  let ctx = null;
  let master = null;
  let noiseBuf = null;
  let engineNodes = null;
  let sirenNodes = null;
  let musicTimer = null;
  let musicStep = 0;
  let muted = false;

  function ensure() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return true;
    }
    let AC = null;
    if (typeof window !== 'undefined') AC = window.AudioContext || window.webkitAudioContext || null;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.5;
    master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    return true;
  }

  function blip(freq, endFreq, duration, type, volume, delay) {
    if (!ensure()) return;
    const t0 = ctx.currentTime + (delay || 0);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (endFreq && endFreq !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), t0 + duration);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(volume, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
    osc.connect(gain);
    gain.connect(master);
    osc.start(t0);
    osc.stop(t0 + duration + 0.05);
  }

  function noiseBurst(duration, filterFreq, volume, delay) {
    if (!ensure()) return;
    const t0 = ctx.currentTime + (delay || 0);
    const source = ctx.createBufferSource();
    source.buffer = noiseBuf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = filterFreq;
    filter.Q.value = 0.8;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(volume, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    source.start(t0);
    source.stop(t0 + duration + 0.05);
  }

  // Continuous engine hum. Call every frame with the vehicle speed
  // (units/second); 0 idles quietly. Call with -1 to stop it.
  function engine(speed) {
    if (speed < 0) {
      if (engineNodes) {
        try { engineNodes.osc.stop(); } catch { /* already stopped */ }
        engineNodes = null;
      }
      return;
    }
    if (!ensure()) return;
    if (!engineNodes) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 700;
      const gain = ctx.createGain();
      gain.gain.value = 0.0;
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(master);
      osc.start();
      engineNodes = { osc, gain };
    }
    const target = Math.max(0, Math.min(1, speed / 900));
    engineNodes.osc.frequency.setTargetAtTime(55 + target * 165, ctx.currentTime, 0.08);
    engineNodes.gain.gain.setTargetAtTime(0.02 + target * 0.1, ctx.currentTime, 0.1);
  }

  // Police siren: two tones alternating on a slow LFO. on(false) stops it.
  function siren(on) {
    if (!on) {
      if (sirenNodes) {
        try { sirenNodes.osc.stop(); sirenNodes.lfo.stop(); } catch { /* already stopped */ }
        sirenNodes = null;
      }
      return;
    }
    if (!ensure() || sirenNodes) return;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 850;
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.7;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 160;
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);
    const gain = ctx.createGain();
    gain.gain.value = 0.045;
    osc.connect(gain);
    gain.connect(master);
    osc.start();
    lfo.start();
    sirenNodes = { osc, lfo };
  }

  function explosion() {
    // A low boom: a long low-frequency noise burst plus a falling tone.
    noiseBurst(0.7, 140, 0.9);
    noiseBurst(0.4, 420, 0.4, 0.02);
    blip(130, 28, 0.7, 'sine', 0.7);
  }

  function shoot() {
    noiseBurst(0.12, 1800, 0.5);
    blip(190, 55, 0.1, 'square', 0.22);
  }

  function punch() {
    blip(160, 55, 0.16, 'sine', 0.35);
    noiseBurst(0.08, 300, 0.2);
  }

  function pickup() {
    blip(660, 660, 0.09, 'sine', 0.25);
    blip(880, 880, 0.12, 'sine', 0.25, 0.09);
  }

  function cash() {
    blip(988, 988, 0.1, 'sine', 0.25);
    blip(1319, 1319, 0.18, 'sine', 0.25, 0.1);
  }

  function missionDone() {
    const notes = [523, 659, 784, 1047];
    notes.forEach((freq, index) => blip(freq, freq, 0.22, 'triangle', 0.28, index * 0.13));
  }

  // A simple bass loop for driving around Porto Luz. start() begins it,
  // stop() ends it; safe to call either twice.
  function musicStart() {
    if (!ensure() || musicTimer !== null) return;
    musicTimer = setInterval(() => {
      if (!ctx || muted) return;
      const freq = BASSLINE[musicStep % BASSLINE.length];
      musicStep += 1;
      if (!freq) return;
      const t0 = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 320;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.16, t0);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.2);
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(master);
      osc.start(t0);
      osc.stop(t0 + 0.22);
    }, STEP_MS);
  }

  function musicStop() {
    if (musicTimer !== null) {
      clearInterval(musicTimer);
      musicTimer = null;
    }
  }

  function setMuted(value) {
    muted = !!value;
    if (master) master.gain.value = muted ? 0 : 0.5;
  }

  return {
    engine,
    siren,
    shoot,
    punch,
    pickup,
    cash,
    missionDone,
    explosion,
    music: { start: musicStart, stop: musicStop },
    setMuted,
  };
}

// ---- Per-frame system hook -------------------------------------------------
// main.js's systems registry calls updateAudio(state, city, dt) every step.
// The shared instance is created lazily inside functions, never at module
// top level, so Node can import this file directly.

let sharedAudio = null;
let musicPlaying = false;
let heardInput = false;

/** The one audio instance the whole game shares. */
export function getAudio() {
  if (!sharedAudio) sharedAudio = createAudio();
  return sharedAudio;
}

/**
 * Drive the continuous sounds from state: engine hum while driving, siren
 * while wanted with police around, bass music once the player has pressed
 * a key or clicked (so no AudioContext starts before a user gesture).
 */
export function updateAudio(state, city, dt) {
  const audio = getAudio();
  const flags = state.flags || {};
  const player = state.player || {};
  if (!flags.started || flags.paused || flags.gameOver || flags.busted || flags.wasted) {
    audio.engine(-1);
    audio.siren(false);
    if (musicPlaying) {
      audio.music.stop();
      musicPlaying = false;
    }
    return;
  }
  const keys = (state.input && state.input.keys) || {};
  if (!heardInput) {
    for (const code of Object.keys(keys)) {
      if (keys[code]) {
        heardInput = true;
        break;
      }
    }
    if (state.input && state.input.mouse && state.input.mouse.down) heardInput = true;
  }
  if (player.inVehicle && !player.onFoot) audio.engine(player.speed || 0);
  else audio.engine(-1);
  audio.siren((player.wanted || 0) > 0 && (state.police || []).length > 0);
  if (heardInput && !musicPlaying) {
    audio.music.start();
    musicPlaying = true;
  }
}
