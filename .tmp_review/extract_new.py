import re

def extract_func_block(lines, start_idx):
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

new = open('/tmp/v5-review/src/cli/beckett.ts').read().splitlines()
outdir = '/home/beckett/Projects/beckett/.beckett/worktrees/d0464b61-dc9b-4d46-a1bd-9749b8eba4e1/.tmp_review'

funcs = ["runTicket","runChannels","runFederation","runIdentity","runAccess","runMaintainer",
         "runProactivity","runStatus","runQuick","runEval","runSite","runPreset","runJournal",
         "runConfig","runRpc","runDiscordReply","runDiscordDecline"]

for f in funcs:
    pat = re.compile(r'^(async )?function %s\(' % f)
    idx = None
    for i, l in enumerate(new):
        if pat.search(l):
            idx = i
            break
    if idx is None:
        print(f"NEW FUNC NOT FOUND for {f}")
        continue
    block, end = extract_func_block(new, idx)
    open(f'{outdir}/new_{f}.txt', 'w').write("\n".join(block))
    print(f"{f}: new lines {idx+1}-{end+1} ({len(block)} lines)")
