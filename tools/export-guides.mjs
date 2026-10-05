// Copies the guides Gemma wrote for the demo trails during an eval run into public/guides/.
// usage: node tools/export-guides.mjs [eval/results-tools.json]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const file = process.argv[2] ?? 'eval/results-tools.json';
const demos = JSON.parse(readFileSync('tools/trails.json', 'utf8')).filter((s) => s.demo).map((s) => s.id);
const { rows } = JSON.parse(readFileSync(file, 'utf8'));
mkdirSync('public/guides', { recursive: true });
for (const id of demos) {
  const row = rows.find((r) => r.id === id);
  if (!row?.guide) { console.log(`skip ${id}: not in ${file}`); continue; }
  writeFileSync(`public/guides/${id}.json`, JSON.stringify(row.guide));
  console.log(`${id}: ${row.guide.cues.length} cues, ${row.guide.stats.ms} ms`);
}
