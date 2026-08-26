from pathlib import Path

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()

old = '''      const state = await inspectPage();
      const signature = pageSignature(state);
      const actionable = state.group.length > 0 || state.cta !== null || isNativeLanguageQuestion(state.pageText) || isSpeechInputScreen(state.pageText) || hasSkipEscapeChoice(state);

      if (actionable) {
        if (passiveTransition) console.log('Passive transition completed: actionable screen appeared.');
        return { state, changed: signature !== initialSignature };
      }
'''
new = '''      const state = await inspectPage();
      const signature = pageSignature(state);
      // Editable inputs are actionable even when inspectPage() reports no CTA/group.
      // Numeric profile steps (weight, height, age, goal weight) often render their
      // input first while the bottom CTA is still disabled, so waiting logic must
      // hand control back to the main loop as soon as that input appears.
      const visibleEditableInput = await hasVisibleEditableInput();
      const actionable = visibleEditableInput || state.group.length > 0 || state.cta !== null || isNativeLanguageQuestion(state.pageText) || isSpeechInputScreen(state.pageText) || hasSkipEscapeChoice(state);

      if (actionable) {
        if (passiveTransition) console.log(visibleEditableInput ? 'Passive transition completed: editable form input appeared.' : 'Passive transition completed: actionable screen appeared.');
        return { state, changed: signature !== initialSignature || visibleEditableInput };
      }
'''
if old not in s:
    raise SystemExit('waitForActionableState actionable block not found')
s = s.replace(old, new, 1)

p.write_text(s)
