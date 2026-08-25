from pathlib import Path

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()

anchor = '''  async function advanceOneScreen(state, screenNumber = null) {'''
helper = r'''  async function handlePassiveEvaluationGate(state) {
    // Some evaluation/loading screens pause their automatic progress to ask a
    // lightweight Yes/No-style question. This is not a branch question: the
    // answer only unlocks/resumes the same passive evaluation sequence.
    if (!state || state.group.length < 2 || !isPassiveTransitionScreen(state.pageText)) {
      return { handled: false, advanced: false };
    }

    const instruction = getSelectionInstruction(state.pageText);
    if ((instruction.minSelections || 1) !== 1 || (instruction.maxSelections !== null && instruction.maxSelections !== 1)) {
      return { handled: false, advanced: false };
    }

    const optionTexts = state.group.map(item => (item.text || '').trim()).filter(Boolean);
    const shortChoiceGate = optionTexts.length <= 4 && optionTexts.every(text => text.length <= 80);
    if (!shortChoiceGate) return { handled: false, advanced: false };

    console.log('Passive evaluation gate detected. Selecting one answer to resume the evaluation; branch exploration is intentionally skipped.');
    const beforeSignature = pageSignature(state);
    const beforeUrl = sanitizeUrl(page.url());
    const option = state.group[0];
    const clicked = await safeCrawlerClick(
      page.locator(`[data-auto-id="${option.id}"]`),
      option.text || 'passive evaluation answer'
    );
    if (!clicked) return { handled: true, advanced: false };

    // The answer may only remove the question while the progress animation keeps
    // running. Wait for the evaluation itself to finish instead of treating each
    // percentage/progress update as a new numbered page.
    const startedAt = Date.now();
    const timeoutMs = 60000;
    let sawMeaningfulChange = false;
    while (Date.now() - startedAt < timeoutMs) {
      await page.waitForTimeout(500);
      await silenceMedia();
      const current = await inspectPageNavigationSafe('passive evaluation gate');
      const currentSignature = pageSignature(current);
      const urlChanged = sanitizeUrl(page.url()) !== beforeUrl;
      if (currentSignature !== beforeSignature) sawMeaningfulChange = true;

      if (urlChanged || !isPassiveTransitionScreen(current.pageText)) {
        console.log('Passive evaluation resumed and completed. Continuing to the resulting page.');
        return { handled: true, advanced: true };
      }

      // If the evaluation exposes a real navigation CTA after processing, use it.
      if (current.cta && isStrongNavigationText(current.cta.text || '')) {
        const navBefore = pageSignature(current);
        const navClicked = await safeCrawlerClick(
          page.locator(`[data-auto-id="${current.cta.id}"]`),
          current.cta.text || 'post-evaluation CTA'
        );
        if (navClicked && await waitForAdvancement(navBefore, 12000)) {
          return { handled: true, advanced: true };
        }
      }
    }

    if (sawMeaningfulChange) {
      console.log('Passive evaluation changed after the answer but did not fully finish within 60s; continuing from the latest state.');
      return { handled: true, advanced: true };
    }
    console.log('Passive evaluation answer was selected, but the evaluation did not resume within 60s.');
    return { handled: true, advanced: false };
  }

  async function advanceOneScreen(state, screenNumber = null) {'''
if anchor not in s:
    raise SystemExit('advanceOneScreen anchor not found')
s = s.replace(anchor, helper, 1)

old = '''    const beforeSignature = pageSignature(state);
    let acted = false;
    if (state.group.length >= 2 && !isSpeechInputScreen(state.pageText) && !hasSkipEscapeChoice(state)) {
      acted = await exploreAnswerBranches(state, screenNumber);
    } else if (state.group.length >= 2 && isSpeechInputScreen(state.pageText)) {
      console.log('Branch exploration skipped because this page genuinely requests spoken/audio input.');
    }
'''
new = '''    const beforeSignature = pageSignature(state);
    let acted = false;

    // Evaluation/loading screens can contain a small answer gate (for example
    // Yes/No reminders) that merely resumes the ongoing calculation. Never run
    // branch exploration on those controls.
    const passiveGate = await handlePassiveEvaluationGate(state);
    if (passiveGate.handled) {
      acted = passiveGate.advanced;
    } else if (state.group.length >= 2 && !isSpeechInputScreen(state.pageText) && !hasSkipEscapeChoice(state)) {
      acted = await exploreAnswerBranches(state, screenNumber);
    } else if (state.group.length >= 2 && isSpeechInputScreen(state.pageText)) {
      console.log('Branch exploration skipped because this page genuinely requests spoken/audio input.');
    }
'''
if old not in s:
    raise SystemExit('main branch dispatch block not found')
s = s.replace(old, new, 1)

p.write_text(s)
