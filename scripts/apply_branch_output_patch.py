from pathlib import Path
import re

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()

# Add filesystem/path imports.
s = s.replace("const { chromium } = require('playwright');\n", "const { chromium } = require('playwright');\nconst fs = require('fs');\nconst path = require('path');\n", 1)

# Insert run-folder helpers after URL validation.
needle = """  const browser = await chromium.launch();\n  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });\n  await page.goto(url, { waitUntil: 'networkidle' });\n"""
replacement = """  function deriveFunnelName(rawUrl) {\n    try {\n      const hostname = new URL(rawUrl).hostname.toLowerCase().replace(/^www\\./, '');\n      const labels = hostname.split('.').filter(Boolean);\n      const base = labels.length >= 2 ? labels[labels.length - 2] : labels[0] || 'funnel';\n      return base.replace(/^get(?=[a-z])/, '').replace(/[^a-z0-9]+/g, ' ').trim() || 'funnel';\n    } catch {\n      return 'funnel';\n    }\n  }\n\n  function createRunOutputDirectory(rawUrl) {\n    const funnelName = deriveFunnelName(rawUrl);\n    let version = 1;\n    let dir;\n    do {\n      dir = path.resolve(process.cwd(), `${funnelName} funnel v${version}`);\n      version += 1;\n    } while (fs.existsSync(dir));\n    fs.mkdirSync(dir, { recursive: true });\n    return dir;\n  }\n\n  const OUTPUT_DIR = createRunOutputDirectory(url);\n  console.log('Saving screenshots to:', OUTPUT_DIR);\n\n  const browser = await chromium.launch();\n  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });\n  await page.goto(url, { waitUntil: 'networkidle' });\n"""
if needle not in s:
    raise SystemExit('Could not find browser setup block')
s = s.replace(needle, replacement, 1)

# Route supplemental filenames into run folder.
old = """  function nextSupplementalFilename(screenNumber) {\n    const current = supplementalCounterByScreen.get(screenNumber) || 0;\n    supplementalCounterByScreen.set(screenNumber, current + 1);\n    return `${String(screenNumber).padStart(2, '0')}${branchLetter(current)}.png`;\n  }\n"""
new = """  function nextSupplementalFilename(screenNumber) {\n    const current = supplementalCounterByScreen.get(screenNumber) || 0;\n    supplementalCounterByScreen.set(screenNumber, current + 1);\n    return path.join(OUTPUT_DIR, `${String(screenNumber).padStart(2, '0')}${branchLetter(current)}.png`);\n  }\n"""
if old not in s:
    raise SystemExit('Could not find supplemental filename function')
s = s.replace(old, new, 1)

# Replace transition classifier with question-aware version.
pattern = re.compile(r"  async function isLikelyBranchTransition\(state\) \{.*?\n  async function restoreQuestionPage", re.S)
new_classifier = r'''  async function isLikelyBranchTransition(state, questionState = null) {
    if (!state) return false;
    if (isNativeLanguageQuestion(state.pageText)) return false;
    if (await hasVisibleEditableInput()) return false;

    const normalized = (state.pageText || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const questionish = /\b(select all that apply|choose all that apply|select one|choose one|pick one|choose\s+\d+|select\s+\d+|pick\s+\d+|which|what(?:'s| is| are| do| would)|how (?:often|do|would|well|much)|tell us|tell me)\b/i.test(normalized);
    const hasMultipleAnswerLikeChoices = state.group.length >= 2 && questionish;
    if (hasMultipleAnswerLikeChoices) return false;

    if (questionState) {
      const before = normalizeContextText(questionState.pageText || '');
      const after = normalizeContextText(state.pageText || '');
      if (before && after && contextSimilarity(before, after) >= 0.92) return false;
    }

    // Informational/conditional screens may contain cards or a Continue CTA that
    // superficially look interactive. If the page no longer reads like a question,
    // treat it as a transition candidate even when a weak answer group was inferred.
    return true;
  }

  async function restoreQuestionPage'''
s, n = pattern.subn(lambda m: new_classifier, s, count=1)
if n != 1:
    raise SystemExit(f'Expected one transition classifier replacement, got {n}')

