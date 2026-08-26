from pathlib import Path

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()

marker = "  async function handleProfileNumericInput(state, screenNumber = null) {\n"
if marker not in s:
    raise SystemExit('handleProfileNumericInput marker not found')

helpers = r'''  async function findSemanticFormControl(intentType) {
    return await page.evaluate((wantedIntent) => {
      const normalize = value => (value || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const intentWords = {
        height: ['height', 'tall', 'cm', 'ft', 'feet'],
        'current-weight': ['current weight', 'weight', 'weigh', 'kg', 'lbs'],
        'goal-weight': ['goal weight', 'target weight', 'desired weight', 'kg', 'lbs'],
        age: ['age', 'old'],
        name: ['name', 'first name', 'your name']
      }[wantedIntent] || [];

      const candidates = Array.from(document.querySelectorAll(
        'input, textarea, [contenteditable="true"], [role="textbox"], [role="spinbutton"]'
      ));
      const scored = [];

      for (const el of candidates) {
        const tag = el.tagName.toLowerCase();
        const type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : '';
        if (type === 'hidden' || el.disabled === true || el.getAttribute('aria-disabled') === 'true') continue;

        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const rect = el.getBoundingClientRect();
        const visibleBox = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
          rect.top < window.innerHeight && rect.left < window.innerWidth;

        let labelText = '';
        if (el.id) {
          const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (label) labelText = label.innerText || label.textContent || '';
        }
        if (!labelText) {
          const parentLabel = el.closest('label');
          if (parentLabel) labelText = parentLabel.innerText || parentLabel.textContent || '';
        }

        let nearbyText = '';
        let ancestor = el.parentElement;
        let depth = 0;
        while (ancestor && ancestor !== document.body && depth < 5) {
          const text = normalize(ancestor.innerText || ancestor.textContent || '');
          if (text && text.length <= 500) nearbyText += ' ' + text;
          ancestor = ancestor.parentElement;
          depth++;
        }

        const signals = normalize([
          el.getAttribute('name'), el.getAttribute('placeholder'), el.getAttribute('autocomplete'),
          el.getAttribute('aria-label'), el.getAttribute('title'), el.id, el.className && String(el.className),
          labelText, nearbyText
        ].filter(Boolean).join(' '));

        let score = visibleBox ? 120 : 25;
        if (tag === 'input' || tag === 'textarea') score += 30;
        if (el.isContentEditable || el.getAttribute('role') === 'textbox' || el.getAttribute('role') === 'spinbutton') score += 35;
        if (['number', 'tel'].includes(type) || el.getAttribute('inputmode') === 'numeric' || el.getAttribute('inputmode') === 'decimal') {
          if (wantedIntent !== 'name') score += 45;
        }
        if ((type === 'text' || tag === 'textarea' || el.getAttribute('role') === 'textbox') && wantedIntent === 'name') score += 45;
        for (const word of intentWords) if (signals.includes(word)) score += 35;
        if (wantedIntent === 'goal-weight' && /goal|target|desired/.test(signals)) score += 80;
        if (wantedIntent === 'current-weight' && /current|weigh/.test(signals)) score += 60;
        if (wantedIntent === 'height' && /height|tall/.test(signals)) score += 70;
        if (wantedIntent === 'age' && /age|old/.test(signals)) score += 70;
        if (wantedIntent === 'name' && /name/.test(signals)) score += 70;

        scored.push({ el, score, visibleBox });
      }

      if (!scored.length) return null;
      scored.sort((a, b) => b.score - a.score || Number(b.visibleBox) - Number(a.visibleBox));
      const chosen = scored[0];
      if (chosen.score < 45) return null;
      const id = `crawler-semantic-input-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
      chosen.el.setAttribute('data-crawler-semantic-input-id', id);
      return { id, score: chosen.score, visibleBox: chosen.visibleBox };
    }, intentType).catch(() => null);
  }

  async function fillSemanticFormControl(control, value) {
    const text = String(value);
    const editable = await control.isEditable().catch(() => false);
    if (editable) {
      try {
        await control.fill(text);
        await control.evaluate(el => {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.blur?.();
        });
        await page.waitForTimeout(450);
        return true;
      } catch {}
    }

    const changed = await control.evaluate((nextValue) => {
      const el = this;
      return false;
    }, text).catch(() => false);
    if (changed) return true;

    return await control.evaluate((nextValue) => {
      const el = arguments[0] && this ? this : null;
      return false;
    }, text).catch(() => false);
  }

  async function forceSetSemanticFormControl(control, value) {
    const text = String(value);
    return await control.evaluate((el, nextValue) => {
      try {
        if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
          el.focus?.();
          el.textContent = nextValue;
        } else if ('value' in el) {
          const proto = el.tagName.toLowerCase() === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
          if (descriptor?.set) descriptor.set.call(el, nextValue);
          else el.value = nextValue;
        } else {
          el.textContent = nextValue;
        }
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: nextValue }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.blur?.();
        return true;
      } catch {
        return false;
      }
    }, text).catch(() => false);
  }

  async function writeSemanticFormControl(control, value) {
    if (await control.isEditable().catch(() => false)) {
      try {
        await control.fill(String(value));
        await control.evaluate(el => {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.blur?.();
        });
        await page.waitForTimeout(500);
        return true;
      } catch {}
    }
    const changed = await forceSetSemanticFormControl(control, value);
    if (changed) await page.waitForTimeout(500);
    return changed;
  }

'''

s = s.replace(marker, helpers + marker, 1)

