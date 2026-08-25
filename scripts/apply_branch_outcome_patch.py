from pathlib import Path
import re

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()

pattern = re.compile(r"  async function exploreAnswerBranches\(state, screenNumber\) \{.*?\n  async function advanceOneScreen\(state, screenNumber = null\) \{", re.S)
replacement = r'''  async function advancePastCapturedTransition(state) {
    if (!state) return false;

    const strong = await clickStrongNavigation(state, 'captured conditional transition CTA');
    if (strong.handled) return strong.advanced;

    const refreshed = await inspectPage();
    if (refreshed.cta) {
      const before = pageSignature(refreshed);
      const clicked = await safeCrawlerClick(
        page.locator(`[data-auto-id="${refreshed.cta.id}"]`),
        refreshed.cta.text || 'captured conditional transition CTA'
      );
      if (clicked && await waitForAdvancement(before, 12000)) return true;
    }

    const delayed = await waitForActionableState(12000);
    if (delayed?.changed) return true;
    return false;
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
    console.log(`Testing all ${optionTexts.length} answers before deciding whether this is a conditional branch.`);

    for (let i = 0; i < optionTexts.length; i++) {
      if (i > 0) {
        const restored = await restoreQuestionPage(questionUrl, optionTexts);
        if (!restored) {
          console.log('Could not safely restore the question while comparing answer outcomes. Aborting branch exploration.');
          await restoreQuestionPage(questionUrl, optionTexts);
          return false;
        }
      }

      const result = await chooseBranchOptionAndAdvance(optionTexts[i], screenNumber, questionState);
      if (!result.advanced || !result.landingState) {
        console.log('Answer did not produce a stable next page:', optionTexts[i]);
        await restoreQuestionPage(questionUrl, optionTexts);
        return false;
      }

      let landingState = result.landingState;
      const transitionLike = await isLikelyBranchTransition(landingState, questionState);
      if (!transitionLike) {
        console.log(`Answer "${optionTexts[i]}" leads directly to a normal interactive page. This question is not being treated as a conditional-transition branch.`);
        await restoreQuestionPage(questionUrl, optionTexts);
        return false;
      }

      await waitForScreenshotReady({ minimumWaitMs: 2400, maxWaitMs: 6000 });
      landingState = await inspectPage();
      const fingerprint = normalizeContextText(landingState.pageText);
      if (!fingerprint) {
        console.log('Could not build a meaningful transition fingerprint for:', optionTexts[i]);
        await restoreQuestionPage(questionUrl, optionTexts);
        return false;
      }

      const screenshotBuffer = await page.screenshot({ fullPage: true });
      outcomes.push({
        optionText: optionTexts[i],
        fingerprint,
        screenshotBuffer
      });
      console.log(`Recorded next-page outcome for "${optionTexts[i]}".`);
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

    console.log(`Branch comparison result: ${uniqueOutcomes.length} unique next-page outcome(s) across ${outcomes.length} answers.`);

    if (uniqueOutcomes.length <= 1) {
      console.log('All tested answers lead to the same transition page. No conditional transition branch exists here.');
      const restored = await restoreQuestionPage(questionUrl, optionTexts);
      if (!restored) return false;
      const finalResult = await chooseBranchOptionAndAdvance(optionTexts[0], screenNumber, questionState);
      return finalResult.advanced;
    }

    console.log('Different answers produce different transition pages. Saving each unique conditional transition as a lettered screenshot.');
    for (let i = 0; i < uniqueOutcomes.length; i++) {
      const filename = path.join(OUTPUT_DIR, `${String(screenNumber).padStart(2, '0')}${branchLetter(i)}.png`);
      fs.writeFileSync(filename, uniqueOutcomes[i].screenshotBuffer);
      console.log(`Captured conditional transition ${path.basename(filename)} for answer(s): ${uniqueOutcomes[i].answers.join(' | ')}`);
    }

    const restored = await restoreQuestionPage(questionUrl, optionTexts);
    if (!restored) {
      console.log('Conditional transitions were captured, but the main question could not be restored safely.');
      return false;
    }

    console.log('Conditional branch capture complete. Continuing the main path through the first answer.');
    const finalResult = await chooseBranchOptionAndAdvance(optionTexts[0], screenNumber, questionState);
    if (!finalResult.advanced || !finalResult.landingState) return false;

    const mainFingerprint = normalizeContextText(finalResult.landingState.pageText);
    const alreadyCaptured = uniqueOutcomes.some(item => item.fingerprint === mainFingerprint);
    if (alreadyCaptured) {
      const movedPastTransition = await advancePastCapturedTransition(finalResult.landingState);
      if (movedPastTransition) {
        console.log('Advanced past the already-captured conditional transition so the next numbered screenshot will not duplicate a lettered image.');
        return true;
      }
      console.log('Could not advance past the already-captured transition. Stopping branch handling to avoid intentionally duplicating it as the next numbered screenshot.');
      return false;
    }

    return true;
  }

  async function advanceOneScreen(state, screenNumber = null) {'''

s2, n = pattern.subn(lambda m: replacement, s, count=1)
if n != 1:
    raise SystemExit(f'Expected one branch explorer replacement, got {n}')

p.write_text(s2)
