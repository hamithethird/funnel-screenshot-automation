from pathlib import Path
import re

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()

old_speech = r'''function isSpeechInputScreen(text) {
  const normalized = (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  const speechSignals = [
    /\b(speak|speaking|spoken|say (?:it|this|something)|say aloud|read aloud)\b/,
    /\b(microphone|mic|voice|record|recording|pronunciation)\b/,
    /\b(quick call|ai tutor|voice assessment|speaking assessment|speech assessment)\b/
  ];
  return speechSignals.some(pattern => pattern.test(normalized));
}
'''
new_speech = r'''function isSpeechInputScreen(text) {
  const normalized = (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return false;

  // Only classify a page as requiring spoken/audio input when the page actually
  // asks the user to perform a speech/recording action. Mere questionnaire copy
  // such as "I needed more speaking practice" must NOT disable branch exploration.
  const hardSpeechSignals = [
    /\b(microphone|enable (?:your )?mic|allow microphone|record(?:ing)? (?:your )?(?:voice|answer)|start recording|stop recording)\b/,
    /\b(voice assessment|speech assessment|speaking assessment|pronunciation test|quick call|ai tutor call)\b/,
    /\b(say (?:this|it|something|the sentence)|say .* aloud|read .* aloud|speak (?:now|into|for|the following)|please speak|start speaking)\b/
  ];
  return hardSpeechSignals.some(pattern => pattern.test(normalized));
}
'''
if old_speech not in s:
    raise SystemExit('speech detector block not found')
s = s.replace(old_speech, new_speech, 1)

old_popup = r'''      const contextChanged = normalizeContextText(afterSelection.pageText) !== normalizeContextText(initialState.pageText);
      if (screenNumber !== null && samePageSelectionState && contextChanged && selectedKeys.size >= minSelections) {
        await captureSupplementalState(
          screenNumber,
          afterSelection,
          'post-selection response/popup',
          [option.text],
          0.95
        );
      }
'''
new_popup = r'''      const contextChanged = normalizeContextText(afterSelection.pageText) !== normalizeContextText(initialState.pageText);
      const originalPrompt = questionPromptFingerprint(initialState);
      const currentPrompt = questionPromptFingerprint(afterSelection);
      const promptStillMatches = !!originalPrompt && !!currentPrompt && contextSimilarity(originalPrompt, currentPrompt) >= 0.86;
      const originalOptions = (initialState.group || []).map(x => (x.text || '').trim().toLowerCase()).filter(Boolean);
      const currentOptions = (afterSelection.group || []).map(x => (x.text || '').trim().toLowerCase()).filter(Boolean);
      const overlap = originalOptions.filter(text => currentOptions.includes(text)).length;
      const sameAnswerSet = overlap >= Math.max(1, Math.ceil(Math.min(originalOptions.length, currentOptions.length) * 0.6));

      // A lettered screenshot here is reserved for a genuine same-question
      // post-selection message/popup. A normal next question on the same URL must
      // remain a normal numbered page.
      if (screenNumber !== null && samePageSelectionState && contextChanged && promptStillMatches && sameAnswerSet && selectedKeys.size >= minSelections) {
        await captureSupplementalState(
          screenNumber,
          afterSelection,
          'post-selection response/popup',
          [option.text],
          0.95
        );
      }
'''
if old_popup not in s:
    raise SystemExit('generic popup block not found')
s = s.replace(old_popup, new_popup, 1)

# Make the main branch gate log why it is skipping exploration, which will make
# future false positives immediately visible in terminal output.
old_gate = r'''    if (state.group.length >= 2 && !isSpeechInputScreen(state.pageText) && !hasSkipEscapeChoice(state)) {
      acted = await exploreAnswerBranches(state, screenNumber);
    }
'''
new_gate = r'''    if (state.group.length >= 2 && !isSpeechInputScreen(state.pageText) && !hasSkipEscapeChoice(state)) {
      acted = await exploreAnswerBranches(state, screenNumber);
    } else if (state.group.length >= 2 && isSpeechInputScreen(state.pageText)) {
      console.log('Branch exploration skipped because this page genuinely requests spoken/audio input.');
    }
'''
if old_gate not in s:
    raise SystemExit('main branch gate not found')
s = s.replace(old_gate, new_gate, 1)

p.write_text(s)