# Add modal answer-group detector before exploreAnswerBranches.
marker = "  async function exploreAnswerBranches(state, screenNumber) {"
modal_helper = r'''  async function answerGroupIsInsideActiveModal(state) {
    if (!state?.group?.length) return false;
    return await page.evaluate((ids) => {
      const dialogSelector = '[role="dialog"], [aria-modal="true"], [class*="modal" i], [class*="popup" i], [class*="overlay" i], [class*="sheet" i]';
      const visible = el => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 &&
          r.top < window.innerHeight && r.left < window.innerWidth &&
          s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0;
      };
      let inside = 0;
      for (const id of ids) {
        const el = document.querySelector(`[data-auto-id="${CSS.escape(id)}"]`);
        if (el && el.closest(dialogSelector) && visible(el.closest(dialogSelector))) inside++;
      }
      return inside >= Math.ceil(ids.length * 0.6);
    }, state.group.map(x => x.id)).catch(() => false);
  }

  async function exploreAnswerBranches(state, screenNumber) {'''
if marker not in s:
    raise SystemExit('Could not find branch explorer marker')
s = s.replace(marker, modal_helper, 1)

# Bypass branch exploration for modal clarification/choice overlays.
needle2 = """    if (isSpeechInputScreen(state.pageText) || hasSkipEscapeChoice(state)) {\n      console.log('Skip/optional-input screen detected. Bypassing branch exploration so the escape action can be used.');\n      return false;\n    }\n"""
replacement2 = needle2 + """    if (await answerGroupIsInsideActiveModal(state)) {\n      console.log('Answer group is inside an active modal/dialog. Treating it as a normal required choice, not a branch point.');\n      return false;\n    }\n"""
if needle2 not in s:
    raise SystemExit('Could not find branch skip block')
s = s.replace(needle2, replacement2, 1)

# Pass question state into transition checks.
s = s.replace("const looksLikeTransition = await isLikelyBranchTransition(landingState);", "const looksLikeTransition = await isLikelyBranchTransition(landingState, questionState);", 1)
s = s.replace("if (!(await isLikelyBranchTransition(landingState))) {", "if (!(await isLikelyBranchTransition(landingState, questionState))) {", 1)

# Replace branch screenshot loop so first branch becomes normal next screen, alternates get letters.
old_loop = """      await waitForScreenshotReady({ minimumWaitMs: 2400, maxWaitMs: 6000 });\n      landingState = await inspectPage();\n      const transitionFingerprint = normalizeContextText(landingState.pageText);\n      if (supplementalFingerprintSeenExact(screenNumber, transitionFingerprint)) {\n        console.log(`Transition for \"${optionTexts[i]}\" has exactly the same meaningful text as a transition already captured. Skipping duplicate screenshot.`);\n        continue;\n      }\n      const branchName = nextSupplementalFilename(screenNumber);\n      await page.screenshot({ path: branchName, fullPage: true });\n      console.log(`Captured unique branch transition for \"${optionTexts[i]}\": ${branchName}`);\n"""
new_loop = """      await waitForScreenshotReady({ minimumWaitMs: 2400, maxWaitMs: 6000 });\n      landingState = await inspectPage();\n      const transitionFingerprint = normalizeContextText(landingState.pageText);\n\n      // The first answer is the main path. Do not save it as 04a/05a here,\n      // because the normal crawler loop will capture that same landing page as\n      // the next numbered screenshot. We only register its fingerprint so\n      // alternate answers that lead to the same page are not saved as duplicates.\n      if (i === 0) {\n        supplementalFingerprintSeenExact(screenNumber, transitionFingerprint);\n        console.log(`Main-path transition for \"${optionTexts[i]}\" will be captured as the next numbered screen.`);\n        continue;\n      }\n\n      if (supplementalFingerprintSeenExact(screenNumber, transitionFingerprint)) {\n        console.log(`Transition for \"${optionTexts[i]}\" has the same meaningful text as a transition already seen. Skipping duplicate screenshot.`);\n        continue;\n      }\n      const branchName = nextSupplementalFilename(screenNumber);\n      await page.screenshot({ path: branchName, fullPage: true });\n      console.log(`Captured unique alternate branch transition for \"${optionTexts[i]}\": ${branchName}`);\n"""
if old_loop not in s:
    raise SystemExit('Could not find branch screenshot loop')
s = s.replace(old_loop, new_loop, 1)

# Route main numbered screenshots into output folder.
old_main = "const filename = `${String(screenNumber).padStart(2, '0')}.png`;"
new_main = "const filename = path.join(OUTPUT_DIR, `${String(screenNumber).padStart(2, '0')}.png`);"
if old_main not in s:
    raise SystemExit('Could not find main filename line')
s = s.replace(old_main, new_main, 1)

p.write_text(s)
