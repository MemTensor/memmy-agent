# Restrict Editing / Make Read-Only (Document Protection)

## Goal
Set Word's **document protection** flags in `settings.xml` so a `.docx` opens as:
- read-only, or
- comments-only, or
- tracked-changes-only, or
- forms-only

This is useful for:
- shipping a template that should not be casually modified
- forcing reviewers to comment instead of edit

## Set protection mode
```bash
node scripts/set_protection.mjs input.docx --mode readOnly --out protected.docx
node scripts/set_protection.mjs input.docx --mode comments --out comments_only.docx
node scripts/set_protection.mjs input.docx --mode trackedChanges --out tc_only.docx
node scripts/set_protection.mjs input.docx --mode forms --out forms_only.docx
```

## Remove protection
```bash
node scripts/set_protection.mjs input.docx --mode off --out unprotected.docx
```

## Verification
Render to PNGs (layout should be unchanged):
```bash
node scripts/render_docx.mjs protected.docx --output_dir out_protected
```

## Pitfalls
- Protection is enforced by Word; some viewers may ignore it.
- Password protection is intentionally not implemented (high complexity, low ROI).
- Some docs may not have `word/settings.xml`; this helper creates it.
