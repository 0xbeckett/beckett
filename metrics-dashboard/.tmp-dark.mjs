import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1200, height: 1400 }, colorScheme: 'dark' });
await p.goto('http://127.0.0.1:8971/', { waitUntil: 'networkidle' });
await p.getByRole('button', { name: 'Recall Eval' }).click();
await p.waitForTimeout(1400);
await p.screenshot({ path: '.tmp/recall-truedark.png' });
await b.close();
console.log('ok');
