// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { themeLiteratureReviewCard } from "../literature-review-card-theme.js";

import enhancement from "../literature-review-card-enhancement.js?raw";

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
describe("review card presentation preserves plugin behavior", () => {
  it("keeps the installed renderer's submit button in the footer and uses its existing close button", async () => {
    document.body.innerHTML = '<main id="app"><header class="header"><div><h2>Papers</h2><p class="description">Detailed instructions</p></div><button class="close">×</button></header><p class="description card-description">Detailed instructions</p><div class="scroll"></div><div class="actions"><div><button>Confirm papers</button></div></div></main>';
    const close = document.querySelector<HTMLButtonElement>(".header > .close")!;
    const confirm = document.querySelector<HTMLButtonElement>(".actions button")!;
    const onClose = vi.fn(); const onConfirm = vi.fn();
    close.addEventListener("click", onClose); confirm.addEventListener("click", onConfirm);
    window.eval(enhancement);
    window.dispatchEvent(new MessageEvent("message", { source: window, data: { type: "memmy.plugin.render", events: [
      { type: "interaction", request: { payload: { cardType: "paper-selection" } } }
    ] } }));
    await vi.waitFor(() => expect(document.querySelector(".litrev-wizard-card__foot button")).toBe(confirm));
    expect(document.querySelectorAll(".litrev-wizard-card__head-actions button")).toHaveLength(1);
    expect(document.querySelector(".litrev-wizard-card__head-actions button")).toBe(close);
    expect(document.querySelector(".litrev-wizard-card__body > .card-description")).toBeNull();
    expect(document.querySelector(".review-description__tooltip")?.textContent).toContain("选中参与写作的文献");
    expect(document.getElementById("app")?.textContent).not.toContain("Detailed instructions");
    close.click(); confirm.click();
    expect(onClose).toHaveBeenCalledOnce(); expect(onConfirm).toHaveBeenCalledOnce();
  });
  it("collapses review scope without discarding the edited fields", async () => {
    document.body.innerHTML = '<main id="app"><header class="header"><div><h2>Scope</h2><p class="description">Confirm scope</p></div></header><div class="scroll"><div class="panel grid2"><label class="field"><span>综述标题</span><input type="text" value="Initial title"></label><label class="field"><span>研究主题</span><input type="text" value="Memory"></label></div></div><div class="actions"><div><button>Back</button></div><div><button>Confirm</button></div></div></main>';
    window.eval(enhancement);
    const render = (interactionId: string) => window.dispatchEvent(new MessageEvent("message", { source: window, data: { type: "memmy.plugin.render", events: [
      { type: "interaction", request: { interactionId, payload: { cardType: "review-spec" } } }
    ] } }));
    render("scope-1");
    await vi.waitFor(() => expect(document.querySelector('.review-spec__fold')).not.toBeNull());
    expect(document.querySelector('.review-description, .review-spec__summary')).toBeNull();
    const title = document.querySelector<HTMLInputElement>('.field input')!;
    title.value = "Edited title";
    const fold = document.querySelector<HTMLButtonElement>('.review-spec__fold')!;
    const close = document.querySelector<HTMLButtonElement>('.litrev-wizard-card__close')!;
    const foldIcon = fold.querySelector('svg')!;
    const closeIcon = close.querySelector('svg')!;
    expect(close.textContent).toBe("");
    expect(foldIcon.getAttribute('width')).toBe(closeIcon.getAttribute('width'));
    expect(foldIcon.getAttribute('stroke-width')).toBe(closeIcon.getAttribute('stroke-width'));
    fold.click();
    expect(document.querySelector("#app")?.classList.contains("review-spec--collapsed")).toBe(true);
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('.litrev-wizard-card__body input')).toBe(title);
    expect(title.value).toBe("Edited title");
    render("scope-1");
    await vi.waitFor(() => expect(document.querySelector("#app")?.classList.contains("review-spec--collapsed")).toBe(true));
    fold.click();
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(title.value).toBe("Edited title");
  });
  it("keeps keyword help beside the hint and exposes its content from one info icon", async () => {
    document.body.innerHTML = '<main id="app"><header class="header"><div><h2>Keywords</h2><p class="description">说明检索范围</p></div></header><div class="toolbar"><button>Add</button><span class="meta">建议保留 3～10 个关键词</span></div><div class="scroll"></div><div class="actions"><div><button>Back</button></div><div><button>Confirm</button></div></div></main>';
    window.eval(enhancement);
    window.dispatchEvent(new MessageEvent("message", { source: window, data: { type: "memmy.plugin.render", events: [
      { type: "interaction", request: { payload: { cardType: "keywords" } } }
    ] } }));
    await vi.waitFor(() => expect(document.querySelector('.review-description__info')).not.toBeNull());
    const info = document.querySelector<HTMLButtonElement>('.review-description__info')!;
    const tooltip = document.getElementById(info.getAttribute("aria-describedby")!)!;
    expect(info.querySelector("svg")).not.toBeNull();
    expect(document.querySelector('.review-description summary')).toBeNull();
    expect(tooltip.textContent).toContain("调整检索词、同义词和权重后确认");
    expect(tooltip.textContent).not.toContain("说明检索范围");
    expect(tooltip.textContent).toContain("建议保留 3～10 个关键词");
  });
  it.each(["review-spec", "keywords", "outline", "paper-selection", "fulltext-recovery"])("keeps raw task prose out of the %s card", async (cardType) => {
    document.body.innerHTML = '<main id="app"><header class="header"><div><h2>Review https://example.test/raw</h2><p class="description">Visit https://example.test/raw</p></div><button class="close">×</button></header><p class="description card-description">Visit https://example.test/raw</p><div class="scroll"></div><div class="actions"><div><button>Confirm</button></div></div></main>';
    window.eval(enhancement);
    window.dispatchEvent(new MessageEvent("message", { source: window, data: { type: "memmy.plugin.render", events: [
      { type: "interaction", request: { payload: { cardType } } }
    ] } }));
    await vi.waitFor(() => expect(document.querySelector(".litrev-wizard-card__body")).not.toBeNull());
    expect(document.getElementById("app")?.textContent).not.toContain("https://example.test/raw");
    expect(document.querySelector(".header h2")?.getAttribute("title")).toBeNull();
  });
  it("keeps paper search, full-text selection, and abstract controls wired after rearranging them", async () => {
    document.body.innerHTML = '<main id="app"><header class="header"><div><h2>Papers</h2><p class="description">Choose sources</p></div></header><div class="toolbar"><input type="search"><label class="checkline"><input type="checkbox">仅显示有全文</label><button class="secondary">选择当前结果</button><button class="secondary">清空当前结果</button><span class="count">已选 0 / 1 篇</span></div><div class="scroll"><article class="panel paper" data-fulltext="true"><input type="checkbox"><div><div class="paper-title">Long-term memory</div><div class="paper-meta"><span>Author</span><span class="availability full-text">可用全文</span></div><details><summary>查看摘要</summary><div class="abstract">Abstract text</div></details></div></article></div><div class="actions"><div><button>Back</button></div><div><button>Confirm</button></div></div></main>';
    document.querySelector('.scroll')!.insertAdjacentHTML('beforeend', '<article class="panel paper" data-fulltext="false"><input type="checkbox" checked><div><div class="paper-title">Abstract-only paper</div><div class="paper-meta"><span>Author 2</span><span class="availability abstract-only">仅摘要</span></div></div></article>');
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    const paperBox = document.querySelector<HTMLInputElement>('.paper input[type="checkbox"]')!;
    const abstractOnlyBox = document.querySelectorAll<HTMLInputElement>('.paper input[type="checkbox"]')[1]!;
    const onSearch = vi.fn(); const onPaperChange = vi.fn();
    search.addEventListener("input", onSearch); paperBox.addEventListener("change", onPaperChange);
    window.eval(enhancement);
    window.dispatchEvent(new MessageEvent("message", { source: window, data: { type: "memmy.plugin.render", events: [
      { type: "interaction", request: { payload: { cardType: "paper-selection" } } }
    ] } }));
    await vi.waitFor(() => expect(document.querySelector('.review-paper-controls__icon')).not.toBeNull());
    const searchPanel = document.querySelector<HTMLElement>('.review-paper-controls__search')!;
    expect(searchPanel.hidden).toBe(true);
    document.querySelector<HTMLButtonElement>('.review-paper-controls__icon')!.click();
    expect(searchPanel.hidden).toBe(false);
    search.value = "memory"; search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onSearch).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain("选择当前结果");
    expect(document.body.textContent).not.toContain("清空当前结果");
    document.querySelector<HTMLButtonElement>('.review-paper-controls__fulltext')!.click();
    expect(paperBox.checked).toBe(true);
    expect(abstractOnlyBox.checked).toBe(false);
    expect(onPaperChange).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('.litrev-ref-table__head input')?.getAttribute('aria-label')).toBe("全选当前文献"));
    const details = document.querySelector<HTMLDetailsElement>('.review-paper-abstract')!;
    details.open = true; details.dispatchEvent(new Event("toggle"));
    await vi.waitFor(() => expect(details.querySelector("summary")?.getAttribute("aria-label")).toBe("收起摘要"));
    expect(details.querySelector("summary svg")).not.toBeNull();
  });
  it("keeps the installed paper renderer's source status in the table status column", async () => {
    document.body.innerHTML = '<main id="app"><header class="header"><div><h2>Papers</h2></div><button class="close">×</button></header><div class="toolbar"><input type="search"><span class="count">已选 1 / 1 篇</span></div><div class="scroll"><article class="panel paper"><input type="checkbox" checked><div><div class="paper-title">Medical imaging review</div><div class="paper-meta"><span class="availability abstract-only">仅摘要</span></div></div><span class="source-status">需联网获取</span></article></div><div class="actions"><div><button>Confirm</button></div></div></main>';
    const sourceStatus = document.querySelector<HTMLElement>(".source-status")!;
    window.eval(enhancement);
    window.dispatchEvent(new MessageEvent("message", { source: window, data: { type: "memmy.plugin.render", events: [
      { type: "interaction", request: { payload: { cardType: "paper-selection" } } }
    ] } }));
    await vi.waitFor(() => expect(document.querySelector(".litrev-ref-row__source .source-status")).toBe(sourceStatus));
    expect(document.querySelector(".paper")?.children).toHaveLength(4);
    const status = document.querySelector(".litrev-ref-row__source")!;
    expect(status.children[0]?.textContent).toBe("仅摘要");
    expect(status.children[1]).toBe(sourceStatus);
    expect(document.querySelector(".litrev-ref-row__text .paper-title")?.getAttribute("title")).toBe("Medical imaging review");
  });
  it("condenses recovery rows while preserving copy and upload controls", async () => {
    document.body.innerHTML = '<main id="app"><header class="header"><div><h2>Recovery</h2><p class="description">原始说明</p></div></header><p class="description">复制链接下载全文后再上传文件。</p><p class="description">已上传 1 / 2 篇</p><div class="recovery-list"><article class="panel recovery-row"><div class="recovery-detail"><div class="paper-title">Paper one</div><div class="recovery-reason">自动下载失败，可改为浏览器手动下载</div></div><div class="recovery-actions"><button class="secondary copy-button"><svg></svg><span>复制链接</span></button><input type="file" hidden><button>已下载：选择文件</button></div></article><article class="panel recovery-row"><div class="recovery-detail"><div class="paper-title">Paper two</div><div class="recovery-reason">已上传：paper.pdf</div></div><div class="recovery-actions"><button class="secondary copy-button"><svg></svg><span>复制链接</span></button><span class="badge">已上传</span><input type="file" hidden><button>重新上传</button></div></article></div><p class="description">其余 1 篇会继续等待上传。</p><div class="actions"><div><button>Back</button></div><div><button>Continue</button></div></div></main>';
    const rows = document.querySelectorAll<HTMLElement>('.recovery-row');
    const copy = rows[0]!.querySelector<HTMLButtonElement>('.copy-button')!;
    const upload = rows[0]!.querySelector<HTMLButtonElement>('.recovery-actions > button:last-child')!;
    const replace = rows[1]!.querySelector<HTMLButtonElement>('.recovery-actions > button:last-child')!;
    const onCopy = vi.fn(); const onUpload = vi.fn(); const onReplace = vi.fn();
    copy.addEventListener('click', onCopy);
    upload.addEventListener('click', onUpload);
    replace.addEventListener('click', onReplace);
    window.eval(enhancement);
    window.dispatchEvent(new MessageEvent('message', { source: window, data: { type: 'memmy.plugin.render', events: [
      { type: 'interaction', request: { payload: { cardType: 'fulltext-recovery' } } }
    ] } }));
    await vi.waitFor(() => expect(document.querySelector('.review-recovery-title')).not.toBeNull());
    expect(document.querySelector('.review-recovery-help .litrev-section-hint')?.textContent).toBe('已上传 1 / 2 篇');
    expect(document.querySelectorAll('.litrev-wizard-card__body > .description')).toHaveLength(0);
    expect(rows[0]!.querySelector('.review-recovery-title .copy-button')).toBe(copy);
    expect(upload.textContent).toBe('上传');
    expect(rows[1]!.querySelector('.badge')).toBeNull();
    expect(rows[1]!.querySelector('.review-recovery-file__name')?.textContent).toBe('paper.pdf');
    expect(rows[1]!.querySelector('.review-recovery-file .review-recovery-replace')).toBe(replace);
    copy.click(); upload.click(); replace.click();
    expect(onCopy).toHaveBeenCalledOnce();
    expect(onUpload).toHaveBeenCalledOnce();
    expect(onReplace).toHaveBeenCalledOnce();
  });
  it("keeps recovery instructions in help when the installed renderer has no header description", async () => {
    document.body.innerHTML = '<main id="app"><header class="header"><div><h2>Recovery</h2></div><button class="close">×</button></header><p class="description">复制链接下载全文后再上传文件。</p><p class="description">已上传 0 / 2 篇</p><div class="recovery-list"></div><div class="actions"><div><button>Continue</button></div></div></main>';
    window.eval(enhancement);
    window.dispatchEvent(new MessageEvent("message", { source: window, data: { type: "memmy.plugin.render", events: [
      { type: "interaction", request: { payload: { cardType: "fulltext-recovery" } } }
    ] } }));
    await vi.waitFor(() => expect(document.querySelector(".review-recovery-help .litrev-section-hint")?.textContent).toBe("已上传 0 / 2 篇"));
    expect(document.querySelectorAll(".litrev-wizard-card__body > .description")).toHaveLength(0);
    expect(document.querySelector(".litrev-wizard-card__foot button")?.textContent).toBe("Continue");
  });
  it("feeds the bottom add form into the plugin's new row without dropping the term or weight", async () => {
    const state = [{ term: "one", weight: 3 }, { term: "two", weight: 4 }, { term: "three", weight: 5 }];
    const app = document.createElement("main"); app.id = "app"; document.body.append(app);
    function renderPlugin() {
      app.innerHTML = '<header class="header"><h2>Keywords</h2></header><div class="toolbar"><button type="button">Add</button></div><div class="scroll"></div><div class="actions"><div><button>Back</button></div><div><button>Submit</button></div></div>';
      for (const keyword of state) {
        const row = document.createElement("div"); row.className = "keyword-row";
        row.innerHTML = '<input type="checkbox" checked><div class="field"><span>关键词</span><input type="text"></div><div class="field aliases"><input type="text"></div><div class="field weight-field"><span>权重</span><div class="weight"><input type="range" min="1" max="10"><output></output></div></div><button class="danger">Delete</button>';
        const term = row.querySelector<HTMLInputElement>('input[type="text"]')!; term.value = keyword.term;
        term.addEventListener("input", () => keyword.term = term.value);
        const weight = row.querySelector<HTMLInputElement>('input[type="range"]')!; weight.value = String(keyword.weight);
        weight.addEventListener("input", () => keyword.weight = Number(weight.value));
        app.querySelector(".scroll")!.append(row);
      }
      app.querySelector(".toolbar button")!.addEventListener("click", () => { state.push({ term: "", weight: 5 }); renderPlugin(); });
    }
    renderPlugin(); window.eval(enhancement);
    await vi.waitFor(() => expect(app.querySelector(".litrev-keyword-add-form")).not.toBeNull());
    const draft = app.querySelector<HTMLInputElement>('.litrev-keyword-add-form input[type="text"]')!;
    draft.value = "new evidence"; draft.dispatchEvent(new Event("input", { bubbles: true }));
    app.querySelector<HTMLButtonElement>(".litrev-keyword-add-form button")!.click();
    expect(state).toHaveLength(4);
    expect(state[3]).toEqual({ term: "new evidence", weight: 6 });
    await vi.waitFor(() => expect(app.querySelectorAll(".litrev-keyword-row")).toHaveLength(4));
  });
  it("shows keyword terms from the installed renderer's plain wrapper and keeps its alias disclosure", async () => {
    document.body.innerHTML = '<main id="app"><header class="header"><h2>Keywords</h2></header><div class="toolbar"><button>Add</button></div><div class="scroll"><div class="panel keyword-row"><input type="checkbox" checked><div><input class="term" type="text" value="medical vision-language model"></div><div class="field weight-field"><span>权重</span><div class="weight"><input type="range" value="9"><output>9</output></div></div><button class="danger">Delete</button><details class="aliases"><summary>编辑同义词</summary><input type="text" value="medical VLM"></details></div></div><div class="actions"><div><button>Back</button></div><div><button>Confirm</button></div></div></main>';
    const term = document.querySelector<HTMLInputElement>(".term")!;
    const aliases = document.querySelector<HTMLDetailsElement>(".aliases")!;
    window.eval(enhancement);
    window.dispatchEvent(new MessageEvent("message", { source: window, data: { type: "memmy.plugin.render", events: [
      { type: "interaction", request: { payload: { cardType: "keywords" } } }
    ] } }));
    await vi.waitFor(() => expect(term.parentElement?.classList.contains("keyword-row")).toBe(true));
    expect(term.value).toBe("medical vision-language model");
    const weight = document.querySelector<HTMLElement>(".litrev-keyword-row__weight")!;
    expect(weight.classList.contains("weight-field")).toBe(false);
    expect(weight.querySelector(":scope > span")?.textContent).toBe("权重");
    expect(weight.querySelector('input[type="range"]')).toHaveProperty("value", "9");
    expect(aliases).toBe(document.querySelector(".review-keyword-details"));
    expect(aliases.querySelectorAll("details")).toHaveLength(0);
    expect(aliases.querySelector('input[type="text"]')).toHaveProperty("value", "medical VLM");
  });
  it("leaves unrecognized renderers intact", () => {
    const html = '<html><body><div id="app">Future renderer</div></body></html>';
    expect(themeLiteratureReviewCard(html)).toBe(html);
  });
  it("opens outline writing guidance from its edit icon without a second disclosure", async () => {
    document.body.innerHTML = '<main id="app"><header class="header"><h2>Outline</h2></header><div class="toolbar"><button>Add section</button></div><div class="scroll"><section class="panel outline-parent"><div class="outline-head"><button class="drag-handle">⠿</button><div class="outline-number">1</div><input type="text" value="Introduction"><button class="danger">Delete</button></div><textarea aria-label="章节写作要求">Explain the scope.</textarea><div class="children"><button class="secondary">Add child</button></div></section></div><div class="actions"><div><button>Back</button></div><div><button>Confirm</button></div></div></main>';
    const guidance = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="章节写作要求"]')!;
    const inputListener = vi.fn();
    guidance.addEventListener("input", inputListener);
    window.eval(enhancement);
    window.dispatchEvent(new MessageEvent("message", { source: window, data: { type: "memmy.plugin.render", events: [
      { type: "interaction", request: { payload: { cardType: "outline" } } }
    ] } }));
    await vi.waitFor(() => expect(document.querySelector('.litrev-icon-button--edit')).not.toBeNull());
    const edit = document.querySelector<HTMLButtonElement>('.litrev-icon-button--edit')!;
    const panel = document.getElementById(edit.getAttribute("aria-controls")!)!;
    expect(panel.hidden).toBe(true);
    expect(panel.querySelector("summary")).toBeNull();
    edit.click();
    expect(panel.hidden).toBe(false);
    expect(edit.getAttribute("aria-expanded")).toBe("true");
    guidance.value = "Revised scope";
    guidance.dispatchEvent(new Event("input", { bubbles: true }));
    expect(inputListener).toHaveBeenCalledOnce();
    edit.click();
    expect(panel.hidden).toBe(true);
    expect(edit.getAttribute("aria-expanded")).toBe("false");
  });
  it("adapts the installed outline renderer without showing level-change icons", async () => {
    document.body.innerHTML = '<main id="app"><header class="header"><div><h2>Outline</h2></div><button class="close">×</button></header><div class="scroll"><section class="panel outline-parent"><div class="outline-head"><div class="outline-number">●</div><button class="drag-handle">Drag</button><input type="text" value="Methods"><div class="outline-tools"><button aria-label="增加子标题">+</button><button aria-label="降为二级标题">↳</button><button class="danger">×</button></div></div><details class="outline-notes"><summary>写作要求</summary><textarea>Compare methods.</textarea></details><div class="children"><div class="child"><button class="drag-handle">Drag</button><input type="text" value="Evaluation"><div class="outline-tools"><button aria-label="升为一级标题">↰</button><button class="danger">×</button></div><details class="outline-notes"><summary>写作要求</summary><input class="guidance" type="text" value="Include metrics"></details></div></div></section></div><div class="actions"><div><button>Confirm</button></div></div></main>';
    const notes = document.querySelector<HTMLTextAreaElement>("textarea")!;
    const childNotes = document.querySelector<HTMLInputElement>(".guidance")!;
    const add = document.querySelector<HTMLButtonElement>('[aria-label="增加子标题"]')!;
    const onAdd = vi.fn(); add.addEventListener("click", onAdd);
    window.eval(enhancement);
    window.dispatchEvent(new MessageEvent("message", { source: window, data: { type: "memmy.plugin.render", events: [
      { type: "interaction", request: { payload: { cardType: "outline" } } }
    ] } }));
    await vi.waitFor(() => expect(document.querySelectorAll(".litrev-icon-button--edit")).toHaveLength(2));
    expect(notes.closest(".review-outline-guidance")).not.toBeNull();
    expect(childNotes.closest(".review-outline-guidance")).not.toBeNull();
    expect(document.querySelectorAll(".outline-notes")).toHaveLength(0);
    expect(document.querySelectorAll('[aria-label="降为二级标题"], [aria-label="升为一级标题"]')).toHaveLength(0);
    expect(document.querySelectorAll(".litrev-icon-button--delete")).toHaveLength(2);
    document.querySelector<HTMLButtonElement>('.litrev-icon-button--add')!.click();
    expect(onAdd).toHaveBeenCalledOnce();
  });
  it("keeps original input listeners and updates all-selection without submitting", async () => {
    document.body.innerHTML = '<main id="app"><header class="header"><h2>关键词</h2></header><div class="toolbar"></div><div class="scroll"></div><div class="actions"><button>确认</button></div></main>';
    const list = document.querySelector(".scroll")!;
    for (let index = 0; index < 2; index++) {
      const row = document.createElement("div"); row.className = "keyword-row";
      row.innerHTML = `<input type="checkbox" ${index === 0 ? "checked" : ""}><label class="field"><input type="text" value="term-${index}"></label><label class="field aliases"><input type="text" value="synonym"></label>`;
      list.append(row);
    }
    const term = list.querySelector<HTMLInputElement>('input[type="text"]')!;
    const alias = list.querySelector<HTMLInputElement>('.aliases input')!;
    const inputListener = vi.fn(); const changeListener = vi.fn(); const submit = vi.fn();
    alias.addEventListener("input", inputListener);
    list.querySelectorAll('input[type="checkbox"]').forEach((box) => box.addEventListener("change", changeListener));
    document.querySelector(".actions button")!.addEventListener("click", submit);
    window.eval(enhancement);
    await vi.waitFor(() => expect(document.querySelector(".review-keyword-selection output")?.textContent).toBe("1 / 2"));
    expect(list.querySelector('.review-keyword-details input')).toBe(alias);
    expect(list.querySelector('.review-keyword-details > summary svg')).not.toBeNull();
    expect(list.querySelector('input[type="text"]')).toBe(term);
    alias.value = "new synonym"; alias.dispatchEvent(new Event("input", { bubbles: true }));
    expect(inputListener).toHaveBeenCalledTimes(1);
    document.querySelector<HTMLInputElement>('.review-keyword-selection input')!.click();
    await vi.waitFor(() => expect(document.querySelector(".review-keyword-selection output")?.textContent).toBe("2 / 2"));
    expect(changeListener).toHaveBeenCalledTimes(2);
    expect(submit).not.toHaveBeenCalled();
    expect(document.querySelectorAll(".review-keyword-selection")).toHaveLength(1);
  });
});
