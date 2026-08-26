from pathlib import Path

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()

# Keep only one representative same-page selection screenshot per numbered page.
if 'const samePageSelectionVariantCaptured = new Set();' not in s:
    marker = '  const samePageVariantHashes = new Map();\n'
    if marker not in s:
        raise SystemExit('samePageVariantHashes marker missing')
    s = s.replace(marker, marker + '  const samePageSelectionVariantCaptured = new Set();\n', 1)

start = s.find('  async function captureSamePageVisualVariant(screenNumber, reason) {')
end = s.find('  function answerOutcomeAffinity(', start)
if start < 0 or end < 0:
    raise SystemExit('captureSamePageVisualVariant block not found')
replacement = '''  async function captureSamePageVisualVariant(screenNumber, reason) {
    if (!screenNumber) return null;
    const key = String(screenNumber);
    if (samePageSelectionVariantCaptured.has(key)) {
      console.log(`Selection-state screenshot already captured for ${String(screenNumber).padStart(2, '0')}. Skipping additional selected/unselected visual variants.`);
      return null;
    }
    await page.waitForTimeout(500);
    const buffer = await screenshotBufferNavigationSafe('same-page visual state screenshot');
    const hash = hashScreenshot(buffer);
    const seen = samePageVariantHashes.get(key) || new Set();
    if (seen.has(hash)) return null;
    const filename = nextFreeLetteredFilename(screenNumber);
    if (!filename) return null;
    fs.writeFileSync(filename, buffer);
    seen.add(hash);
    samePageVariantHashes.set(key, seen);
    samePageSelectionVariantCaptured.add(key);
    console.log(`Captured ${path.basename(filename)} as the single representative selection-state screenshot${reason ? `: ${reason}` : '.'}`);
    return filename;
  }
'''
s = s[:start] + replacement + s[end:]

# Selection marks like a trailing check are UI state, not answer identity.
helper_anchor = '  function sameQuestionIgnoringSelectionVisuals(originalState, currentState) {\n'
helpers = '''  function canonicalAnswerText(text) {
    return (text || '')
      .toLowerCase()
      .replace(/[✓✔☑✅]/g, ' ')
      .replace(/\\b(?:selected|checked)\\b/g, ' ')
      .replace(/\\s+/g, ' ')
      .trim();
  }

  function answerTextLooksSelected(text) {
    return /[✓✔☑✅]/.test(text || '');
  }

  async function clearPersistedMultiSelectSelections(questionState) {
    // Some SPAs return to the same question but keep earlier answers checked.
    // Branch comparisons must be independent, so clear only controls with explicit
    // selected state before testing the next answer set.
    for (let pass = 0; pass < 12; pass++) {
      const currentState = await inspectPageNavigationSafe('multi-select selection reset').catch(() => null);
      if (!currentState || !sameQuestionIgnoringSelectionVisuals(questionState, currentState)) return false;
      const options = uniqueAnswerOptions(currentState.group || []);
      let selectedOption = null;
      for (const option of options) {
        const locator = page.locator(`[data-auto-id="${option.id}"]`);
        const domSelected = await locator.evaluate(el => {
          const truthy = value => ['true', 'checked', 'selected', 'on'].includes((value || '').toLowerCase());
          if (truthy(el.getAttribute('aria-checked')) || truthy(el.getAttribute('aria-selected')) || truthy(el.getAttribute('data-state'))) return true;
          if (el.matches('input:checked')) return true;
          if (el.querySelector('input:checked, [aria-checked="true"], [aria-selected="true"], [data-state="checked"], [data-state="selected"]')) return true;
          return false;
        }).catch(() => false);
        if (domSelected || answerTextLooksSelected(option.text || '')) {
          selectedOption = option;
          break;
        }
      }
      if (!selectedOption) {
        if (pass > 0) console.log('Cleared persisted multi-select selections before the next independent branch test.');
        return true;
      }
      const clicked = await safeCrawlerClick(
        page.locator(`[data-auto-id="${selectedOption.id}"]`),
        `clear persisted multi-select selection ${selectedOption.text || ''}`
      );
      if (!clicked) return false;
      await page.waitForTimeout(300);
    }
    return false;
  }

'''
if 'function canonicalAnswerText(text)' not in s:
    if helper_anchor not in s:
        raise SystemExit('sameQuestionIgnoringSelectionVisuals anchor missing')
    s = s.replace(helper_anchor, helpers + helper_anchor, 1)

# Rewrite same-question identity to ignore selected/check UI markers.
start = s.find('  function sameQuestionIgnoringSelectionVisuals(originalState, currentState) {')
end = s.find('  async function exploreMultiSelectBranches(', start)
if start < 0 or end < 0:
    raise SystemExit('sameQuestionIgnoringSelectionVisuals block not found')
