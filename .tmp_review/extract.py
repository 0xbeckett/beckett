import re, sys

def extract_brace_block(lines, start_idx):
    depth = 0
    started = False
    body = []
    i = start_idx
    while i < len(lines):
        line = lines[i]
        for ch in line:
            if ch == '{':
                depth += 1
                started = True
            elif ch == '}':
                depth -= 1
        body.append(line)
        if started and depth == 0:
            break
        i += 1
    return body, i

old = open('/tmp/main-baseline/src/cli/beckett.ts').read().splitlines()

groups = ["ticket","discord","channels","federation","identity","access","maintainer","proactivity","status","quick","eval","site","preset","journal","config","rpc"]

outdir = '/home/beckett/Projects/beckett/.beckett/worktrees/d0464b61-dc9b-4d46-a1bd-9749b8eba4e1/.tmp_review'

for g in groups:
    pat = re.compile(r'if \(group === "%s"' % re.escape(g))
    idx = None
    for i, l in enumerate(old):
        if pat.search(l):
            idx = i
            break
    if idx is None:
        print(f"OLD BLOCK NOT FOUND for {g}")
        continue
    block, end = extract_brace_block(old, idx)
    open(f'{outdir}/old_{g}.txt', 'w').write("\n".join(block))
    print(f"{g}: old lines {idx+1}-{end+1} ({len(block)} lines)")
