from pathlib import Path

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()

old = '''    const testedIndexes = new Set(outcomes.map(x => x.index));
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

new = '''    let testedIndexes = new Set(outcomes.map(x => x.index));
    let unresolvedIndexes = probedIndexes.filter(index => !testedIndexes.has(index));

    // IMPORTANT: the crawler's goal is to find ALL unique funnel pages. A 4-answer
    // probe is only an optimization for finding evidence of branching quickly; it
    // must never be treated as proof that untested answers are identical. If the
    // initial probe found only one outcome and the question has additional answers,
    // test those remaining answers before declaring "no conditional branch".
    const untestedIndexes = [];
    for (let index = 0; index < optionTexts.length; index++) {
      if (!testedIndexes.has(index)) untestedIndexes.push(index);
    }

    if (probeFingerprints.size <= 1 && untestedIndexes.length > 0) {
      console.log(`Initial branch probe found one outcome, but ${untestedIndexes.length} answer(s) remain untested. Testing them before ruling out conditional transitions.`);
      for (const index of untestedIndexes) {
        const recorded = await recordOutcomeForIndex(index);
        if (!recorded.ok) {
          console.log(`Could not safely test unprobed branch answer "${optionTexts[index]}". Leaving this answer unresolved instead of assuming it matches.`);
          continue;
        }
        testedIndexes.add(index);
      }
      probeFingerprints = new Set(outcomes.map(x => x.fingerprint));
      unresolvedIndexes = Array.from({ length: optionTexts.length }, (_, i) => i).filter(index => !testedIndexes.has(index));
    }

    if (probeFingerprints.size <= 1 && unresolvedIndexes.length === 0) {
      console.log(`Branch comparison result: all ${outcomes.length} answers lead to the same immediate next page. No conditional branch detected.`);
      const restored = await restoreQuestionPage(questionUrl, optionTexts, questionFingerprint);
      if (!restored) return false;
      const finalResult = await chooseBranchOptionAndAdvance(optionTexts[0], screenNumber, questionState);
      return finalResult.advanced;
    }

    if (probeFingerprints.size <= 1 && unresolvedIndexes.length > 0) {
      console.log('No different transition was proven, but at least one answer remains unresolved. The crawler will not claim that all answers are identical. Continuing on the normal path without conditional screenshots.');
      const restored = await restoreQuestionPage(questionUrl, optionTexts, questionFingerprint);
      if (!restored) return false;
      const finalResult = await chooseBranchOptionAndAdvance(optionTexts[0], screenNumber, questionState);
      return finalResult.advanced;
    }

    console.log(`Conditional branching confirmed: ${probeFingerprints.size} different immediate next pages found.`);
    console.log('Branching is confirmed, so the crawler will now test every remaining unresolved answer to collect all unique transition pages.');

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
    raise SystemExit('target branch decision block not found')

s = s.replace(old, new, 1)
p.write_text(s)
