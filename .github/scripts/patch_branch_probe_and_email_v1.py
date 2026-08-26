from pathlib import Path

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()

old_email = "  const RUN_EMAIL = `${generateRandomAsciiString(16)}@gmail.com`;"
new_email = "  const RUN_EMAIL = 'REMOVED_EMAIL';"
if old_email not in s and new_email not in s:
    raise SystemExit('RUN_EMAIL marker missing')
if old_email in s:
    s = s.replace(old_email, new_email, 1)

old_probe = '''  function branchProbeIndexes(optionCount, maxProbe = 4) {
    if (optionCount <= maxProbe) return Array.from({ length: optionCount }, (_, i) => i);
    const raw = [0, optionCount - 1, Math.round((optionCount - 1) / 3), Math.round(((optionCount - 1) * 2) / 3)];
    const unique = [];
    for (const index of raw) if (!unique.includes(index)) unique.push(index);
    return unique.slice(0, maxProbe);
  }
'''
new_probe = '''  function branchProbeIndexes(optionCount, maxProbe = 4) {
    const indexes = Array.from({ length: optionCount }, (_, i) => i);
    for (let i = indexes.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indexes[i], indexes[j]] = [indexes[j], indexes[i]];
    }
    return indexes.slice(0, Math.min(maxProbe, optionCount));
  }
'''
if old_probe not in s and new_probe not in s:
    raise SystemExit('branchProbeIndexes block missing')
if old_probe in s:
    s = s.replace(old_probe, new_probe, 1)

start_marker = '''    // IMPORTANT: the crawler's goal is to find ALL unique funnel pages. A 4-answer
    // probe is only an optimization for finding evidence of branching quickly; it
    // must never be treated as proof that untested answers are identical. If the
    // initial probe found only one outcome and the question has additional answers,
    // test those remaining answers before declaring "no conditional branch".
'''
end_marker = '''    if (probeFingerprints.size <= 1 && unresolvedIndexes.length === 0) {
'''
start = s.find(start_marker)
end = s.find(end_marker, start if start >= 0 else 0)
if start >= 0 and end >= 0:
    replacement = '''    // The four-answer sample is the decision stage. If all sampled answers lead to
    // the same immediate next page, do not test every unprobed answer just to prove
    // sameness. Untested answers remain unresolved and the normal path continues.
    // If the sample proves branching, the existing branch-confirmed path below can
    // still test remaining answers to collect distinct conditional pages.

'''
    s = s[:start] + replacement + s[end:]
elif 'The four-answer sample is the decision stage.' not in s:
    raise SystemExit('exhaustive untested-answer block markers missing')

old_log = '    console.log(`Probing up to ${probedIndexes.length} strategically spread answers to determine whether this question has conditional next pages.`);'
new_log = '    console.log(`Randomly probing up to ${probedIndexes.length} answers to determine whether this question has conditional next pages.`);'
if old_log in s:
    s = s.replace(old_log, new_log, 1)

p.write_text(s)
