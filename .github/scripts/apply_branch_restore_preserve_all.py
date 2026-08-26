from pathlib import Path

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()

replacements = [
("""      const restored = await restoreQuestionPage(questionUrl, optionTexts, questionFingerprint);\n      if (!restored) return false;\n      const finalResult = await chooseBranchOptionAndAdvance(optionTexts[0], screenNumber, questionState);\n      return finalResult.advanced;\n""",
"""      const restored = await restoreQuestionPage(questionUrl, optionTexts, questionFingerprint);\n      if (!restored) {\n        console.log('Branch source could not be restored. Preserving the current landing page for the next numbered screenshot.');\n        return outcomes.length > 0;\n      }\n      const finalResult = await chooseBranchOptionAndAdvance(optionTexts[0], screenNumber, questionState);\n      return finalResult.advanced;\n"""),
("""    const restored = await restoreQuestionPage(questionUrl, optionTexts, questionFingerprint);\n    if (!restored) {\n      console.log('Conditional pages were captured, but the main question could not be restored safely.');\n      return false;\n    }\n""",
"""    const restored = await restoreQuestionPage(questionUrl, optionTexts, questionFingerprint);\n    if (!restored) {\n      console.log('Conditional pages were captured, but the main question could not be restored safely. Preserving the current landing page for the next numbered screenshot.');\n      return true;\n    }\n""")
]

for old, new in replacements:
    if old not in s:
        print('replacement block not found or already patched')
        continue
    s = s.replace(old, new)

p.write_text(s)
