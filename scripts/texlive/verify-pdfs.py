"""Validate actual compiled brand PDFs and render every page for visual QA."""
import json, pathlib, sys
import fitz
root = pathlib.Path(sys.argv[1])
report = []
for language in ('zh-CN', 'en'):
    directory = root / language
    document = fitz.open(directory / 'review.pdf')
    text = ''.join(page.get_text() for page in document)
    assert 'PDFKit' not in str(document.metadata), document.metadata
    assert '摘要' in text if language == 'zh-CN' else 'Abstract' in text
    assert '\ufffd' not in text, 'Replacement glyphs in PDF'
    for index, page in enumerate(document):
        assert page.get_images(), f'Memmy logo missing on page {index + 1}'
        drawings = page.get_drawings()
        assert any(d['color'] and abs(d['color'][0] - 253 / 255) < .02 and abs(d['color'][1] - 137 / 255) < .02 for d in drawings), 'Orange brand rule missing'
        if index == 0:
            assert any(d['fill'] and all(abs(a-b)<.02 for a,b in zip(d['fill'], (1, 247/255, 240/255))) for d in drawings), 'Abstract brand tint missing'
        page.get_pixmap(matrix=fitz.Matrix(1.3, 1.3)).save(directory / f'page-{index+1}.png')
    report.append({'language': language, 'pages': len(document), 'brandVerified': True})
(root / 'pdf-validation.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
