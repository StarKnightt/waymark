// Developer entry: unit checks for the fact checker (run by tools/test-check.mjs).
import { checkBriefing, checkCue } from './ai/check';
import type { TrailFacts, Waymark } from './geo/facts';

const base = { lat: 0, lon: 0, title: '', priority: 1, required: false, names: [] as string[] };
const climb: Waymark = {
  ...base, id: 'w12', at: 1540, ele: 1907, kinds: ['climb'],
  facts: ['a steady climb starts here; it is 730 m long and gains 70 m (about 10% on average), topping out at 1980 m', 'after this, the next 550 m climbs 60 m'],
  numbers: [
    { value: 730, unit: 'm', tol: 73, role: 'length' }, { value: 70, unit: 'm', tol: 25, role: 'gain' }, { value: 10, unit: '%', tol: 2, role: 'grade' },
    { value: 1980, unit: 'm', tol: 20, role: 'elev' }, { value: 550, unit: 'm', tol: 55, role: 'length' }, { value: 60, unit: 'm', tol: 20, role: 'gain' },
  ],
};
const junction: Waymark = {
  ...base, id: 'w16', at: 2940, ele: 2052, kinds: ['lake', 'junction'], turn: 'right', required: true, names: ['Mirror Lake', 'Lake Agnes Trail'],
  facts: ['"Mirror Lake" comes into view on your right', 'junction: turn right on "Lake Agnes Trail"; the path straight ahead is not your route'], numbers: [],
};
const facts = {
  name: 'Lake Agnes Trail', loop: false, names: ['Lake Agnes Trail', 'Mirror Lake', 'Lake Agnes', 'Lake Louise'], summary: ['3.7 km one way', 'about 400 m of climbing'],
  numbers: [{ value: 3.7, unit: 'km', tol: 0.15, role: 'total' }, { value: 403, unit: 'm', tol: 40, role: 'gain' }, { value: 102, unit: 'min', tol: 15, role: 'time' }],
  waymarks: [climb, junction], walkMinutes: 102,
} as unknown as TrailFacts;

type Case = { name: string; got: unknown; ok: boolean };
declare global { interface Window { wmCheckTest: () => Case[] } }

window.wmCheckTest = () => {
  const cases: Case[] = [];
  const t = (name: string, got: { text: string }, ok: (s: string) => boolean) => cases.push({ name, got: got.text, ok: ok(got.text) });
  t('number with the wrong role is removed', checkCue('A steady climb begins here. Gain 730 meters in 1.5 km, about 10% on average.', climb, facts), (s) => s === 'A steady climb begins here.' || !/730/.test(s));
  t('correct numbers survive', checkCue('A steady climb starts here: it is 730 m long and gains 70 m, topping out at 1980 m.', climb, facts), (s) => /730 m long/.test(s) && /70 m/.test(s));
  t('invented turn is removed', checkCue('The climb starts here. Turn right at the top and keep going.', climb, facts), (s) => !/right/.test(s));
  t('wrong turn is swapped', checkCue('Turn left onto the Lake Agnes Trail. Mirror Lake is on your right.', junction, facts), (s) => /Turn right onto the Lake Agnes Trail/.test(s));
  t('unknown place is removed', checkCue('Turn right here. Moraine Lake is just ahead.', junction, facts), (s) => !/Moraine/.test(s) && /Turn right/.test(s));
  t('sentence-initial words are not names', checkCue('Toilets are close by. Turn right on the Lake Agnes Trail.', junction, facts), (s) => /Toilets/.test(s));
  t('invented side path is removed', checkCue('Turn right on the Lake Agnes Trail. The path on the left is not your route.', junction, facts), (s) => !/on the left/.test(s) && /Turn right/.test(s));
  t('listed side path is kept', checkCue('Turn right on the Lake Agnes Trail. The path straight ahead is not your route.', junction, facts), (s) => /straight ahead/.test(s));
  t('straight on at a turn is removed', checkCue('Continue straight on the Lake Agnes Trail. Mirror Lake is on your right.', junction, facts), (s) => !/straight on the Lake/.test(s));
  t('briefing keeps true numbers', checkBriefing('The Lake Agnes Trail is 3.7 km long with about 400 m of climbing. Allow about 1 h 42 min of walking.', facts), (s) => /3\.7 km/.test(s) && /1 h 42 min/.test(s));
  t('briefing drops a made-up number', checkBriefing('The trail is 3.7 km long. It has 12 waterfalls. Mirror Lake is the highlight.', facts), (s) => !/12/.test(s) && /Mirror Lake/.test(s));
  return cases;
};
