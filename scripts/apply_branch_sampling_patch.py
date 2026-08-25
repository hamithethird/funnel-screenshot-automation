from pathlib import Path
import re

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()

# Add one-run marker after supplemental maps.
needle = """  const supplementalCounterByScreen = new Map();\n  const supplementalFingerprintsByScreen = new Map();\n"""
replacement = needle + """  let skipNextNumberedFingerprint = null;\n"""
if needle not in s:
    raise SystemExit('Could not find supplemental maps')
s = s.replace(needle, replacement, 1)

# Tighten post-selection supplemental capture: only capture when the original answer group still exists.
old = """    if (sanitizeUrl(page.url()) === sanitizeUrl(questionUrl) && after.group.length > 0) {\n      const beforeText = normalizeContextText(questionState?.pageText || state.pageText, [optionText]);\n      const afterText = normalizeContextText(after.pageText, [optionText]);\n      if (afterText && beforeText !== afterText) {\n        await captureSupplementalState(\n          screenNumber,\n          after,\n          `post-selection response for \"${optionText}\"`,\n          [optionText],\n          0.95\n        );\n      }\n"""
new = """    if (sanitizeUrl(page.url()) === sanitizeUrl(questionUrl) && after.group.length > 0) {\n      const beforeText = normalizeContextText(questionState?.pageText || state.pageText, [optionText]);\n      const afterText = normalizeContextText(after.pageText, [optionText]);\n      const originalOptions = (questionState?.group || state.group || []).map(x => (x.text || '').trim().toLowerCase()).filter(Boolean);\n      const currentOptions = (after.group || []).map(x => (x.text || '').trim().toLowerCase()).filter(Boolean);\n      const optionOverlap = originalOptions.filter(text => currentOptions.includes(text)).length;\n      const sameQuestionStillVisible = optionOverlap >= Math.max(1, Math.ceil(Math.min(originalOptions.length, currentOptions.length) * 0.5));\n      if (sameQuestionStillVisible && afterText && beforeText !== afterText) {\n        await captureSupplementalState(\n          screenNumber,\n          after,\n          `post-selection response for \"${optionText}\"`,\n          [optionText],\n          0.95\n        );\n      }\n"""
if old not in s:
    raise SystemExit('Could not find post-selection supplemental block')
s = s.replace(old, new, 1)

# Remove duplicate advancePastCapturedTransition definition if present twice consecutively.
pattern_dup = re.compile(r"(  async function advancePastCapturedTransition\(state\) \{.*?\n  \}\n)\n\1", re.S)
s = pattern_dup.sub(r"\1", s, count=1)

