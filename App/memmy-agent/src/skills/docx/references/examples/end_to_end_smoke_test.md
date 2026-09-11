# End-to-end smoke test (optional)

This is a quick checklist to validate the environment and the helper scripts.

## 1) Render check
```bash
node scripts/render_docx.mjs /mnt/data/some.docx --output_dir /mnt/data/out
```

## 2) Add header date, page numbers, hyperlink
```bash
node scripts/docx_ooxml_patch.mjs /mnt/data/some.docx \
  --header-date "Date: 01/05/2026" \
  --add-page-numbers \
  --hyperlink-first "https://example.com"
```

## 3) Add comment (structural)
```bash
node scripts/docx_ooxml_patch.mjs /mnt/data/some.docx \
  --add-comment --comment-text "Hello comment"  # optionally add --contains "..." to anchor elsewhere
```

## 4) Tracked replace
If you already have a `<w:ins w:id="102">` in the doc:
```bash
node scripts/docx_ooxml_patch.mjs /mnt/data/some.docx \
  --enable-track --tracked-replace-ins-id 102 --new-text " HELLO"
```

## 5) Verify visually
Use `references/tasks/verify_render.md` (DOCX → PNG) and inspect.
