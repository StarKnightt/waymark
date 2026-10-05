// Records demo clips with a CDP screencast and assembles them with ffmpeg (real frame timings).
// usage: node tools/capture.mjs <flyover|pocket|write> [outDir]   (dev server must be running)
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { launch, BASE } from './chrome.mjs';

const [scene = 'flyover', outDir = '.cache/capture'] = process.argv.slice(2);
const phone = scene === 'pocket';
const W = phone ? 390 : 1280, H = phone ? 844 : 720;
const frames = `${outDir}/${scene}`;
rmSync(frames, { recursive: true, force: true });
mkdirSync(frames, { recursive: true });
const { ctx, page } = await launch({ profile: scene === 'write' ? '.cache/chrome-eval' : '.cache/chrome-capture', width: W, height: H, mobile: phone });
const cdp = await ctx.newCDPSession(page);
const shots = [];
cdp.on('Page.screencastFrame', async (f) => {
  shots.push({ data: f.data, t: f.metadata.timestamp });
  await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
});
const start = () => cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: W * (phone ? 2 : 1), maxHeight: H * (phone ? 2 : 1), everyNthFrame: 1 });
const stop = () => cdp.send('Page.stopScreencast');
const wait = (ms) => page.waitForTimeout(ms);

try {
  if (scene === 'flyover') {
    await page.goto(`${BASE}?capture&nopanel&flysec=26#/t/mist-trail`);
    await page.waitForFunction(() => document.querySelector('.cues li'));
    await wait(2500);
    await start();
    await wait(900);
    await page.evaluate(() => window.__wm.play());
    await page.waitForFunction(() => !window.__wm.world().flying, null, { timeout: 120000 });
    await wait(1200);
    await stop();
  } else if (scene === 'pocket') {
    await page.goto(`${BASE}#/t/lake-agnes`);
    await page.waitForFunction(() => document.querySelector('.cues li'));
    await page.click('[data-act="send"]');
    await page.waitForSelector('.linkbox');
    const link = await page.$eval('.linkbox', (e) => e.value);
    await page.goto(link.replace(/^https?:\/\/[^/]+\/(waymark\/)?/, BASE).replace('#/walk/', '?fast#/walk/'));
    await page.waitForSelector('.p-start');
    await page.evaluate(() => { speechSynthesis.speak = () => {}; });
    await wait(800);
    await start();
    await wait(1500);
    await page.click('[data-act="sim"]');
    await wait(600);
    await page.mouse.click(W / 2, 120);
    await wait(16000);
    await stop();
  } else if (scene === 'write') {
    await page.goto(`${BASE}#/t/triund`);
    await page.waitForFunction(() => document.querySelector('.cues li'));
    await wait(2000);
    await start();
    await wait(1000);
    await page.click('[data-act="rewrite"]');
    await page.waitForFunction(() => location.hash.startsWith('#/g/') && document.querySelector('.cues li'), null, { timeout: 180000 });
    await wait(1500);
    await page.evaluate(() => document.querySelector('.panel').scrollBy({ top: 520, behavior: 'smooth' }));
    await wait(2500);
    await stop();
  }
  await wait(300);
  shots.forEach((s, i) => writeFileSync(`${frames}/${String(i).padStart(5, '0')}.jpg`, Buffer.from(s.data, 'base64')));
  const list = shots.map((s, i) => `file '${String(i).padStart(5, '0')}.jpg'\nduration ${((shots[i + 1]?.t ?? s.t + 0.04) - s.t).toFixed(4)}`).join('\n');
  writeFileSync(`${frames}/list.txt`, `${list}\nfile '${String(shots.length - 1).padStart(5, '0')}.jpg'\n`);
  const mp4 = `${outDir}/${scene}.mp4`;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', `${frames}/list.txt`, '-vf', 'fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p', '-c:v', 'libx264', '-crf', '20', '-preset', 'slow', '-movflags', '+faststart', mp4]);
  console.log(`${scene}: ${shots.length} frames -> ${mp4}`);
} finally {
  await ctx.close();
}
