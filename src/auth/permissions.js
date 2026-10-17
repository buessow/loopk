// Apache Shiro style wildcard permissions, as used by Nightscout:
// "api:treatments:create", "*:*:read", "*", "api:entries,treatments:read".

function partMatches (pattern, value) {
  return pattern === '*' || pattern.split(',').includes(value);
}

export function implies (pattern, permission) {
  const p = pattern.split(':');
  const q = permission.split(':');
  for (let i = 0; i < p.length; i++) {
    if (i >= q.length) {
      if (p[i] !== '*') return false;
      continue;
    }
    if (!partMatches(p[i], q[i])) return false;
  }
  // A shorter pattern implies everything below it ("api" implies "api:x:y").
  return true;
}

export function hasPermission (patterns, permission) {
  return (patterns || []).some((p) => p && implies(p, permission));
}
