// Vergleicht zwei Dashboard-Snapshots feldweise und listet Abweichungen.
import { readFileSync } from 'node:fs';
const [a, b] = process.argv.slice(2).map((f) => JSON.parse(readFileSync(f, 'utf8')));
const diffs = [];
const walk = (x, y, p) => {
  if (x && y && typeof x === 'object' && typeof y === 'object') {
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], p ? `${p}.${k}` : k);
  } else if (JSON.stringify(x) !== JSON.stringify(y)) diffs.push(`${p}: ${JSON.stringify(x)} → ${JSON.stringify(y)}`);
};
walk(a, b, '');
console.log(diffs.length ? diffs.join('\n') : '(keine Abweichung)');
