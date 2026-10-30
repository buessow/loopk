// The time ranges of a collection already loaded: sorted, disjoint
// half-open intervals [from, to) of epoch ms.

export class Coverage {
  constructor () {
    this.ranges = [];
  }

  /** The parts of [from, to) not loaded yet, in order. */
  gaps (from, to) {
    const out = [];
    let at = from;
    for (const [a, b] of this.ranges) {
      if (b <= at) continue;
      if (a >= to) break;
      if (a > at) out.push([at, a]);
      at = Math.max(at, b);
      if (at >= to) break;
    }
    if (at < to) out.push([at, to]);
    return out;
  }

  /** Marks [from, to) as loaded, merging it with the ranges it touches. */
  add (from, to) {
    if (!(to > from)) return;
    const kept = [];
    for (const [a, b] of this.ranges) {
      if (b < from || a > to) kept.push([a, b]);
      else {
        from = Math.min(from, a);
        to = Math.max(to, b);
      }
    }
    kept.push([from, to]);
    this.ranges = kept.sort((x, y) => x[0] - y[0]);
  }
}
