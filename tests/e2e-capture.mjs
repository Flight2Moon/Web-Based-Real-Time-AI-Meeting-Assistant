// End-to-end check in real Chrome (headful): share another tab's audio → live transcript (+ translation).
// Needs: `npm run dev` running, Google Chrome installed, tests/samples/mixed.wav (see README).
// Usage: node tests/e2e-capture.mjs [wasm|webgpu] [model] [translateTo]
import puppeteer from 'puppeteer-core';

const [device = 'wasm', model = 'onnx-community/whisper-base', tgt = ''] = process.argv.slice(2);
const base = process.env.APP_URL ?? 'http://localhost:5173/';
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: false,
  protocolTimeout: 600000,
  args: ['--auto-select-tab-capture-source-by-title=MeetingSim', '--autoplay-policy=no-user-gesture-required'],
});
try {
  const sim = await browser.newPage();
  await sim.goto(new URL('tests/sim.html', 'http://localhost:5173/').href);
  const app = await browser.newPage();
  app.on('console', (m) => m.type() === 'error' && console.log('[console.error]', m.text()));
  await app.goto(base, { waitUntil: 'networkidle2' });
  await app.waitForFunction(() => crossOriginIsolated, { timeout: 15000, polling: 500 }).catch(() => {}); // static hosts: service worker reloads once
  await app.bringToFront();
  console.log('env:', await app.evaluate(() => ({ isolated: crossOriginIsolated, webgpu: 'gpu' in navigator, translator: 'Translator' in self, ua: navigator.userAgent.match(/Chrome\/[\d.]+/)[0] })));
  for (const [id, v] of [['sel-device', device], ['sel-model', model], ['sel-tgt', tgt], ['sel-lang', 'auto']])
    await app.evaluate((id, v) => { const s = document.getElementById(id); s.value = v; s.dispatchEvent(new Event('change')); }, id, v);
  // Test-only: don't blast the sample speech through the speakers while it is being captured.
  await app.evaluate(() => { const g = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getDisplayMedia = (o) => g({ ...o, audio: { ...o.audio, suppressLocalAudioPlayback: true } }); });
  await app.click('#btn-capture');
  const t0 = Date.now();
  await app.waitForFunction(() => document.querySelectorAll('#rows .row').length >= 6 || !document.getElementById('error').hidden, { timeout: 240000, polling: 1000 }) // timer polling: the app tab is in the background while the captured tab has focus
    .catch(async () => console.log('TIMEOUT. state:', await app.$eval('#state', (e) => e.textContent), await app.$eval('#live-meta', (e) => e.textContent), await app.$eval('#progress-text', (e) => e.textContent)));
  await new Promise((r) => setTimeout(r, 4000));
  console.log('error banner:', JSON.stringify(await app.$eval('#error', (e) => e.textContent)));
  console.log('rows after', ((Date.now() - t0) / 1000).toFixed(0), 's:');
  for (const r of await app.$$eval('#rows .row', (rs) => rs.map((r) => [...r.children].map((c) => c.textContent).join(' | ')))) console.log('  ', r);
  console.log('metrics:', await app.evaluate(() => { const m = window.__metrics; return { device: m.device, loadS: +(m.modelLoadMs / 1000).toFixed(1), rtf: +(m.asrMsSum / 1000 / m.audioSecSum).toFixed(3), avgLatencyMs: Math.round(m.latSum / m.n), avgTranslateMs: Math.round(m.trSum / (m.trN || 1)), translated: m.trN, utterances: m.n }; }));
  // Capture target goes away → app must report it, not fail silently.
  await sim.close();
  await new Promise((r) => setTimeout(r, 2500));
  console.log('after closing captured tab:', JSON.stringify(await app.$eval('#error', (e) => e.textContent)), '| state:', await app.$eval('#state', (e) => e.textContent));
  await app.click('#btn-stop');
  await new Promise((r) => setTimeout(r, 1500));
  console.log('after stop: state =', await app.$eval('#state', (e) => e.textContent), '| saved meetings =', await app.$$eval('#meetings li', (l) => l.length));
} finally {
  await browser.close();
}
