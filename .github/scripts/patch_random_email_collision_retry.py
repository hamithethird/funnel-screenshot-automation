from pathlib import Path

p = Path("funnel-crawler-multiscreen.js")
s = p.read_text()

# 1) Replace the run-email generator by structural boundaries instead of exact
#    whole-block text matching. This keeps working even when nearby crawler code
#    has changed locally.
if "let activeRunEmail = BASE_RUN_EMAIL;" not in s:
    start = s.find("  const BASE_RUN_EMAIL = 'REMOVED_EMAIL';")
    end = s.find("  function generateRunPassword(", start)
    if start < 0 or end < 0:
        raise SystemExit("Could not locate run-email generator boundaries.")

    new_email = r'''  const BASE_RUN_EMAIL = 'REMOVED_EMAIL';
  let activeRunEmail = BASE_RUN_EMAIL;

  function currentRunEmail() {
    return activeRunEmail;
  }

  function advanceRunEmail() {
    // After the normal address collides, generate a fresh unique address for this
    // run. Avoid plus-addressing because some funnels reject '+' in email inputs.
    const timestamp = Date.now().toString(36);
    const randomPart = crypto.randomBytes(6).toString('hex');
    activeRunEmail = `REMOVED_EMAIL`;
    return activeRunEmail;
  }

'''
    s = s[:start] + new_email + s[end:]

# 2) Replace the collision detector structurally. Read visible page text plus
#    dedicated alert/error/aria validation surfaces.
detector_start = s.find("  async function emailAlreadyUsedDetected(input) {")
retry_start = s.find("  async function retryWithNextEmailIfNeeded(input) {", detector_start)
if detector_start < 0 or retry_start < 0:
    raise SystemExit("Could not locate email collision detector boundaries.")

new_detector = r'''  async function emailAlreadyUsedDetected(input) {
    const details = await input.evaluate(el => {
      const texts = [];
      const add = value => {
        const text = (value || '').replace(/\s+/g, ' ').trim();
        if (text) texts.push(text);
      };

      add(el.validationMessage || '');

      const errorMessageId = el.getAttribute('aria-errormessage');
      if (errorMessageId) {
        const node = document.getElementById(errorMessageId);
        if (node) add(node.innerText || node.textContent || '');
      }

      const describedBy = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
      for (const id of describedBy) {
        const node = document.getElementById(id);
        if (node) add(node.innerText || node.textContent || '');
      }

      let ancestor = el.parentElement;
      for (let depth = 0; ancestor && depth < 6; depth++, ancestor = ancestor.parentElement) {
        for (const node of ancestor.querySelectorAll(
          '[role="alert"], [aria-live], [class*="error" i], [class*="invalid" i], [class*="message" i], [class*="helper" i], [class*="hint" i]'
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

      add(document.body?.innerText || '');

      for (const node of document.querySelectorAll(
        '[role="alert"], [aria-live], [class*="error" i], [class*="invalid" i], [class*="message" i], [class*="helper" i], [class*="hint" i]'
      )) {
        add(node.innerText || node.textContent || '');
      }

      return parts.join(' | ');
    }).catch(() => '');

    const combined = (pageText + ' ' + details).toLowerCase();
    const patterns = [
      /(?:email|e-mail).{0,100}(?:already|previously).{0,50}(?:used|taken|registered|exists|exist|in use|associated|linked)/i,
      /(?:already|previously).{0,50}(?:used|taken|registered|exists|exist|in use|associated|linked).{0,100}(?:email|e-mail)/i,
      /(?:account|user).{0,100}(?:already exists|already registered|already in use|already has)/i,
      /(?:an?|this)\s+account\s+(?:with\s+this\s+email\s+)?already\s+exists/i,
      /duplicate\s+(?:email|account|user)/i,
      /email\s+(?:has\s+)?already\s+been\s+(?:used|taken|registered)/i,
      /this\s+email\s+(?:is\s+)?(?:already\s+)?(?:used|taken|registered|in use)/i
    ];

    const matched = patterns.some(pattern => pattern.test(combined));
    if (matched) {
      console.log('Email collision message detected on the page.');
    }
    return matched;
  }

'''
s = s[:detector_start] + new_detector + s[retry_start:]

# 3) Replace retry helper structurally too.
retry_start = s.find("  async function retryWithNextEmailIfNeeded(input) {")
generic_start = s.find("  async function handleGenericFormInput(state) {", retry_start)
if retry_start < 0 or generic_start < 0:
    raise SystemExit("Could not locate email retry helper boundaries.")

new_retry = r'''  async function retryWithNextEmailIfNeeded(input) {
    if (!(await emailAlreadyUsedDetected(input))) return null;

    const nextEmail = advanceRunEmail();
    console.log(`Email collision detected. Generated a fresh random email: ${nextEmail}`);

    await input.fill(nextEmail);
    await input.evaluate(el => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
    });

    await page.waitForTimeout(900);
    return nextEmail;
  }

'''
s = s[:retry_start] + new_retry + s[generic_start:]

# 4) Privacy Policy / Terms links are not email-submit CTAs. Insert this check
#    immediately before findBottomPrimaryFormAction scores candidates.
filter_comment = "Legal/help/footer links can sit directly under the email field"
if filter_comment not in s:
    marker = """      if (!info || info.disabled || info.opacity < 0.35 || !info.reachable) continue;
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
    if marker not in s:
        raise SystemExit("Could not locate form CTA scoring insertion point.")
    s = s.replace(marker, replacement, 1)

# 5) Do not branch-probe email/forms. Checkboxes and legal links are form controls,
#    not conditional answers.
branch_skip_text = "Skipping branch probing for form controls/consent links."
if branch_skip_text not in s:
    marker = "  async function exploreAnswerBranchesIsolated(state, screenNumber) {\n"
    replacement = """  async function exploreAnswerBranchesIsolated(state, screenNumber) {
    if (await hasVisibleEditableInput()) {
      console.log('Forward-only branch mode: editable form detected. Skipping branch probing for form controls/consent links.');
      return false;
    }

"""
    if marker in s:
        s = s.replace(marker, replacement, 1)
    else:
        print("NOTE: isolated branch helper is not present in this local crawler; form branch-skip was not needed.")

p.write_text(s)
print("Patched random email collision retry, legal-link CTA filtering, and form branch skip.")
