from pathlib import Path

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()

old = '''  async function hasVisibleEditableInput() {
    const fields = page.locator('input:not([type]), input[type="text"], input[type="email"], input[type="password"], input[type="search"], input[type="tel"], input[type="url"], textarea');
    const count = await fields.count();
    for (let i = 0; i < count; i++) {
      if (await fields.nth(i).isVisible().catch(() => false)) return true;
    }
    return false;
  }
'''

new = '''  async function hasVisibleEditableInput() {
    // This helper is used by passive-transition waiting, so it must include
    // numeric profile fields too. BetterMe weight/height steps commonly use
    // type="number" or numeric/decimal inputmode and can appear before any CTA.
    const fields = page.locator(
      'input:not([type]), input[type="text"], input[type="email"], input[type="password"], input[type="search"], input[type="tel"], input[type="url"], input[type="number"], input[inputmode="numeric"], input[inputmode="decimal"], textarea'
    );
    const count = await fields.count();
    for (let i = 0; i < count; i++) {
      const field = fields.nth(i);
      if (!(await field.isVisible().catch(() => false))) continue;
      if (!(await field.isEnabled().catch(() => false))) continue;
      if (!(await field.isEditable().catch(() => false))) continue;
      return true;
    }
    return false;
  }
'''

if old not in s:
    raise SystemExit('hasVisibleEditableInput block not found')

s = s.replace(old, new, 1)
p.write_text(s)