# Replace branch explorer with sampled detection + full exploration only when branching is confirmed.
pattern = re.compile(r"  async function exploreAnswerBranches\(state, screenNumber\) \{.*?\n  async function advanceOneScreen\(state, screenNumber = null\) \{", re.S)
replacement_branch = r'''  function branchProbeIndexes(optionCount, maxProbe = 4) {
    if (optionCount <= maxProbe) return Array.from({ length: optionCount }, (_, i) => i);
    const raw = [0, optionCount - 1, Math.round((optionCount - 1) / 3), Math.round(((optionCount - 1) * 2) / 3)];
    const unique = [];
    for (const index of raw) if (!unique.includes(index)) unique.push(index);
    return unique.slice(0, maxProbe);
  }

  async function exploreAnswerBranches(state, screenNumber) {
    const instruction = getSelectionInstruction(state.pageText);
    if (isNativeLanguageQuestion(state.pageText)) return false;
    if (isSpeechInputScreen(state.pageText) || hasSkipEscapeChoice(state)) {
      console.log('Skip/optional-input screen detected. Bypassing branch exploration so the escape action can be used.');
      return false;
    }
    if (await answerGroupIsInsideActiveModal(state)) {
      console.log('Answer group is inside an active modal/dialog. Treating it as a normal required choice, not a branch point.');
      return false;
    }
    if (state.group.length < 2 || state.group.length > 10) return false;
    if (instruction.minSelections !== 1 || instruction.maxSelections !== 1) return false;

    const optionTexts = state.group.map(x => (x.text || '').trim()).filter(Boolean);
    if (optionTexts.length < 2) return false;

    const questionUrl = page.url();
    const questionState = state;
    const outcomes = [];
    const probedIndexes = branchProbeIndexes(optionTexts.length, 4);
    console.log(`Probing up to ${probedIndexes.length} strategically spread answers to determine whether this question has conditional next pages.`);

    const recordOutcomeForIndex = async (index) => {
      if (outcomes.length > 0) {
        const restored = await restoreQuestionPage(questionUrl, optionTexts);
        if (!restored) return { ok: false, reason: 'restore-failed' };
      }
      const result = await chooseBranchOptionAndAdvance(optionTexts[index], screenNumber, questionState);
      if (!result.advanced || !result.landingState) return { ok: false, reason: 'advance-failed' };
      await waitForScreenshotReady({ minimumWaitMs: 2200, maxWaitMs: 5800 });
      const landingState = await inspectPage();
      const fingerprint = normalizeContextText(landingState.pageText);
      if (!fingerprint) return { ok: false, reason: 'no-fingerprint' };
      const screenshotBuffer = await page.screenshot({ fullPage: true });
      outcomes.push({ index, optionText: optionTexts[index], fingerprint, screenshotBuffer, landingState });
      console.log(`Recorded immediate next-page outcome for "${optionTexts[index]}".`);
      return { ok: true };
    };

    for (const index of probedIndexes) {
      const recorded = await recordOutcomeForIndex(index);
      if (!recorded.ok) {
        console.log('Could not safely compare branch outcome:', recorded.reason);
        await restoreQuestionPage(questionUrl, optionTexts);
        return false;
      }
    }

    const probeFingerprints = new Set(outcomes.map(x => x.fingerprint));
    if (probeFingerprints.size <= 1) {
      console.log(`Branch probe result: all ${outcomes.length} tested answers lead to the same immediate next page. No conditional branch detected.`);
      const restored = await restoreQuestionPage(questionUrl, optionTexts);
      if (!restored) return false;
      const finalResult = await chooseBranchOptionAndAdvance(optionTexts[0], screenNumber, questionState);
      return finalResult.advanced;
    }

    console.log(`Conditional branching confirmed: ${probeFingerprints.size} different immediate next pages found in the probe.`);
    console.log('Branching is confirmed, so the crawler will now test the remaining answers to collect all unique transition pages.');

    const alreadyTested = new Set(outcomes.map(x => x.index));
    for (let index = 0; index < optionTexts.length; index++) {
      if (alreadyTested.has(index)) continue;
      const recorded = await recordOutcomeForIndex(index);
      if (!recorded.ok) {
        console.log(`Could not safely test remaining branch answer "${optionTexts[index]}". Continuing with collected outcomes.`);
        break;
      }
    }

    const uniqueOutcomes = [];
    for (const outcome of outcomes) {
      let existing = uniqueOutcomes.find(item => item.fingerprint === outcome.fingerprint);
      if (!existing) {
        existing = { ...outcome, answers: [outcome.optionText] };
        uniqueOutcomes.push(existing);
      } else {
        existing.answers.push(outcome.optionText);
      }
    }

    if (uniqueOutcomes.length <= 1) {
      console.log('After full comparison, all answers collapsed to one unique next page. No conditional screenshots will be created.');
      const restored = await restoreQuestionPage(questionUrl, optionTexts);
      if (!restored) return false;
      const finalResult = await chooseBranchOptionAndAdvance(optionTexts[0], screenNumber, questionState);
      return finalResult.advanced;
    }

    console.log(`Saving ${uniqueOutcomes.length} unique conditional next pages as lettered screenshots.`);
    for (let i = 0; i < uniqueOutcomes.length; i++) {
      const filename = path.join(OUTPUT_DIR, `${String(screenNumber).padStart(2, '0')}${branchLetter(i)}.png`);
      fs.writeFileSync(filename, uniqueOutcomes[i].screenshotBuffer);
      console.log(`Captured ${path.basename(filename)} for answer(s): ${uniqueOutcomes[i].answers.join(' | ')}`);
    }

    const restored = await restoreQuestionPage(questionUrl, optionTexts);
    if (!restored) {
      console.log('Conditional pages were captured, but the main question could not be restored safely.');
      return false;
    }

    const finalResult = await chooseBranchOptionAndAdvance(optionTexts[0], screenNumber, questionState);
    if (!finalResult.advanced || !finalResult.landingState) return false;
    const mainFingerprint = normalizeContextText(finalResult.landingState.pageText);
    if (uniqueOutcomes.some(item => item.fingerprint === mainFingerprint)) {
      skipNextNumberedFingerprint = mainFingerprint;
      console.log('Main path is currently on a transition already captured as a lettered screenshot; the next numbered capture will skip over it.');
    }
    return true;
  }

  async function advanceOneScreen(state, screenNumber = null) {'''
s, n = pattern.subn(lambda m: replacement_branch, s, count=1)
if n != 1:
    raise SystemExit(f'Expected one branch explorer replacement, got {n}')

# At start of main loop, skip a transition that was already captured as a lettered branch.
needle_loop = """    const state = await inspectPage();\n    const paywallState = await inspectPaywallState();\n    const filename = path.join(OUTPUT_DIR, `${String(screenNumber).padStart(2, '0')}.png`);\n"""
replacement_loop = """    let state = await inspectPage();\n\n    if (skipNextNumberedFingerprint) {\n      const currentFingerprint = normalizeContextText(state.pageText);\n      if (currentFingerprint === skipNextNumberedFingerprint) {\n        console.log('Current page was already captured as a conditional lettered screenshot. Advancing before assigning the next numbered screenshot.');\n        const advancedPast = await advancePastCapturedTransition(state);\n        skipNextNumberedFingerprint = null;\n        if (!advancedPast) {\n          console.log('Could not safely advance past the already-captured transition. Stopping to avoid a duplicate numbered screenshot.');\n          break;\n        }\n        await waitForVisualSettle();\n        state = await inspectPage();\n      } else {\n        skipNextNumberedFingerprint = null;\n      }\n    }\n\n    const paywallState = await inspectPaywallState();\n    const filename = path.join(OUTPUT_DIR, `${String(screenNumber).padStart(2, '0')}.png`);\n"""
if needle_loop not in s:
    raise SystemExit('Could not find main loop state block')
s = s.replace(needle_loop, replacement_loop, 1)

p.write_text(s)
