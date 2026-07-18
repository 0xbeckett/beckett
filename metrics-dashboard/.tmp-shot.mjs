import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1200, height: 2000 }, deviceScaleFactor: 1 });
await p.goto('http://127.0.0.1:8971/', { waitUntil: 'networkidle' });
// click Recall Eval tab
await p.getByRole('button', { name: 'Recall Eval' }).click();
await p.waitForTimeout(1400);
await p.screenshot({ path: '.tmp/recall-dark.png', fullPage: true });
// light mode
await p.getByRole('button', { name: /Switch to light theme/ }).click().catch(()=>{});
await p.waitForTimeout(900);
await p.screenshot({ path: '.tmp/recall-light.png', fullPage: true });
await b.close();
console.log('shots done');
