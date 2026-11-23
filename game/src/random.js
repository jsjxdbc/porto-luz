// Porto Luz — seeded random numbers (mulberry32) and small helpers.
// Pure module: no browser APIs at the top level, so Node can import it
// directly for a syntax check.

/** mulberry32: a tiny deterministic PRNG. Returns a function yielding [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A small random helper object built on one seed.
 * next() in [0, 1); float(min, max); int(min, max) inclusive; pick(list);
 * chance(p) true with probability p; shuffle(list) in place.
 */
export function createRandom(seed) {
  const next = mulberry32(seed);
  return {
    next,
    float(min = 0, max = 1) {
      return min + (max - min) * next();
    },
    int(min, max) {
      return Math.floor(min + (max - min + 1) * next());
    },
    pick(list) {
      return list[Math.floor(next() * list.length)];
    },
    chance(p) {
      return next() < p;
    },
    shuffle(list) {
      for (let i = list.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
      return list;
    },
  };
}
