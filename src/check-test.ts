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
  numbers: [{ value: 3.7, unit: 'km', tol: 0.15, role: 'total' }, { value: 403, unit: 'm', tol: 40, role: 'gain' }, { value: 102, unit: 'min', tol: 10, role: 'time' }],
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
  const two: Waymark = { ...base, id: 'w5', at: 600, ele: 80, kinds: ['junction'], turn: 'left', required: true, names: ['Hazel Avenue', 'Hale Lane'],
    facts: ['junction: turn left onto "Hazel Avenue"; the road on the right is not your route', 'junction: turn right onto "Hale Lane"; the road straight ahead is not your route'], numbers: [] };
  const f2 = { ...facts, names: [...facts.names, 'Hazel Avenue', 'Hale Lane', 'Sharma store', 'Benstein Trail'] } as unknown as TrailFacts;
  t('two junctions in one waymark keep both turns', checkCue('Turn left onto Hazel Avenue. Turn right onto Hale Lane.', two, f2), (s) => s === 'Turn left onto Hazel Avenue. Turn right onto Hale Lane.');
  const branchLeft: Waymark = { ...junction, facts: ['junction: turn right on "Lake Agnes Trail"; the path on the left is not your route', 'a viewpoint on your right'] };
  t('a branch on the left is not a landmark side', checkCue('Turn right on the Lake Agnes Trail. The path on the left is not your route.', branchLeft, f2), (s) => /path on the left/.test(s));
  t('"do not go straight" is not a straight-on instruction', checkCue('Turn right on the Lake Agnes Trail. Do not go straight ahead.', junction, f2), (s) => /Do not go straight ahead/.test(s));
  const shop: Waymark = { ...base, id: 'w6', at: 2150, ele: 2354, kinds: ['rest'], names: ['Sharma store'], facts: ['"Sharma store", a cafe on your right'], numbers: [] };
  t('a sentence-initial verb is not part of a name', checkCue('Find the Sharma store on your right.', shop, f2), (s) => /Sharma store/.test(s));
  t('a time written in words is checked', checkBriefing('The Lake Agnes Trail is 3.7 km long. The walk takes about an hour and a half.', facts), (s) => !/hour and a half/.test(s));
  t('a correct time in words survives', checkBriefing('The Lake Agnes Trail is 3.7 km long. The walk takes about an hour and forty minutes.', facts), (s) => /forty minutes/.test(s));
  t('compound number words are read correctly', checkCue('A steady climb starts here. It is seven hundred thirty meters long and gains seventy meters.', climb, facts), (s) => /seven hundred thirty/.test(s));
  t('a wrong compound number is caught', checkCue('A steady climb starts here. It is four hundred fifty meters long.', climb, facts), (s) => !/four hundred/.test(s));
  t('"Toilets and ..." is not a name', checkCue('Toilets and a bench are here. Turn right on the Lake Agnes Trail.', junction, f2), (s) => /Toilets and a bench/.test(s));
  t('"a peak of" reads as an elevation', checkCue('The climb tops out at a peak of 1980 meters.', climb, facts), (s) => /1980/.test(s));
  t('kilometres after "climb of" are a length', checkBriefing('The Lake Agnes Trail is 3.7 km long. The main climb of 3.7 km gains about 400 m.', facts), (s) => /climb of 3\.7 km/.test(s));
  t('quotes and lower-case starts are tidied', checkCue('turn right on "Lake Agnes Trail". mirror Lake is on your right.', junction, facts), (s) => s === 'Turn right on Lake Agnes Trail. Mirror Lake is on your right.');
  const bridgeW: Waymark = { ...base, id: 'w2', at: 300, ele: 300, kinds: ['bridge'], names: ['紅葉橋'], facts: ['a bridge, "紅葉橋"'], numbers: [] };
  const f3 = { ...f2, names: [...f2.names, '紅葉橋'] } as unknown as TrailFacts;
  t('a known name in another script is kept', checkCue('You cross the bridge 紅葉橋.', bridgeW, f3), (s) => /紅葉橋/.test(s));
  t('an unknown name in another script is removed', checkCue('You cross the bridge 紅葉橋. Then you reach 高尾山口.', bridgeW, f3), (s) => !/高尾山口/.test(s) && /紅葉橋/.test(s));
  t('a turn is restored when its sentence had to go', checkCue('Turn right onto the Agnes Highline. Mirror Lake is on your right.', junction, facts), (s) => /^Turn right on Lake Agnes Trail\./.test(s) && /Mirror Lake/.test(s));
  t('"three point seven kilometers" is read as 3.7 km', checkBriefing('The trail covers about three point seven kilometers. Mirror Lake is the highlight.', facts), (s) => /three point seven/.test(s));
  t('"go straight ahead" at a turn is removed even if a side is mentioned', checkCue('Turn right on the Lake Agnes Trail. Go straight ahead, as the path on the left is not your route.', junction, facts), (s) => s === 'Turn right on the Lake Agnes Trail.');
  t('a summit the facts do not mention is removed', checkCue('A steady climb starts here. It leads to the summit.', climb, facts), (s) => !/summit/.test(s));
  t('briefing drops a summit the walk does not reach', checkBriefing('The Lake Agnes Trail is 3.7 km long. The walk ends at a summit.', facts), (s) => !/summit/.test(s) && /3\.7 km/.test(s));
  const f4 = { ...f2, names: [...f2.names, 'Roys Peak Track'] } as unknown as TrailFacts;
  t('a feature word inside a name is fine', checkCue('Turn right on the Roys Peak Track.', junction, f4), (s) => /Roys Peak Track/.test(s));
  t('"a peak of 1980 m" is not a summit claim', checkCue('A steady climb starts here. It reaches a peak of 1980 m.', climb, facts), (s) => /peak of 1980/.test(s));
  t('"a climb of 730 m gaining 70 m" reads 730 as the length', checkCue('This is a steady climb of 730 meters gaining 70 meters.', climb, facts), (s) => /730 meters gaining 70/.test(s));
  t('briefing keeps true numbers', checkBriefing('The Lake Agnes Trail is 3.7 km long with about 400 m of climbing. Allow about 1 h 42 min of walking.', facts), (s) => /3\.7 km/.test(s) && /1 h 42 min/.test(s));
  t('briefing drops a made-up number', checkBriefing('The trail is 3.7 km long. It has 12 waterfalls. Mirror Lake is the highlight.', facts), (s) => !/12/.test(s) && /Mirror Lake/.test(s));
  return cases;
};
