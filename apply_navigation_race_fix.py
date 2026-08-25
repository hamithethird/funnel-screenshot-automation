from pathlib import Path

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()

anchor = '''  async function restoreQuestionPage(questionUrl, expectedOptions, expectedQuestionFingerprint = '') {'''
helper = '''  async function inspectPageNavigationSafe(label = 'page inspection', attempts = 4) {
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await inspectPage();
      } catch (error) {
        lastError = error;
        const message = String(error?.message || error || '');
        const navigationRace = /execution context was destroyed|cannot find context|most likely because of a navigation|frame was detached|target page, context or browser has been closed/i.test(message);
        if (!navigationRace || attempt === attempts) throw error;
        console.log(`Navigation was still settling during ${label}. Waiting before retry ${attempt + 1}/${attempts}.`);
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(350 * attempt);
      }
    }
    throw lastError;
  }

  async function restoreQuestionPage(questionUrl, expectedOptions, expectedQuestionFingerprint = '') {'''
if anchor not in s:
    raise SystemExit('restore anchor not found')
s = s.replace(anchor, helper, 1)

s = s.replace('''      const state = await inspectPage();
      return matchesQuestion(state) ? state : null;
''', '''      const state = await inspectPageNavigationSafe('branch restore verification');
      return matchesQuestion(state) ? state : null;
''', 1)

s = s.replace('''    const currentState = await inspectPage().catch(() => null);
''', '''    const currentState = await inspectPageNavigationSafe('branch restore pre-check').catch(() => null);
''', 1)

old = '''        if (clicked) {
          const matched = await inspectAndMatch(900);
          if (matched) return matched;
        }
'''
new = '''        if (clicked) {
          // The funnel Back control may trigger a real document navigation. Wait for
          // that navigation to settle before any DOM inspection is attempted.
          await page.waitForLoadState('domcontentloaded', { timeout: 6000 }).catch(() => {});
          await page.waitForTimeout(450);
          const matched = await inspectAndMatch(500);
          if (matched) return matched;
        }
'''
if old not in s:
    raise SystemExit('back click block not found')
s = s.replace(old, new, 1)

# Limit the remaining replacements to the branch-click function, so ordinary crawler
# behavior is unchanged.
start = s.index('  async function chooseBranchOptionAndAdvance(')
end = s.index('  async function answerGroupIsInsideActiveModal(', start)
branch = s[start:end]
branch = branch.replace('await inspectPage()', "await inspectPageNavigationSafe('branch answer inspection')")
s = s[:start] + branch + s[end:]

p.write_text(s)
