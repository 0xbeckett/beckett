import { chromium } from 'playwright';
const b = await chromium.launch();
async function shot(name, {width,height,dark,full=true}) {
  const p = await b.newPage({ viewport:{width,height}, deviceScaleFactor:2, colorScheme: dark?'dark':'light' });
  await p.goto('http://127.0.0.1:4890/', { waitUntil:'networkidle' });
  await p.waitForTimeout(1600); // let dither canvases paint + entrance anim settle
  await p.screenshot({ path:name, fullPage:full });
  const errs = [];
  await p.close();
  console.log('wrote', name);
}
await shot('shot-desktop-light.png', {width:1280,height:900,dark:false});
await shot('shot-desktop-dark.png',  {width:1280,height:900,dark:true});
await shot('shot-mobile.png',        {width:390,height:844,dark:false});
await b.close();
