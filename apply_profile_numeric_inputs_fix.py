from pathlib import Path

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()

anchor = '''  async function handleGenericFormInput(state) {'''
helper = r'''  async function handleProfileNumericInput(state, screenNumber = null) {
    const pageText = (state?.pageText || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!pageText) return { recognized: false, advanced: false };

    let profileType = null;
    if (/\b(goal|target|desired)\s+weight\b|what(?:'s| is) your goal weight|goal weight/i.test(pageText)) {
      profileType = 'goal-weight';
    } else if (/\b(current\s+weight|your\s+current\s+weight|what(?:'s| is) your current weight|your weight)\b/i.test(pageText)) {
      profileType = 'current-weight';
    } else if (/\b(how tall are you|your height|height)\b/i.test(pageText)) {
      profileType = 'height';
    } else if (/\b(how old are you|your age|age)\b/i.test(pageText)) {
      profileType = 'age';
    }
    if (!profileType) return { recognized: false, advanced: false };

    const fields = page.locator(
      'input:not([type]), input[type="text"], input[type="number"], input[type="tel"], input[inputmode="numeric"], input[inputmode="decimal"]'
    );
    const count = await fields.count();
    const editable = [];
    for (let i = 0; i < count; i++) {
      const field = fields.nth(i);
      if (!(await field.isVisible().catch(() => false))) continue;
      if (!(await field.isEnabled().catch(() => false))) continue;
      if (!(await field.isEditable().catch(() => false))) continue;
      editable.push(field);
    }
    if (!editable.length) return { recognized: false, advanced: false };

    async function clickPreferredUnit(labelPattern, description) {
      const candidates = page.locator('button, [role="button"], label, [role="radio"], [role="tab"]');
      const n = await candidates.count();
      for (let i = 0; i < n; i++) {
        const candidate = candidates.nth(i);
        if (!(await candidate.isVisible().catch(() => false))) continue;
        const text = ((await candidate.innerText().catch(() => '')) || (await candidate.getAttribute('aria-label')) || '').trim();
        if (!labelPattern.test(text)) continue;
        const selected = await candidate.evaluate(el =>
          el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true' ||
          el.classList.contains('active') || el.classList.contains('selected')
        ).catch(() => false);
        if (!selected) await safeCrawlerClick(candidate, description);
        await page.waitForTimeout(250);
        return true;
      }
      return false;
    }

    async function fillNumeric(field, value) {
      await field.fill(String(value));
      await field.evaluate(el => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.blur();
      });
      await page.waitForTimeout(700);
    }

    async function captureProfileVariant(value, reason) {
      if (screenNumber === null) return;
      await waitForScreenshotReady({ minimumWaitMs: 700, maxWaitMs: 2200, pollMs: 250 });
      const filename = nextSupplementalFilename(screenNumber);
      await page.screenshot({ path: filename, fullPage: true });
      console.log(`Captured ${path.basename(filename)} for ${reason}: ${value}`);
    }

    async function submitProfileField(field, fieldType) {
      const agreementState = await handleRequiredAgreementCheckboxes(field);
      if (!agreementState.active) return { recognized: true, advanced: false };
      await page.waitForTimeout(500);
      const beforeSubmitState = await inspectPageNavigationSafe(`${fieldType} submit inspection`);
      const beforeSignature = pageSignature(beforeSubmitState);

      const form = field.locator('xpath=ancestor::form[1]');
      if ((await form.count()) > 0) {
        const submit = form.locator('button[type="submit"], input[type="submit"], button:not([type])').first();
        if ((await submit.count()) > 0 && (await submit.isVisible().catch(() => false)) && (await submit.isEnabled().catch(() => false))) {
          const clicked = await safeCrawlerClick(submit, `${fieldType} form submit control`);
          if (clicked && await waitForAdvancement(beforeSignature, 12000)) return { recognized: true, advanced: true };
        }
      }

      const nearbyAction = await findBottomPrimaryFormAction(field);
      if (nearbyAction) {
        const clicked = await safeCrawlerClick(nearbyAction.locator, nearbyAction.text || `${fieldType} bottom primary CTA`);
        if (clicked && await waitForAdvancement(beforeSignature, 12000)) return { recognized: true, advanced: true };
      }

      console.log(`Trying Enter for ${fieldType} input.`);
      await field.press('Enter').catch(() => {});
      if (await waitForAdvancement(beforeSignature, 8000)) return { recognized: true, advanced: true };
      console.log(`Unable to safely submit ${fieldType} field.`);
      return { recognized: true, advanced: false };
    }

    if (profileType === 'height') {
      console.log('Detected height input. Preferring 180 cm (6 ft fallback).');
      const metricAvailable = await clickPreferredUnit(/^cm$/i, 'height unit cm');
      if (metricAvailable || editable.length === 1) {
        await fillNumeric(editable[0], 180);
      } else {
        await clickPreferredUnit(/^(ft|feet)$/i, 'height unit feet');
        await fillNumeric(editable[0], 6);
        if (editable[1]) await fillNumeric(editable[1], 0);
      }
      return await submitProfileField(editable[0], 'height');
    }

    if (profileType === 'age') {
      console.log('Detected age input. Using age 25.');
      await fillNumeric(editable[0], 25);
      return await submitProfileField(editable[0], 'age');
    }

    if (profileType === 'current-weight') {
      console.log('Detected current-weight input. Testing 50, 70, 80, 100 kg; continuing with 80 kg.');
      await clickPreferredUnit(/^kg$/i, 'weight unit kg');
      for (const value of [50, 70, 80, 100]) {
        await fillNumeric(editable[0], value);
        await captureProfileVariant(value, 'current-weight response');
      }
      await fillNumeric(editable[0], 80);
      console.log('Current weight locked for continuation: 80 kg.');
      return await submitProfileField(editable[0], 'current-weight');
    }

    if (profileType === 'goal-weight') {
      console.log('Detected goal-weight input. Testing 75, 70, 60 kg; continuing with 70 kg.');
      await clickPreferredUnit(/^kg$/i, 'goal-weight unit kg');
      for (const value of [75, 70, 60]) {
        await fillNumeric(editable[0], value);
        await captureProfileVariant(value, 'goal-weight response');
      }
      await fillNumeric(editable[0], 70);
      console.log('Goal weight locked for continuation: 70 kg.');
      return await submitProfileField(editable[0], 'goal-weight');
    }

    return { recognized: false, advanced: false };
  }

  async function handleGenericFormInput(state) {'''

if anchor not in s:
    raise SystemExit('generic form anchor not found')
s = s.replace(anchor, helper, 1)

old = '''    // Foreground forms must outrank navigation controls that may still exist
    // behind an overlay (for example, an email gate covering a prior Continue button).
    const formResult = await handleGenericFormInput(state);
    if (formResult.recognized) return formResult.advanced;
'''
new = '''    // Semantic profile-number forms (height/weight/goal weight/age) need
    // deterministic values and, for weight screens, controlled response captures.
    const profileNumericResult = await handleProfileNumericInput(state, screenNumber);
    if (profileNumericResult.recognized) return profileNumericResult.advanced;

    // Foreground forms must outrank navigation controls that may still exist
    // behind an overlay (for example, an email gate covering a prior Continue button).
    const formResult = await handleGenericFormInput(state);
    if (formResult.recognized) return formResult.advanced;
'''
if old not in s:
    raise SystemExit('advanceOneScreen generic form block not found')
s = s.replace(old, new, 1)

p.write_text(s)
