// Which loopk serves these pages: false on the full server, which answers
// /api/… itself; scripts/build-static.js writes true for the static server
// (docs/modes.md), whose pages answer everything in the browser.
export const STATIC = false;
