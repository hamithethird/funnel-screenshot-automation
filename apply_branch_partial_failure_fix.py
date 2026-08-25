from pathlib import Path

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()

old = '''    for (const index of probedIndexes) {
      const recorded = await recordOutcomeForIndex(index);
      if (!recorded.ok) {
        console.log('Could not safely compare branch outcome:', recorded.reason);
        await restoreQuestionPage(questionUrl, optionTexts, questionFingerprint);
        return false;
      }
    }

    const probeFingerprints = new Set(outcomes.map(x => x.fingerprint));
    if (probeFingerprints.size <= 1) {
      console.log(`Branch probe result: all ${outcomes.length} tested answers lead to the same immediate next page. No conditional branch detected.`);
      const restored = await restoreQuestionPage(questionUrl, optionTexts, questionFingerprint);
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
'''

new = '''    const failedProbeIndexes = [];
    for (const index of probedIndexes) {
      const recorded = await recordOutcomeForIndex(index);
      if (!recorded.ok) {
        failedProbeIndexes.push(index);
        console.log(`Could not safely compare branch outcome for "${optionTexts[index]}": ${recorded.reason}. Keeping the successful outcomes and continuing.`);
      }
    }

    // If fewer than two answers could be tested, do not hand a half-restored page
    // back to the generic answer handler. Restore the original question and take
    // the normal first-answer path here, inside the branch system.
    if (outcomes.length < 2) {
      console.log('Too few branch outcomes were successfully tested. Restoring the question and continuing on the normal first-answer path.');
      const restored = await restoreQuestionPage(questionUrl, optionTexts, questionFingerprint);
      if (!restored) return false;
      const finalResult = await chooseBranchOptionAndAdvance(optionTexts[0], screenNumber, questionState);
      return finalResult.advanced;
    }

    let probeFingerprints = new Set(outcomes.map(x => x.fingerprint));

    // A failed probe is unresolved evidence, not proof that there is no branch.
    // Retry only the failed answer(s), after the successful first attempts have
    // already been preserved. This does NOT restore before the first probe.
    if (failedProbeIndexes.length > 0) {
      for (const index of failedProbeIndexes) {
        console.log(`Retrying unresolved branch answer "${optionTexts[index]}" once from the restored question.`);
        const recorded = await recordOutcomeForIndex(index);
        if (!recorded.ok) {
          console.log(`Branch answer "${optionTexts[index]}" is still unresolved after retry. It will be skipped without aborting the crawl.`);
        }
      }
      probeFingerprints = new Set(outcomes.map(x => x.fingerprint));
    }

    const testedIndexes = new Set(outcomes.map(x => x.index));
    const unresolvedIndexes = probedIndexes.filter(index => !testedIndexes.has(index));

    if (probeFingerprints.size <= 1 && unresolvedIndexes.length === 0) {
      console.log(`Branch probe result: all ${outcomes.length} successfully tested answers lead to the same immediate next page. No conditional branch detected.`);
      const restored = await restoreQuestionPage(questionUrl, optionTexts, questionFingerprint);
      if (!restored) return false;
      const finalResult = await chooseBranchOptionAndAdvance(optionTexts[0], screenNumber, questionState);
      return finalResult.advanced;
    }

    if (probeFingerprints.size <= 1 && unresolvedIndexes.length > 0) {
      console.log('No different transition was proven, but at least one probe remained unresolved. Continuing on the normal path without creating conditional screenshots.');
      const restored = await restoreQuestionPage(questionUrl, optionTexts, questionFingerprint);
      if (!restored) return false;
      const finalResult = await chooseBranchOptionAndAdvance(optionTexts[0], screenNumber, questionState);
      return finalResult.advanced;
    }

    console.log(`Conditional branching confirmed: ${probeFingerprints.size} different immediate next pages found in the successful probes.`);
    console.log('Branching is confirmed, so the crawler will now test the remaining answers to collect all unique transition pages.');

    const alreadyTested = new Set(outcomes.map(x => x.index));
    for (let index = 0; index < optionTexts.length; index++) {
      if (alreadyTested.has(index)) continue;
      const recorded = await recordOutcomeForIndex(index);
      if (!recorded.ok) {
        console.log(`Could not safely test remaining branch answer "${optionTexts[index]}". Skipping only this answer and continuing with the collected outcomes.`);
        continue;
      }
      alreadyTested.add(index);
    }
'''

if old not in s:
    raise SystemExit('branch probe block not found')
s = s.replace(old, new, 1)

# Give the page a little longer to settle after an answer click before declaring
# that the branch did not advance. This is intentionally limited to branch clicks.
old2 = '''    await page.waitForTimeout(700);
    let after = await inspectPage();

    if (sanitizeUrl(page.url()) === sanitizeUrl(questionUrl) && after.group.length > 0) {
'''
new2 = '''    await page.waitForTimeout(700);
    let after = await inspectPage();

    // Some funnels update the next screen asynchronously after the answer click.
    // Poll briefly before treating a still-identical screen as an advance failure.
    if (pageSignature(after) === before) {
      const waitStarted = Date.now();
      while (Date.now() - waitStarted < 3500 && pageSignature(after) === before) {
        await page.waitForTimeout(350);
        after = await inspectPage();
      }
    }

    if (sanitizeUrl(page.url()) === sanitizeUrl(questionUrl) && after.group.length > 0) {
'''
if old2 not in s:
    raise SystemExit('branch click settle block not found')
s = s.replace(old2, new2, 1)

p.write_text(s)
