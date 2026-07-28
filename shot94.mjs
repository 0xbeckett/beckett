import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 });
await p.goto('https://beckett-preview.0xbeckett.me/pricing.html', { waitUntil: 'networkidle' });
await p.waitForFunction(() => {
  const el = document.querySelector('[data-bind="tph"]');
  return el && el.textContent && el.textContent !== '…' && /[0-9]/.test(el.textContent);
}, { timeout: 15000 });
await p.waitForTimeout(1500);
// The .rv elements reveal on scroll via IntersectionObserver, which never fires
// for off-screen content in a full-page shot. Force them all into the revealed state.
await p.evaluate(() => {
  document.querySelectorAll('.rv').forEach((n) => {
    n.style.transitionDelay = '0ms';
    n.classList.add('in');
  });
});
await p.waitForTimeout(1200);
const out = '/home/beckett/Projects/beckett/.beckett/worktrees/#94/pricing-94.png';
await p.screenshot({ path: out, fullPage: true });
console.log('wrote', out);
await b.close();
