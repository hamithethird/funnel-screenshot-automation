from pathlib import Path

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()

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

helper_marker = '  async function exploreMultiSelectBranches(state, screenNumber, instruction) {\n'
helper = '''  function sameQuestionIgnoringSelectionVisuals(originalState, currentState) {
    if (!originalState || !currentState) return false;
    const originalPrompt = questionPromptFingerprint(originalState);
    const currentPrompt = questionPromptFingerprint(currentState);
    if (!originalPrompt || !currentPrompt || contextSimilarity(originalPrompt, currentPrompt) < 0.82) return false;
    const originalOptions = uniqueAnswerOptions(originalState.group || []).map(x => (x.text || '').trim().toLowerCase()).filter(Boolean);
    const currentOptions = uniqueAnswerOptions(currentState.group || []).map(x => (x.text || '').trim().toLowerCase()).filter(Boolean);
    if (originalOptions.length < 2 || currentOptions.length < 2) return false;
    const overlap = originalOptions.filter(text => currentOptions.includes(text)).length;
    return overlap >= Math.max(2, Math.ceil(Math.min(originalOptions.length, currentOptions.length) * 0.7));
  }

'''
if 'function sameQuestionIgnoringSelectionVisuals' not in s:
    if helper_marker not in s:
        raise SystemExit('exploreMultiSelectBranches marker missing')
    s = s.replace(helper_marker, helper + helper_marker, 1)

old1 = '''        if (!restored) {
          console.log('Multi-select branch question could not be restored. Preserving the current landing page for the next numbered screenshot instead of interacting with it before capture.');
          return true;
        }
'''
new1 = '''        if (!restored) {
          const currentState = await inspectPageNavigationSafe('multi-select restore-failure identity check').catch(() => null);
          if (sameQuestionIgnoringSelectionVisuals(state, currentState)) {
            console.log('Restore verification was strict, but this is still the same multi-select question. Selection styling will not become another numbered page.');
            return false;
          }
          console.log('Multi-select branch question could not be restored. Preserving the current landing page for the next numbered screenshot instead of interacting with it before capture.');
          return true;
        }
'''
if old1 in s:
    s = s.replace(old1, new1, 1)

old2 = '''    if (!restored) {
      console.log('Could not restore the multi-select source question after comparison. Preserving the current landing page for the next numbered screenshot.');
      return true;
    }
'''
new2 = '''    if (!restored) {
      const currentState = await inspectPageNavigationSafe('multi-select final restore identity check').catch(() => null);
      if (sameQuestionIgnoringSelectionVisuals(state, currentState)) {
        console.log('The multi-select source question is still the same page despite selected/unselected styling. It will not receive a new numbered screenshot.');
        return false;
      }
      console.log('Could not restore the multi-select source question after comparison. Preserving the current landing page for the next numbered screenshot.');
      return true;
    }
'''
if old2 in s:
    s = s.replace(old2, new2, 1)

p.write_text(s)
