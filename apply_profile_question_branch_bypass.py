from pathlib import Path

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()

anchor = """function isSpeechInputScreen(text) {
"""
helper = """function isNonBranchProfileQuestion(text) {
  const normalized = (text || '').toLowerCase().replace(/\\s+/g, ' ').trim();
  if (!normalized) return false;

  // These are ordinary profile/setup questions whose answers normally just move
  // the funnel forward. Branch probing is harmful on stateful SPAs because the
  // exact question may not be restorable after the first answer.
  const profilePatterns = [
    /\\bphysical build\\b/,
    /\\bbody (?:type|shape|build)\\b/,
    /\\bhow would you describe your (?:body|build|physique)\\b/,
    /\\b(?:your )?(?:height|weight|age|gender|sex)\\b/,
    /\\bhow (?:tall|old) are you\\b/,
    /\\bwhat is your (?:height|weight|age|gender)\\b/
  ];
  return profilePatterns.some(pattern => pattern.test(normalized));
}

function isSpeechInputScreen(text) {
"""
if anchor not in s:
    raise SystemExit('speech anchor not found')
s = s.replace(anchor, helper, 1)

old = """  async function exploreAnswerBranches(state, screenNumber) {
    const instruction = getSelectionInstruction(state.pageText);
    if (isNativeLanguageQuestion(state.pageText)) return false;
"""
new = """  async function exploreAnswerBranches(state, screenNumber) {
    const instruction = getSelectionInstruction(state.pageText);
    if (isNativeLanguageQuestion(state.pageText)) return false;
    if (isNonBranchProfileQuestion(state.pageText)) {
      console.log('Simple profile/setup question detected. Skipping branch exploration and taking a normal answer path.');
      return false;
    }
"""
if old not in s:
    raise SystemExit('exploreAnswerBranches anchor not found')
s = s.replace(old, new, 1)

p.write_text(s)
