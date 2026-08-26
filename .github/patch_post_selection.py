from pathlib import Path

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()

marker = "  async function handleAnswerGroup(state, screenNumber = null) {\n"
helper = """  function isTransientPostSelectionShell(state) {
    if (!state) return true;
    const text = normalizeContextText(state.pageText || '');
    const hasMeaningfulText = text.length >= 35;
    const hasChoices = Array.isArray(state.group) && state.group.length > 0;
    const hasCTA = !!state.cta;
    return !hasMeaningfulText && !hasChoices && !hasCTA;
  }

  async function waitForPostSelectionSettle(label = 'post-selection state', minimumWaitMs = 2600, timeoutMs = 7000) {
    await page.waitForTimeout(minimumWaitMs);
    const startedAt = Date.now();
    let state = await inspectPageNavigationSafe(label);
    while (Date.now() - startedAt < timeoutMs && isTransientPostSelectionShell(state)) {
      console.log('Transient post-selection shell detected. Waiting for the real screen to mount.');
      await page.waitForTimeout(450);
      await silenceMedia();
      state = await inspectPageNavigationSafe(label);
    }
    return state;
  }

"""
if 'function isTransientPostSelectionShell(state)' not in s:
    if marker not in s:
        raise SystemExit('handleAnswerGroup marker missing')
    s = s.replace(marker, helper + marker, 1)

old = """      selectedKeys.add(optionKey);
      await page.waitForTimeout(650);

      let afterSelection = await inspectPageNavigationSafe('answer selection inspection');
      const samePageSelectionState = sanitizeUrl(page.url()) === initialUrl && afterSelection.group.length > 0;
      const contextChanged = normalizeContextText(afterSelection.pageText) !== normalizeContextText(initialState.pageText);
      const originalPrompt = questionPromptFingerprint(initialState);
      const currentPrompt = questionPromptFingerprint(afterSelection);
      const promptStillMatches = !!originalPrompt && !!currentPrompt && contextSimilarity(originalPrompt, currentPrompt) >= 0.86;
      if (samePageSelectionState && promptStillMatches) {
        await captureSamePageVisualVariant(screenNumber, `selection: ${option.text || '[no visible text]'}`);
      }
      const originalOptions = (initialState.group || []).map(x => (x.text || '').trim().toLowerCase()).filter(Boolean);
      const currentOptions = (afterSelection.group || []).map(x => (x.text || '').trim().toLowerCase()).filter(Boolean);
      const overlap = originalOptions.filter(text => currentOptions.includes(text)).length;
      const sameAnswerSet = overlap >= Math.max(1, Math.ceil(Math.min(originalOptions.length, currentOptions.length) * 0.6));
"""
new = """      selectedKeys.add(optionKey);

      // Give SPAs time to finish unmounting/mounting after a selection. A brief
      // blank shell is a transition between screens, not a meaningful visual state.
      let afterSelection = await waitForPostSelectionSettle('answer selection inspection', 2600, 7000);
      const samePageSelectionState = sanitizeUrl(page.url()) === initialUrl && afterSelection.group.length > 0;
      const contextChanged = normalizeContextText(afterSelection.pageText) !== normalizeContextText(initialState.pageText);
      const originalPrompt = questionPromptFingerprint(initialState);
      const currentPrompt = questionPromptFingerprint(afterSelection);
      const promptStillMatches = !!originalPrompt && !!currentPrompt && contextSimilarity(originalPrompt, currentPrompt) >= 0.86;
      const originalOptions = (initialState.group || []).map(x => (x.text || '').trim().toLowerCase()).filter(Boolean);
      const currentOptions = (afterSelection.group || []).map(x => (x.text || '').trim().toLowerCase()).filter(Boolean);
      const overlap = originalOptions.filter(text => currentOptions.includes(text)).length;
      const sameAnswerSet = overlap >= Math.max(1, Math.ceil(Math.min(originalOptions.length, currentOptions.length) * 0.6));
      if (samePageSelectionState && promptStillMatches && sameAnswerSet && !isTransientPostSelectionShell(afterSelection)) {
        await captureSamePageVisualVariant(screenNumber, `selection: ${option.text || '[no visible text]'}`);
      }
"""
if old in s:
    s = s.replace(old, new, 1)
elif "waitForPostSelectionSettle('answer selection inspection'" not in s:
    raise SystemExit('normal answer selection block missing')

old = """      selected.push(option.text || wantedText);
      await page.waitForTimeout(450);

      const afterSelection = await inspectPageNavigationSafe('multi-select post-selection inspection');
      const originalPrompt = questionPromptFingerprint(questionState);
      const currentPrompt = questionPromptFingerprint(afterSelection);
      const samePrompt = !!originalPrompt && !!currentPrompt && contextSimilarity(originalPrompt, currentPrompt) >= 0.86;
      if (sanitizeUrl(page.url()) === questionUrl && samePrompt) {
        await captureSamePageVisualVariant(screenNumber, `selection: ${selected.join(' + ')}`);
      }
"""
new = """      selected.push(option.text || wantedText);

      const afterSelection = await waitForPostSelectionSettle('multi-select post-selection inspection', 2600, 7000);
      const originalPrompt = questionPromptFingerprint(questionState);
      const currentPrompt = questionPromptFingerprint(afterSelection);
      const samePrompt = !!originalPrompt && !!currentPrompt && contextSimilarity(originalPrompt, currentPrompt) >= 0.86;
      const originalOptions = (questionState.group || []).map(x => (x.text || '').trim().toLowerCase()).filter(Boolean);
      const currentOptions = (afterSelection.group || []).map(x => (x.text || '').trim().toLowerCase()).filter(Boolean);
      const overlap = originalOptions.filter(text => currentOptions.includes(text)).length;
      const sameAnswerSet = overlap >= Math.max(1, Math.ceil(Math.min(originalOptions.length, currentOptions.length) * 0.6));
      if (sanitizeUrl(page.url()) === questionUrl && samePrompt && sameAnswerSet && !isTransientPostSelectionShell(afterSelection)) {
        await captureSamePageVisualVariant(screenNumber, `selection: ${selected.join(' + ')}`);
      }
"""
if old in s:
    s = s.replace(old, new, 1)
elif "waitForPostSelectionSettle('multi-select post-selection inspection'" not in s:
    raise SystemExit('multi-select selection block missing')

p.write_text(s)
