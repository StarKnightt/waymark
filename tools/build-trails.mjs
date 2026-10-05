// Builds trail bundles (route, elevation PNG, map context) with the app's own browser code.
// usage: node tools/build-trails.mjs [id ...]   (dev server must be running; default: every trail in tools/trails.json)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { launch, BASE, gotoStable } from './chrome.mjs';

const SERVER = process.env.OVERPASS ?? 'osmapi';
const specs = JSON.parse(readFileSync('tools/trails.json', 'utf8'));
const want = process.argv.slice(2);
const jobs = want.length ? specs.filter((s) => want.includes(s.id)) : specs;
mkdirSync('public/trails', { recursive: true });
mkdirSync('.cache', { recursive: true });
const { ctx, page } = await launch({ profile: '.cache/chrome-build' });
try {
  page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text().slice(0, 300)); });
  await gotoStable(page, BASE + 'build.html', () => 'wmBuild' in window);
  for (const spec of jobs) {
    const t = Date.now();
    try {
      const out = await page.evaluate(([s, srv]) => window.wmBuild(s, srv), [spec, SERVER]);
      writeFileSync(`public/trails/${spec.id}.json`, JSON.stringify(out.file));
      writeFileSync(`public/trails/${spec.id}.png`, Buffer.from(out.png.split(',')[1], 'base64'));
      writeFileSync(`.cache/report-${spec.id}.json`, JSON.stringify(out.report, null, 2));
      const r = out.report;
      console.log(`== ${spec.id} (${((Date.now() - t) / 1000).toFixed(1)} s): ${r.name} | ${(r.lengthM / 1000).toFixed(1)} km, +${r.ascentM} m, ${r.walkMinutes} min, loop=${r.loop}, gap=${r.gap} m, dem ${r.dem}, ${r.waymarks.length} waymarks, ctx ${JSON.stringify(r.counts)}`);
      if (process.env.VERBOSE) for (const w of r.waymarks) console.log('   ', w);
    } catch (e) {
      console.log(`== ${spec.id} FAILED: ${e.message.split('\n')[0].slice(0, 300)}`);
    }
  }
} finally {
  await ctx.close();
}
