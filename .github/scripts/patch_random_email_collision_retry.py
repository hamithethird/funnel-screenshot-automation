from pathlib import Path

p = Path("funnel-crawler-multiscreen.js")
s = p.read_text()

# 1) After the user's normal email collides, switch to a genuinely unique random
#    address instead of user1, user2, ... which repeat on every run.
old_email = """  const BASE_RUN_EMAIL = 'REMOVED_EMAIL';
  let runEmailSuffix = 0;

  function currentRunEmail() {
    if (runEmailSuffix <= 0) return BASE_RUN_EMAIL;
    return \`REMOVED_EMAIL\`;
  }

  function advanceRunEmail() {
    runEmailSuffix += 1;
    return currentRunEmail();
  }
"""
new_email = """  const BASE_RUN_EMAIL = 'REMOVED_EMAIL';
  let activeRunEmail = BASE_RUN_EMAIL;

  function currentRunEmail() {
    return activeRunEmail;
  }

  function advanceRunEmail() {
    // Use a conservative address shape (letters/numbers/dots only in the local
    // part) so stricter funnel validators do not reject plus-addressing.
    const timestamp = Date.now().toString(36);
    const randomPart = crypto.randomBytes(6).toString('hex');
    activeRunEmail = \`REMOVED_EMAIL\`;
    return activeRunEmail;
  }
"""
if old_email in s:
    s = s.replace(old_email, new_email, 1)
elif "let activeRunEmail = BASE_RUN_EMAIL;" not in s:
    raise SystemExit("Could not find run-email generator block.")

# 2) Inspect dedicated validation/error surfaces too, not only body.innerText.
start = s.find("  async function emailAlreadyUsedDetected(input) {")
end = s.find("  async function retryWithNextEmailIfNeeded(input) {", start)
if start < 0 or end < 0:
    raise SystemExit("Could not find email collision detector.")

new_detector = r'''  async function emailAlreadyUsedDetected(input) {
    const details = await input.evaluate(el => {
      const texts = [];
      const add = value => {
        const text = (value || '').replace(/\s+/g, ' ').trim();
        if (text) texts.push(text);
      };

      add(el.validationMessage || '');
      add(el.getAttribute('aria-errormessage') || '');

      const describedBy = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
      for (const id of describedBy) {
        const node = document.getElementById(id);
        if (node) add(node.innerText || node.textContent || '');
      }

      let ancestor = el.parentElement;
      for (let depth = 0; ancestor && depth < 5; depth++, ancestor = ancestor.parentElement) {
        for (const node of ancestor.querySelectorAll(
          '[role="alert"], [aria-live], [class*="error" i], [class*="invalid" i], [class*="message" i]'
        )) {
          add(node.innerText || node.textContent || '');
        }
      }

      return texts.join(' | ');
    }).catch(() => '');

    const pageText = await page.evaluate(() => {
      const parts = [];
      const add = value => {
        const text = (value || '').replace(/\s+/g, ' ').trim();
        if (text) parts.push(text);
      };
      add(document.body && document.body.innerText || '');
      for (const node of document.querySelectorAll(
        '[role="alert"], [aria-live], [class*="error" i], [class*="invalid" i], [class*="message" i]'
      )) {
        add(node.innerText || node.textContent || '');
      }
      return parts.join(' | ');
    }).catch(() => '');

    const combined = (pageText + ' ' + details).toLowerCase();
    const patterns = [
      /(?:email|e-mail).{0,80}(?:already|previously).{0,40}(?:used|taken|registered|exists|exist|in use|associated)/i,
      /(?:already|previously).{0,40}(?:used|taken|registered|exists|exist|in use|associated).{0,80}(?:email|e-mail)/i,
      /(?:account|user).{0,80}(?:already exists|already registered|already in use)/i,
      /(?:an?|this)\s+account\s+(?:with\s+this\s+email\s+)?already\s+exists/i,
      /duplicate\s+(?:email|account|user)/i,
      /email\s+(?:has\s+)?already\s+been\s+(?:used|taken|registered)/i
    ];
    return patterns.some(pattern => pattern.test(combined));
  }

'''
s = s[:start] + new_detector + s[end:]

# 3) Make the retry explicit and wait for client-side validation to clear.
old_retry = """  async function retryWithNextEmailIfNeeded(input) {
    if (!(await emailAlreadyUsedDetected(input))) return null;
    const nextEmail = advanceRunEmail();
    console.log(\`Email is already registered/in use. Retrying with: \${nextEmail}\`);
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
new_retry = """  async function retryWithNextEmailIfNeeded(input) {
    if (!(await emailAlreadyUsedDetected(input))) return null;
    const nextEmail = advanceRunEmail();
    console.log(\`Email collision detected. Generated a fresh random email: \${nextEmail}\`);
    await input.fill(nextEmail);
    await input.evaluate(el => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
    });
    await page.waitForTimeout(900);
    return nextEmail;
  }
"""
if old_retry in s:
    s = s.replace(old_retry, new_retry, 1)
elif "Email collision detected. Generated a fresh random email:" not in s:
    raise SystemExit("Could not find email retry helper.")

# 4) Never treat legal/footer links such as Privacy Policy as a form-submit CTA.
needle = """      if (!info || info.disabled || info.opacity < 0.35 || !info.reachable) continue;
      if (info.verticalGap < -24) continue;

      let score = 0;
"""
replacement = """      if (!info || info.disabled || info.opacity < 0.35 || !info.reachable) continue;
      if (info.verticalGap < -24) continue;

      // Legal/help/footer links can sit directly under the email field and score
      // highly by proximity. They are not submission controls.
      const formActionText = (info.text || '').trim();
      if (/^(?:privacy(?: policy)?|terms(?: & conditions)?|terms and conditions|conditions|legal|cookie(?: policy)?|learn more|help|support)$/i.test(formActionText)) {
        continue;
      }

      let score = 0;
"""
if needle in s:
    s = s.replace(needle, replacement, 1)
elif "Legal/help/footer links can sit directly under the email field" not in s:
    raise SystemExit("Could not find form CTA scoring block.")

# 5) Do not branch-probe an email/form page. The Learna checkboxes and Privacy
#    Policy link were being mistaken for answer choices in the isolated branch pass.
iso_marker = """  async function exploreAnswerBranchesIsolated(state, screenNumber) {
    const instruction = getSelectionInstruction(state.pageText);
"""
iso_replacement = """  async function exploreAnswerBranchesIsolated(state, screenNumber) {
    if (await hasVisibleEditableInput()) {
      console.log('Forward-only branch mode: editable form detected. Skipping branch probing for form controls/consent links.');
      return false;
    }

    const instruction = getSelectionInstruction(state.pageText);
"""
if iso_marker in s:
    s = s.replace(iso_marker, iso_replacement, 1)
elif "Skipping branch probing for form controls/consent links." not in s:
    print("NOTE: isolated branch helper is not present yet; form-skip part was not applied.")

p.write_text(s)
print("Patched random email collision retry, form CTA filtering, and form branch skip.")