identity = '''  function sameQuestionIgnoringSelectionVisuals(originalState, currentState) {
    if (!originalState || !currentState) return false;
    const originalPrompt = questionPromptFingerprint(originalState);
    const currentPrompt = questionPromptFingerprint(currentState);
    if (!originalPrompt || !currentPrompt || contextSimilarity(originalPrompt, currentPrompt) < 0.82) return false;
    const originalOptions = uniqueAnswerOptions(originalState.group || []).map(x => canonicalAnswerText(x.text)).filter(Boolean);
    const currentOptions = uniqueAnswerOptions(currentState.group || []).map(x => canonicalAnswerText(x.text)).filter(Boolean);
    if (originalOptions.length < 2 || currentOptions.length < 2) return false;
    const overlap = originalOptions.filter(text => currentOptions.includes(text)).length;
    return overlap >= Math.max(2, Math.ceil(Math.min(originalOptions.length, currentOptions.length) * 0.7));
  }

'''
s = s[:start] + identity + s[end:]

# Answer matching and same-answer-set checks should ignore checkmarks too.
old = '''      const wanted = (wantedText || '').trim().toLowerCase();
      let option = uniqueGroup.find(x => (x.text || '').trim().toLowerCase() === wanted);
      if (!option) option = uniqueGroup.find(x => (x.text || '').trim().toLowerCase().includes(wanted));
'''
new = '''      const wanted = canonicalAnswerText(wantedText);
      let option = uniqueGroup.find(x => canonicalAnswerText(x.text) === wanted);
      if (!option) option = uniqueGroup.find(x => canonicalAnswerText(x.text).includes(wanted));
'''
if old in s:
    s = s.replace(old, new, 1)

old = '''      const originalOptions = (questionState.group || []).map(x => (x.text || '').trim().toLowerCase()).filter(Boolean);
      const currentOptions = (afterSelection.group || []).map(x => (x.text || '').trim().toLowerCase()).filter(Boolean);
'''
new = '''      const originalOptions = (questionState.group || []).map(x => canonicalAnswerText(x.text)).filter(Boolean);
      const currentOptions = (afterSelection.group || []).map(x => canonicalAnswerText(x.text)).filter(Boolean);
'''
if old in s:
    s = s.replace(old, new, 1)

# Replace the per-test restore gate in exploreMultiSelectBranches.
old = '''      if (setIndex > 0) {
        const restored = await restoreQuestionPage(questionUrl, optionTexts, questionFingerprint);
        if (!restored) {
          const currentState = await inspectPageNavigationSafe('multi-select restore-failure identity check').catch(() => null);
          if (sameQuestionIgnoringSelectionVisuals(state, currentState)) {
            console.log('Restore verification was strict, but this is still the same multi-select question. Selection styling will not become another numbered page.');
            return false;
          }
          console.log('Multi-select branch question could not be restored. Preserving the current landing page for the next numbered screenshot instead of interacting with it before capture.');
          return true;
        }
      }
'''
new = '''      if (setIndex > 0) {
        let restored = await restoreQuestionPage(questionUrl, optionTexts, questionFingerprint);
        if (!restored) {
          const currentState = await inspectPageNavigationSafe('multi-select restore-failure identity check').catch(() => null);
          if (sameQuestionIgnoringSelectionVisuals(state, currentState)) {
            console.log('Restore verification was strict, but this is still the same multi-select question with remembered selection styling. Reusing it as the source question.');
            restored = currentState;
          } else {
            console.log('Multi-select branch question could not be restored. Preserving the current landing page for the next numbered screenshot instead of interacting with it before capture.');
            return true;
          }
        }
        const cleared = await clearPersistedMultiSelectSelections(state);
        if (!cleared) {
          console.log('Could not reliably clear persisted multi-select selections. Stopping branch comparison rather than testing cumulative answer sets or creating duplicate numbered pages.');
          return false;
        }
      }
'''
if old not in s:
    raise SystemExit('multi-select restore gate not found')
s = s.replace(old, new, 1)

# Final restore: same question with remembered checks is still the source page.
old = '''    if (!restored) {
      const currentState = await inspectPageNavigationSafe('multi-select final restore identity check').catch(() => null);
      if (sameQuestionIgnoringSelectionVisuals(state, currentState)) {
        console.log('The multi-select source question is still the same page despite selected/unselected styling. It will not receive a new numbered screenshot.');
        return false;
      }
      console.log('Could not restore the multi-select source question after comparison. Preserving the current landing page for the next numbered screenshot.');
      return true;
    }
'''
new = '''    if (!restored) {
      const currentState = await inspectPageNavigationSafe('multi-select final restore identity check').catch(() => null);
      if (sameQuestionIgnoringSelectionVisuals(state, currentState)) {
        console.log('The multi-select source question is still the same page despite remembered selection styling. It will not receive a new numbered screenshot.');
        await clearPersistedMultiSelectSelections(state).catch(() => false);
        return false;
      }
      console.log('Could not restore the multi-select source question after comparison. Preserving the current landing page for the next numbered screenshot.');
      return true;
    }
'''
if old in s:
    s = s.replace(old, new, 1)

p.write_text(s)
