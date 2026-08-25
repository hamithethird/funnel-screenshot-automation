from pathlib import Path
import re

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()

# Add helper after contextSimilarity.
marker = "function contextSimilarity(a, b) {"
idx = s.find(marker)
if idx == -1:
    raise SystemExit('contextSimilarity not found')
# find end of function by locating next top-level function after it
m = re.search(r"function contextSimilarity\(a, b\) \{.*?\n\}\n\n", s[idx:], re.S)
if not m:
    raise SystemExit('contextSimilarity function end not found')
insert_at = idx + m.end()
helper = r'''function questionPromptFingerprint(state) {
  if (!state) return '';
  const optionTexts = (state.group || []).map(x => x.text || '').filter(Boolean);
  return normalizeContextText(state.pageText || '', optionTexts);
}

'''
s = s[:insert_at] + helper + s[insert_at:]

# Replace restoreQuestionPage with prompt-aware version.
pattern = re.compile(r"  async function restoreQuestionPage\(questionUrl, expectedOptions\) \{.*?\n  async function chooseBranchOptionAndAdvance", re.S)
replacement = r'''  async function restoreQuestionPage(questionUrl, expectedOptions, expectedQuestionFingerprint = '') {
    const expected = expectedOptions.map(x => (x || '').trim().toLowerCase()).filter(Boolean);
    const matchesQuestion = state => {
      if (!state || state.group.length < 2) return false;
      const current = state.group.map(x => (x.text || '').trim().toLowerCase());
      const overlap = expected.filter(text => current.includes(text)).length;
      const optionsMatch = overlap >= Math.min(2, expected.length);
      if (!optionsMatch) return false;

      if (!expectedQuestionFingerprint) return true;
      const currentPrompt = questionPromptFingerprint(state);
      if (!currentPrompt) return false;
      return contextSimilarity(expectedQuestionFingerprint, currentPrompt) >= 0.86;
    };

    try {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 });
      await page.waitForTimeout(700);
      await silenceMedia();
      const state = await inspectPage();
      if (matchesQuestion(state)) return state;
    } catch {}

    try {
      await page.goto(questionUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(800);
      await silenceMedia();
      const state = await inspectPage();
      if (matchesQuestion(state)) return state;
    } catch {}

    return null;
  }

  async function chooseBranchOptionAndAdvance'''
s, n = pattern.subn(lambda m: replacement, s, count=1)
if n != 1:
    raise SystemExit(f'restoreQuestionPage replacement count {n}')

# Tighten same-question detection in chooseBranchOptionAndAdvance.
old = """      const originalOptions = (questionState?.group || state.group || []).map(x => (x.text || '').trim().toLowerCase()).filter(Boolean);\n      const currentOptions = (after.group || []).map(x => (x.text || '').trim().toLowerCase()).filter(Boolean);\n      const optionOverlap = originalOptions.filter(text => currentOptions.includes(text)).length;\n      const sameQuestionStillVisible = optionOverlap >= Math.max(1, Math.ceil(Math.min(originalOptions.length, currentOptions.length) * 0.5));\n      if (sameQuestionStillVisible && afterText && beforeText !== afterText) {\n"""
new = """      const originalOptions = (questionState?.group || state.group || []).map(x => (x.text || '').trim().toLowerCase()).filter(Boolean);\n      const currentOptions = (after.group || []).map(x => (x.text || '').trim().toLowerCase()).filter(Boolean);\n      const optionOverlap = originalOptions.filter(text => currentOptions.includes(text)).length;\n      const optionsStillMatch = optionOverlap >= Math.max(1, Math.ceil(Math.min(originalOptions.length, currentOptions.length) * 0.5));\n      const originalPrompt = questionPromptFingerprint(questionState || state);\n      const currentPrompt = questionPromptFingerprint(after);\n      const promptStillMatches = !!originalPrompt && !!currentPrompt && contextSimilarity(originalPrompt, currentPrompt) >= 0.86;\n      const sameQuestionStillVisible = optionsStillMatch && promptStillMatches;\n      if (sameQuestionStillVisible && afterText && beforeText !== afterText) {\n"""
if old not in s:
    raise SystemExit('same-question block not found')
s = s.replace(old, new, 1)

# In exploreAnswerBranches, create checkpoint and pass to every restoreQuestionPage call.
old = """    const questionUrl = page.url();\n    const questionState = state;\n    const outcomes = [];\n"""
new = """    const questionUrl = page.url();\n    const questionState = state;\n    const questionFingerprint = questionPromptFingerprint(questionState);\n    const outcomes = [];\n"""
if old not in s:
    raise SystemExit('question state block not found')
s = s.replace(old, new, 1)

# Replace restore calls only inside branch explorer section.
start = s.find('  async function exploreAnswerBranches(state, screenNumber) {')
end = s.find('  async function advanceOneScreen(state, screenNumber = null) {', start)
if start == -1 or end == -1:
    raise SystemExit('branch explorer bounds not found')
section = s[start:end]
section = section.replace('restoreQuestionPage(questionUrl, optionTexts)', 'restoreQuestionPage(questionUrl, optionTexts, questionFingerprint)')
s = s[:start] + section + s[end:]

p.write_text(s)
