from pathlib import Path

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()

old = """    /\\b(crafting|creating|generating|building|preparing|personalizing|personalising|analyzing|analysing|processing|loading|calculating|finalizing|finalising)\\b/,"""
new = """    /\\b(crafting|creating|generating|building|preparing|personalizing|personalising|analyzing|analysing|processing|loading|calculating|finalizing|finalising|matching|assessing|evaluating|scoring|tailoring|compiling)\\b/,"""
if old not in s:
    raise SystemExit('passive transition signal line not found')
s = s.replace(old, new, 1)

old2 = """    if (!state || state.group.length < 2 || !isPassiveTransitionScreen(state.pageText)) {
      return { handled: false, advanced: false };
    }
"""
new2 = """    if (!state || state.group.length < 2) {
      return { handled: false, advanced: false };
    }

    const normalizedPageText = (state.pageText || '').toLowerCase().replace(/\\s+/g, ' ').trim();
    const hasProgressPercent = /\\b(?:[1-9]?\\d|100)%\\b/.test(normalizedPageText);
    const evaluationLanguage = /\\b(matching|analyzing|analysing|processing|loading|calculating|assessing|evaluating|scoring|preparing|building|creating|generating|personalizing|personalising|tailoring|compiling)\\b/.test(normalizedPageText);
    const evaluationGateContext = isPassiveTransitionScreen(state.pageText) || (hasProgressPercent && evaluationLanguage);
    if (!evaluationGateContext) {
      return { handled: false, advanced: false };
    }
"""
if old2 not in s:
    raise SystemExit('passive evaluation gate precondition not found')
s = s.replace(old2, new2, 1)

p.write_text(s)
