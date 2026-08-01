import os, sys, time

CLK = os.sysconf("SC_CLK_TCK")
PAGE = os.sysconf("SC_PAGE_SIZE")

def all_procs():
    procs = {}
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open(f"/proc/{pid}/stat") as f:
                data = f.read()
            # comm may contain spaces/parens; split on last ')'
            rp = data.rindex(")")
            ppid = int(data[rp+2:].split()[1])
            procs[int(pid)] = ppid
        except Exception:
            pass
    return procs

def descendants(root):
    procs = all_procs()
    children = {}
    for p, pp in procs.items():
        children.setdefault(pp, []).append(p)
    out, stack = set(), [root]
    while stack:
        cur = stack.pop()
        for c in children.get(cur, []):
            if c not in out:
                out.add(c)
                stack.append(c)
    return out

def cpu_and_rss(pids):
    jiff = 0
    rss = 0
    for pid in pids:
        try:
            with open(f"/proc/{pid}/stat") as f:
                data = f.read()
            rp = data.rindex(")")
            fields = data[rp+2:].split()
            utime = int(fields[11])
            stime = int(fields[12])
            jiff += utime + stime
        except Exception:
            pass
        try:
            with open(f"/proc/{pid}/statm") as f:
                rss += int(f.read().split()[1]) * PAGE
        except Exception:
            pass
    return jiff, rss

root = int(sys.argv[1])
window = float(sys.argv[2]) if len(sys.argv) > 2 else 12.0
pids = descendants(root)
pids.add(root)
j0, _ = cpu_and_rss(pids)
time.sleep(window)
# recompute descendants (some renderers may have changed) union
pids2 = descendants(root); pids2.add(root)
pids_all = pids | pids2
j1, rss = cpu_and_rss(pids_all)
cpu_pct = (j1 - j0) / CLK / window * 100.0
print(f"IDLE_CPU_PCT={cpu_pct:.1f} RSS_MB={rss/1024/1024:.0f} NPROC={len(pids_all)}")
