from pathlib import Path

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()

old1 = '''    const beforeSignature = pageSignature(state);
    let acted = false;
'''
new1 = '''    const beforeSignature = pageSignature(state);
    // pageSignature is intentionally text-centric. Some SPA funnels reveal a
    // numeric/text input without changing visible body text, so remember whether
    // an editable field already existed before the interaction. This lets the
    // outer loop distinguish "nothing changed" from "a real form step appeared".
    const beforeHadEditableInput = await hasVisibleEditableInput();
    let acted = false;
'''
if old1 not in s:
    raise SystemExit('beforeSignature anchor not found')
s = s.replace(old1, new1, 1)

old2 = '''    const afterState = await inspectPage();
    const afterSignature = pageSignature(afterState);
    if (afterSignature === beforeSignature) {
      console.log('No page advancement detected. Stopping safely.');
      break;
    }
'''
new2 = '''    const afterState = await inspectPage();
    const afterSignature = pageSignature(afterState);
    if (afterSignature === beforeSignature) {
      const afterHasEditableInput = await hasVisibleEditableInput();
      if (!beforeHadEditableInput && afterHasEditableInput) {
        // A real form step appeared even though its heading/body text reused the
        // prior SPA shell. Do NOT stop here. Let the next numbered iteration
        // screenshot that form first, then advanceOneScreen will run the semantic
        // profile handler (height 180 cm, current weight variants ending at 80 kg,
        // goal weight variants ending at 70 kg, age 25) or the generic form handler.
        console.log('Editable form input appeared without a text-signature change. Treating this as real page advancement and continuing so the form can be captured and handled.');
        continue;
      }
      console.log('No page advancement detected. Stopping safely.');
      break;
    }
'''
if old2 not in s:
    raise SystemExit('afterSignature block not found')
s = s.replace(old2, new2, 1)

p.write_text(s)
