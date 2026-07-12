import re, html

COM = chr(47) * 2  # //

def hl(code):
    out = []
    for line in code.split('\n'):
        if COM in line:
            body, com = line.split(COM, 1)
            com = '<span class="c">' + COM + html.escape(com) + '</span>'
        else:
            body, com = line, ''
        body = html.escape(body)
        body = re.sub(r'(&quot;[^&]*?&quot;)', r'<span class="s">\1</span>', body)
        out.append(body + com)
    return '<pre><code>' + '\n'.join(out) + '</code></pre>'

a1 = '''{ "version": 1,
  "entry": "implement",
  "nodes": {
    "implement": {
      "kind": "worker",
      "cast": { "harness": "pi",
                "effort": "medium" },
      "onPass": "done",
      "onFail": "park",
      "retries": 3
      ''' + COM + ''' = MAX_IMPLEMENT_RETRIES
    }
} }'''

a2 = '''{ "version": 1,
  "entry": "implement",
  "nodes": {
    "implement": {
      "kind": "worker",
      "cast": { "harness": "pi",
                "effort": "high" },
      "onPass": "review",
      "onFail": "park",
      "maxVisits": 3,
      ''' + COM + ''' = MAX_REWORK_CYCLES
      "retries": 3
    },
    "review": {
      "kind": "gate",
      "by": {
        "cast": { "harness": "claude",
                  "model": "claude-sonnet-5",
                  "effort": "high" },
        "rubric": "criteria-vs-diff"
      },
      "onPass": "done",
      "onFail": "implement",
      "maxFails": 3
    }
} }'''

a3 = '''{ "version": 1, "entry": "design", "nodes": {
  "design": {
    "kind": "worker",
    "cast": { "harness": "claude", "model": "claude-opus-4-8", "effort": "high" },
    "artifact": "docs/design/<id>.md",
    "onPass": "completeness", "onFail": "park", "maxVisits": 2
  },
  "completeness": {
    "kind": "gate",
    "by": { "cast": { "harness": "claude", "model": "claude-haiku-4-5", "effort": "low" },
            "rubric": "design-doc completeness" },
    "onPass": "approve", "onFail": "design", "maxFails": 2       ''' + COM + ''' = MAX_DESIGN_CYCLES
  },
  "approve": {
    "kind": "gate", "by": "human",                               ''' + COM + ''' PARKED: zero tokens
    "onPass": "implement", "onFail": "design", "maxFails": 3
  },
  "implement": {
    "kind": "worker", "cast": { "harness": "pi", "effort": "medium" },
    "onPass": "review", "onFail": "park", "maxVisits": 3
  },
  "review": {
    "kind": "gate",
    "by": { "cast": { "harness": "claude", "model": "claude-sonnet-5", "effort": "high" },
            "rubric": "criteria-vs-diff" },
    "onPass": "done", "onFail": "implement", "maxFails": 3
  }
} }'''

src = open('07-appendix.html').read()
pres = re.findall(r'<pre>.*?<' + chr(47) + 'pre>', src, re.S)
assert len(pres) == 3, len(pres)
for old, new in zip(pres, [hl(a1), hl(a2), hl(a3)]):
    src = src.replace(old, new)
open('07-appendix.html', 'w').write(src)
print('done; longest a3 line:', max(len(l) for l in a3.split('\n')))
