export function check(pillar, id, group, title, status, weight, detail, recommendation, fix = 'manual') {
  return { id: `${pillar}:${id}`, pillar, group, title, status, weight, detail, recommendation, fix };
}

export function scoreChecks(checks) {
  const value = { pass: 1, warn: 0.5, fail: 0 };
  const total = checks.reduce((s, c) => s + c.weight, 0);
  if (!total) return 0;
  return Math.round((checks.reduce((s, c) => s + c.weight * value[c.status], 0) / total) * 100);
}
