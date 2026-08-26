from pathlib import Path

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()

old_email = "  const RUN_EMAIL = 'hami.aksakal@hubx.co';\n"
new_email = """  const BASE_RUN_EMAIL = 'hami.aksakal@hubx.co';
  let runEmailSuffix = 0;

  function currentRunEmail() {
    if (runEmailSuffix <= 0) return BASE_RUN_EMAIL;
    return `hami.aksakal${runEmailSuffix}@hubx.co`;
  }

  function advanceRunEmail() {
    runEmailSuffix += 1;
    return currentRunEmail();
  }
"""
if old_email in s:
    s = s.replace(old_email, new_email, 1)
elif "const BASE_RUN_EMAIL = 'hami.aksakal@hubx.co';" not in s:
    raise SystemExit('RUN_EMAIL marker missing')

s = s.replace("        value = RUN_EMAIL;", "        value = currentRunEmail();", 1)

marker = "  async function handleGenericFormInput(state) {\n"
helper = """  async function emailAlreadyUsedDetected(input) {
    const pageText = await page.evaluate(() => (document.body?.innerText || '').replace(/\\s+/g, ' ').trim()).catch(() => '');
    const validationMessage = await input.evaluate(el => el.validationMessage || '').catch(() => '');
    const combined = `${pageText} ${validationMessage}`.toLowerCase();
    return /(?:email|e-mail|account|user).{0,45}(?:already|exists|registered|taken|used|in use)|(?:already|exists|registered|taken|used|in use).{0,45}(?:email|e-mail|account|user)|duplicate (?:email|account|user)/i.test(combined);
  }

  async function retryWithNextEmailIfNeeded(input) {
    if (!(await emailAlreadyUsedDetected(input))) return null;
    const nextEmail = advanceRunEmail();
    console.log(`Email is already registered/in use. Retrying with: ${nextEmail}`);
    await input.fill(nextEmail);
    await input.evaluate(el => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
    });
    await page.waitForTimeout(500);
    return nextEmail;
  }

"""
if helper.strip() not in s:
    if marker not in s:
        raise SystemExit('handleGenericFormInput marker missing')
    s = s.replace(marker, helper + marker, 1)

# After each submit attempt that did not advance, detect a duplicate-email response and
# restart the generic form handler with the incremented address.
old = """          const submittedByClick = await safeCrawlerClick(submit, 'form submit control');
          if (submittedByClick && await waitForAdvancement(beforeSignature)) return { recognized: true, advanced: true };
"""
new = """          const submittedByClick = await safeCrawlerClick(submit, 'form submit control');
          if (submittedByClick && await waitForAdvancement(beforeSignature)) return { recognized: true, advanced: true };
          if (fieldType === 'email' && await retryWithNextEmailIfNeeded(input)) {
            return await handleGenericFormInput(await inspectPageNavigationSafe('email collision retry'));
          }
"""
if old in s:
    s = s.replace(old, new, 1)

old = """        if (submitted && await waitForAdvancement(beforeSignature)) return { recognized: true, advanced: true };
"""
new = """        if (submitted && await waitForAdvancement(beforeSignature)) return { recognized: true, advanced: true };
        if (fieldType === 'email' && await retryWithNextEmailIfNeeded(input)) {
          return await handleGenericFormInput(await inspectPageNavigationSafe('email collision retry'));
        }
"""
if old in s:
    s = s.replace(old, new, 1)

old = """        const clicked = await safeCrawlerClick(nearbyAction.locator, nearbyAction.text || 'bottom primary CTA');
        if (clicked && await waitForAdvancement(beforeSignature)) return { recognized: true, advanced: true };
"""
new = """        const clicked = await safeCrawlerClick(nearbyAction.locator, nearbyAction.text || 'bottom primary CTA');
        if (clicked && await waitForAdvancement(beforeSignature)) return { recognized: true, advanced: true };
        if (fieldType === 'email' && await retryWithNextEmailIfNeeded(input)) {
          return await handleGenericFormInput(await inspectPageNavigationSafe('email collision retry'));
        }
"""
if old in s:
    s = s.replace(old, new, 1)

old = """      await input.press('Enter');
      if (await waitForAdvancement(beforeSignature)) return { recognized: true, advanced: true };
      console.log(`Unable to safely submit ${fieldType} field.`);
"""
new = """      await input.press('Enter');
      if (await waitForAdvancement(beforeSignature)) return { recognized: true, advanced: true };
      if (fieldType === 'email' && await retryWithNextEmailIfNeeded(input)) {
        return await handleGenericFormInput(await inspectPageNavigationSafe('email collision retry'));
      }
      console.log(`Unable to safely submit ${fieldType} field.`);
"""
if old in s:
    s = s.replace(old, new, 1)

p.write_text(s)
