import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemory } from "./src/memory/index.ts";

const log = { info(){}, warn(){}, error(){}, debug(){} } as any;
function tmp(){ const dir = mkdtempSync(join(tmpdir(),"r-")); return { store: createMemory({memoryDir:dir,logger:log,git:false}), dir }; }
const idx = (dir:string)=>readFileSync(join(dir,"MEMORY.md"),"utf8");

test("A: update with new description rewrites the one-liner", async () => {
  const {store,dir}=tmp();
  await store.remember({op:"create",name:"n1",type:"reference",description:"old hook",body:"b",source:"manual",reason:"s"});
  await store.remember({op:"update",name:"n1",type:"reference",description:"new hook",body:"b2",source:"manual",reason:"s"});
  expect(idx(dir)).toContain("new hook");
  expect(idx(dir)).not.toContain("old hook");
});

test("B: regression cross-fork shape - update body only", async () => {
  const {store,dir}=tmp();
  await store.remember({op:"create",name:"cross-fork-pr-limit",type:"reference",description:"PAT can't open PRs on external repos; hand a compare link",body:"broken",source:"manual",reason:"s"});
  await store.remember({op:"update",name:"cross-fork-pr-limit",type:"reference",body:"CONFIRMED WORKING under the classic PAT",source:"manual",reason:"reobserve"});
  expect(idx(dir)).not.toContain("can't open PRs");
});

test("C: append re-observation only body", async () => {
  const {store,dir}=tmp();
  await store.remember({op:"create",name:"n3",type:"reference",description:"broken claim",body:"orig",source:"manual",reason:"s"});
  await store.remember({op:"append",name:"n3",type:"reference",body:"actually fixed now",source:"manual",reason:"s"});
  console.log("append idx:", idx(dir).split("\n").filter(l=>l.includes("n3")));
});