old = r'''    const fields = page.locator(
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
'''
new = r'''    const fields = page.locator(
      'input:not([type]), input[type="text"], input[type="number"], input[type="tel"], input[inputmode="numeric"], input[inputmode="decimal"], [contenteditable="true"], [role="textbox"], [role="spinbutton"]'
    );
    const count = await fields.count();
    const editable = [];
    for (let i = 0; i < count; i++) {
      const field = fields.nth(i);
      if (!(await field.isEnabled().catch(() => true))) continue;
      if (!(await field.isVisible().catch(() => false))) continue;
      editable.push(field);
    }

    // Some funnels implement profile fields as custom React controls, hidden native
    // inputs, contenteditable nodes, or role=textbox/spinbutton elements. Once the
    // visible page intent says height/weight/age, do not give up simply because the
    // ordinary input selector missed the implementation.
    if (!editable.length) {
      const semanticControl = await findSemanticFormControl(profileType);
      if (semanticControl?.id) {
        console.log(`Semantic ${profileType} page detected; using its custom form control.`);
        editable.push(page.locator(`[data-crawler-semantic-input-id="${semanticControl.id}"]`));
      }
    }
    if (!editable.length) {
      console.log(`Semantic ${profileType} page detected, but no writable control could be found.`);
      return { recognized: true, advanced: false };
    }
'''
if old not in s:
    raise SystemExit('numeric field discovery block not found')
s = s.replace(old, new, 1)

old = r'''    async function fillNumeric(field, value) {
      await field.fill(String(value));
      await field.evaluate(el => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.blur();
      });
      await page.waitForTimeout(700);
    }
'''
new = r'''    async function fillNumeric(field, value) {
      const written = await writeSemanticFormControl(field, value);
      if (!written) throw new Error(`Unable to write semantic ${profileType} value: ${value}`);
      await page.waitForTimeout(250);
    }
'''
if old not in s:
    raise SystemExit('fillNumeric block not found')
s = s.replace(old, new, 1)

old = r'''      const nearbyAction = await findBottomPrimaryFormAction(field);
      if (nearbyAction) {
        const clicked = await safeCrawlerClick(nearbyAction.locator, nearbyAction.text || `${fieldType} bottom primary CTA`);
        if (clicked && await waitForAdvancement(beforeSignature, 12000)) return { recognized: true, advanced: true };
      }

      console.log(`Trying Enter for ${fieldType} input.`);
'''
new = r'''      const nearbyAction = await findBottomPrimaryFormAction(field);
      if (nearbyAction) {
        const clicked = await safeCrawlerClick(nearbyAction.locator, nearbyAction.text || `${fieldType} bottom primary CTA`);
        if (clicked && await waitForAdvancement(beforeSignature, 12000)) return { recognized: true, advanced: true };
      }

      // Custom/hidden semantic controls may not have a usable bounding box, so the
      // input-relative CTA finder can legitimately return null. In that case use the
      // page-level bottom navigation detector (NEXT STEP / CONTINUE / NEXT).
      const bottomAction = await findBottomNavigationFallback();
      if (bottomAction) {
        const clicked = await safeCrawlerClick(
          page.locator(`[data-bottom-navigation-id="${bottomAction.id}"]`),
          bottomAction.text || `${fieldType} bottom navigation CTA`
        );
        if (clicked && await waitForAdvancement(beforeSignature, 12000)) return { recognized: true, advanced: true };
      }

      console.log(`Trying Enter for ${fieldType} input.`);
'''
if old not in s:
    raise SystemExit('numeric submit fallback block not found')
s = s.replace(old, new, 1)

marker = "  async function handleGenericFormInput(state) {\n    const visibleFormIntent = (await getVisibleFormIntentText()).toLowerCase().replace(/\\s+/g, ' ').trim();\n"
if marker not in s:
    raise SystemExit('generic form marker not found')
insert = r'''  async function handleGenericFormInput(state) {
    const visibleFormIntent = (await getVisibleFormIntentText()).toLowerCase().replace(/\s+/g, ' ').trim();

    // Name pages follow the same semantic-first rule as height/weight/age. If the
    // heading says this is a name task, locate the corresponding writable control
    // even when it is custom/contenteditable/hidden rather than a normal text input.
    if (/\bwhat(?:'s| is) your name\b|\benter (?:your )?name\b|\byour name\b/i.test(visibleFormIntent)) {
      const semanticName = await findSemanticFormControl('name');
      if (semanticName?.id) {
        const input = page.locator(`[data-crawler-semantic-input-id="${semanticName.id}"]`);
        console.log('Detected name input from page intent.');
        const written = await writeSemanticFormControl(input, 'Alex');
        if (!written) return { recognized: true, advanced: false };
        const agreementState = await handleRequiredAgreementCheckboxes(input);
        if (!agreementState.active) return { recognized: true, advanced: false };
        await page.waitForTimeout(400);
        const beforeSubmitState = await inspectPageNavigationSafe('name submit inspection');
        const beforeSignature = pageSignature(beforeSubmitState);
        const nearbyAction = await findBottomPrimaryFormAction(input);
        if (nearbyAction) {
          const clicked = await safeCrawlerClick(nearbyAction.locator, nearbyAction.text || 'name bottom primary CTA');
          if (clicked && await waitForAdvancement(beforeSignature, 12000)) return { recognized: true, advanced: true };
        }
        const bottomAction = await findBottomNavigationFallback();
        if (bottomAction) {
          const clicked = await safeCrawlerClick(
            page.locator(`[data-bottom-navigation-id="${bottomAction.id}"]`),
            bottomAction.text || 'name bottom navigation CTA'
          );
          if (clicked && await waitForAdvancement(beforeSignature, 12000)) return { recognized: true, advanced: true };
        }
        await input.press('Enter').catch(() => {});
        if (await waitForAdvancement(beforeSignature, 8000)) return { recognized: true, advanced: true };
        return { recognized: true, advanced: false };
      }
    }
'''
s = s.replace(marker, insert, 1)

p.write_text(s)
