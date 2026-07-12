// Downloads the latin-subset woff2 files referenced by gf.css (Google Fonts CSS)
// and writes fonts.css with local url() references. Run: bun fetch.ts
const css = await Bun.file("gf.css").text();
const blocks = css.split("/*").slice(1);
const out: string[] = [];
let n = 0;
for (const raw of blocks) {
  if (!raw.startsWith(" latin */")) continue;
  const b = raw.slice(" latin */".length);
  const url = b.match(/https:[^)]+\.woff2/)?.[0];
  if (!url) continue;
  const fam = b.match(/font-family: '(.+?)';/)![1].replace(/ /g, "");
  const wght = b.match(/font-weight: (\d+)/)![1];
  const style = b.match(/font-style: (\w+)/)![1];
  const name = `${fam}-${wght}${style === "italic" ? "i" : ""}.woff2`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  await Bun.write(name, await res.arrayBuffer());
  out.push(b.replace(/url\(https:[^)]+\)/, `url(${name})`).trim());
  n++;
}
await Bun.write("fonts.css", out.join("\n"));
console.log(n, "fonts downloaded");
