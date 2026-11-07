/* global document, window, MutationObserver, requestAnimationFrame, parent, Event */
// Restore the original card structure while retaining the plugin's input nodes and protocol handlers.
(function restoreLiteratureReviewCards() {
  const app = document.getElementById("app");
  if (!app) return;
  let queued = false;
  let cardType = "";
  let guidanceSequence = 0;
  let helpSequence = 0;
  let scopeCollapsed = false;
  let scopeInteractionId = "";
  const checkSvg = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m20 6-11 11-5-5"/></svg>';
  const gripSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="9" cy="5" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="19" r="1"/></svg>';
  const guidanceSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M4 17.5V20h2.5L18.7 7.8a1.77 1.77 0 0 0-2.5-2.5L4 17.5Z"/></svg>';
  const infoSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>';
  const searchSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>';
  const chevronSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  const closeSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  const moreSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>';
  const plusSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  const trashSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6"/></svg>';
  const uploadSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4m-4 4 4-4 4 4M4 16v4h16v-4"/></svg>';
  const replaceSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.8 9a7 7 0 0 1 11.9-2L20 12M4 12l2.3 5a7 7 0 0 0 11.9-2"/></svg>';
  const titles = { keywords: "检索关键词", outline: "综述大纲", "paper-selection": "参考文献来源", "review-spec": "确认综述范围", "fulltext-recovery": "补充文献全文" };
  const hints = { keywords: "确认或调整检索关键词，可增删", outline: "上下拖动调整同级顺序；聚焦手柄后也可用方向键移动。", "paper-selection": "选择参与综述的参考文献", "fulltext-recovery": "上传可获取的全文，或跳过剩余文献" };
  const helpText = { keywords: "调整检索词、同义词和权重后确认。", "paper-selection": "选中参与写作的文献；可以搜索或只勾选有全文的文献。", "fulltext-recovery": "复制文献链接获取全文，再上传对应文件；已上传的文件可以更换。" };
  const confirms = { keywords: "确认关键词", outline: "确认大纲", "paper-selection": "确认文献", "review-spec": "确认范围" };
  const node = (tag, className, text) => {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  };
  function checkboxGlyph(checked) {
    const mark = node("span", `litrev-checkbox${checked ? " litrev-checkbox--checked" : ""}`);
    mark.innerHTML = checked ? checkSvg : "";
    mark.setAttribute("aria-hidden", "true");
    return mark;
  }
  function setGlyph(mark, checked) {
    mark.classList.toggle("litrev-checkbox--checked", checked);
    mark.innerHTML = checked ? checkSvg : "";
  }
  function descriptionHelp(hint, content) {
    const help = node("div", "review-description");
    const label = node("span", "litrev-section-hint", hint);
    const info = node("button", "review-description__info");
    const tooltip = node("div", "review-description__tooltip");
    info.type = "button";
    info.innerHTML = infoSvg;
    info.setAttribute("aria-label", "查看说明");
    info.setAttribute("aria-describedby", tooltip.id = `review-description-${++helpSequence}`);
    info.addEventListener("keydown", (event) => { if (event.key === "Escape") info.blur(); });
    if (content) tooltip.append(content);
    help.append(label, info, tooltip);
    return help;
  }
  function scopeHeight() {
    return Math.ceil(app.getBoundingClientRect().height);
  }
  function applyScopeCollapse() {
    if (cardType !== "review-spec") return;
    app.classList.toggle("review-spec--collapsed", scopeCollapsed);
    const fold = app.querySelector(".review-spec__fold");
    if (fold) {
      fold.setAttribute("aria-expanded", String(!scopeCollapsed));
      fold.setAttribute("aria-label", scopeCollapsed ? "展开综述范围" : "收起综述范围");
      fold.title = scopeCollapsed ? "展开综述范围" : "收起综述范围";
    }
  }
  function restoreShell() {
    const header = app.querySelector(":scope > .header");
    if (!header) return null;
    let body = app.querySelector(":scope > .litrev-wizard-card__body");
    const actions = app.querySelector(":scope > .actions");
    if (!body) {
      body = node("div", "litrev-wizard-card__body");
      if (cardType === "review-spec") body.id = "review-spec-fields";
      header.after(body);
      for (const child of Array.from(app.children)) {
        if (child !== header && child !== body && child !== actions) body.append(child);
      }
      header.classList.add("litrev-wizard-card__head");
      const title = header.querySelector("h2");
      if (title && titles[cardType]) { title.removeAttribute("title"); title.textContent = titles[cardType]; }
      const description = header.querySelector(".description");
      const bodyDescription = body.querySelector(":scope > .card-description");
      description?.remove(); bodyDescription?.remove();
      if (titles[cardType]) {
        if (helpText[cardType]) body.prepend(descriptionHelp(hints[cardType], node("p", "description", helpText[cardType])));
        else if (hints[cardType]) body.prepend(node("p", "litrev-section-hint", hints[cardType]));
      }
      const actionGroups = actions ? Array.from(actions.querySelectorAll(":scope > div")) : [];
      const cancel = actionGroups.length > 1
        ? actionGroups[0].querySelector("button")
        : header.querySelector(":scope > button.close");
      if (cancel) {
        const controls = node("div", "litrev-wizard-card__head-actions");
        if (cardType === "review-spec") {
          const fold = node("button", "review-spec__fold");
          fold.type = "button";
          fold.innerHTML = chevronSvg;
          fold.setAttribute("aria-controls", "review-spec-fields");
          fold.addEventListener("click", () => {
            scopeCollapsed = !scopeCollapsed;
            applyScopeCollapse();
            parent.postMessage({ type: "memmy.plugin.resize", version: 1, height: scopeHeight(), collapsed: scopeCollapsed }, "*");
          });
          controls.append(fold);
        }
        cancel.className = "litrev-wizard-card__close";
        cancel.innerHTML = closeSvg;
        cancel.setAttribute("aria-label", "返回聊天调整");
        cancel.title = "返回聊天调整";
        controls.append(cancel);
        header.append(controls);
      }
      if (actions) {
        actions.classList.add("litrev-wizard-card__foot");
        const confirm = actionGroups.at(-1)?.querySelector("button");
        if (confirm) {
          confirm.classList.add("button", "button-primary", "button-sm");
          if (confirms[cardType]) confirm.textContent = confirms[cardType];
        }
      }
    }
    // Keep submission errors visible beside the footer rather than inside a scrolled list.
    const error = app.querySelector(":scope > .error");
    if (error && actions && error.nextElementSibling !== actions) actions.before(error);
    applyScopeCollapse();
    return body;
  }
  function restoreKeywordRow(row) {
    row.classList.add("litrev-keyword-row");
    const selected = row.querySelector('input[type="checkbox"]');
    if (selected && !selected.closest(".litrev-keyword-row__select")) {
      const label = node("label", "litrev-keyword-row__select");
      selected.before(label);
      label.append(selected, checkboxGlyph(selected.checked));
    }
    const mark = row.querySelector(".litrev-keyword-row__select .litrev-checkbox");
    if (selected && mark) setGlyph(mark, selected.checked);
    row.classList.toggle("litrev-keyword-row--unselected", selected?.checked === false);
    const term = row.querySelector('input[type="text"]');
    if (term) {
      if (term.parentElement !== row && term.parentElement?.parentElement === row) {
        const field = term.parentElement;
        field.before(term); field.remove();
      }
      term.title = term.value; term.setAttribute("aria-label", "关键词");
    }
    let divider = row.querySelector(":scope > .litrev-keyword-row__divider");
    if (!divider) {
      divider = node("span", "litrev-keyword-row__divider");
      if (term) term.after(divider); else row.append(divider);
    }
    const weight = row.querySelector(".weight-field, .litrev-keyword-row__weight");
    if (weight) {
      // The installed plugin hides `.weight-field > span` and draws its own
      // left border. This row already has the original card's divider.
      weight.classList.remove("weight-field");
      weight.classList.add("litrev-keyword-row__weight");
      const box = weight.querySelector(".weight");
      if (box) { weight.append(...Array.from(box.children)); box.remove(); }
      const range = weight.querySelector('input[type="range"]');
      if (range) weight.style.setProperty("--litrev-weight-progress", `${(Number(range.value) - 1) / 9 * 100}%`);
    }
    const aliases = row.querySelector(".aliases");
    aliases?.querySelector("input")?.setAttribute("aria-label", "同义词（逗号分隔）");
    let details = row.querySelector(".review-keyword-details");
    if (!details && aliases) {
      details = aliases.tagName === "DETAILS" ? aliases : node("details", "review-keyword-details");
      details.classList.add("review-keyword-details");
      const summary = details.querySelector(":scope > summary") || node("summary");
      summary.innerHTML = moreSvg;
      summary.setAttribute("aria-label", "编辑同义词或删除关键词");
      summary.title = "编辑同义词或删除关键词";
      if (details !== aliases) details.append(summary, aliases);
      const remove = row.querySelector(":scope > button.danger");
      if (remove) details.append(remove);
      if (details !== aliases) row.append(details);
      details.addEventListener("toggle", () => { if (details.open) summary.textContent = "同义词与编辑"; else summary.innerHTML = moreSvg; });
    }
  }
  function restoreAddForm(body, originalButton) {
    if (!originalButton || body.querySelector(".litrev-keyword-add-form")) return;
    const form = node("form", "litrev-keyword-add-form");
    const row = node("div", "litrev-keyword-add-row");
    const field = node("div", "litrev-keyword-add-row__field");
    const draft = node("input"); draft.type = "text"; draft.maxLength = 100;
    draft.placeholder = "输入新关键词后回车"; draft.setAttribute("aria-label", "新关键词");
    const count = node("small", "", "0 / 100");
    field.append(draft, count);
    const weight = node("label", "litrev-keyword-row__weight");
    const range = node("input"); range.type = "range"; range.min = "1"; range.max = "10"; range.value = "6";
    range.setAttribute("aria-label", "新关键词权重");
    const value = node("output", "", "6");
    weight.style.setProperty("--litrev-weight-progress", `${5 / 9 * 100}%`);
    range.addEventListener("input", () => { value.textContent = range.value; weight.style.setProperty("--litrev-weight-progress", `${(Number(range.value) - 1) / 9 * 100}%`); });
    weight.append(node("span", "", "权重"), range, value);
    row.append(checkboxGlyph(true), field, node("span", "litrev-keyword-row__divider"), weight);
    originalButton.className = "button button-secondary button-sm";
    originalButton.innerHTML = `${plusSvg}<span>添加关键词</span>`;
    originalButton.disabled = true;
    draft.addEventListener("input", () => { count.textContent = `${draft.value.length} / 100`; originalButton.disabled = !draft.value.trim(); });
    let addition = null;
    originalButton.addEventListener("click", (event) => {
      const text = draft.value.trim();
      if (!text) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      addition = { text, previousCount: app.querySelectorAll(".keyword-row").length, weight: range.value };
    }, true);
    // Registered after the plugin's original click handler, which synchronously creates the row.
    // A microtask in the capture phase can run before that handler for a real pointer click.
    originalButton.addEventListener("click", () => {
        if (!addition) return;
        const { text, previousCount, weight: nextWeight } = addition;
        addition = null;
        const rows = app.querySelectorAll(".keyword-row");
        if (rows.length !== previousCount + 1) return;
        const added = rows[rows.length - 1];
        const addedTerm = added.querySelector('input[type="text"]');
        const addedWeight = added.querySelector('input[type="range"]');
        if (addedTerm) { addedTerm.value = text; addedTerm.dispatchEvent(new Event("input", { bubbles: true })); }
        if (addedWeight) { addedWeight.value = nextWeight; addedWeight.dispatchEvent(new Event("input", { bubbles: true })); }
        schedule();
        requestAnimationFrame(() => {
          const nextBody = app.querySelector(".litrev-wizard-card__body");
          if (nextBody) nextBody.scrollTop = nextBody.scrollHeight;
          app.querySelector('.litrev-keyword-add-form input[type="text"]')?.focus({ preventScroll: true });
        });
    });
    form.addEventListener("submit", (event) => { event.preventDefault(); originalButton.click(); });
    form.append(row, originalButton);
    body.append(form);
  }
  function restoreKeywords(body) {
    const rows = Array.from(body.querySelectorAll(".keyword-row"));
    if (!rows.length && cardType !== "keywords") return;
    const list = body.querySelector(".scroll");
    list?.classList.add("litrev-keyword-rows");
    rows.forEach(restoreKeywordRow);
    let selection = body.querySelector(".review-keyword-selection");
    if (!selection) {
      selection = node("label", "review-keyword-selection litrev-keyword-select-all");
      const all = node("input"); all.type = "checkbox"; all.setAttribute("aria-label", "全选关键词");
      all.addEventListener("change", () => {
        for (const row of app.querySelectorAll(".keyword-row")) {
          const box = row.querySelector('input[type="checkbox"]');
          if (box) { box.checked = all.checked; box.dispatchEvent(new Event("change", { bubbles: true })); }
        }
      });
      selection.append(all, checkboxGlyph(false), node("strong", "", "全选"), node("output"));
      if (list) list.before(selection); else body.prepend(selection);
    }
    const enabled = rows.filter((row) => row.querySelector('input[type="checkbox"]')?.checked).length;
    const box = selection.querySelector("input");
    box.checked = rows.length > 0 && enabled === rows.length;
    box.indeterminate = enabled > 0 && enabled < rows.length;
    setGlyph(selection.querySelector(".litrev-checkbox"), box.checked);
    selection.querySelector("output").textContent = `${enabled} / ${rows.length}`;
    const toolbar = body.querySelector(":scope > .toolbar");
    if (toolbar) {
      const originalButton = toolbar.querySelector("button");
      restoreAddForm(body, originalButton);
      const meta = toolbar.querySelector(".meta");
      if (meta) body.querySelector(".review-description__tooltip")?.append(meta);
      toolbar.remove();
    }
  }
  function restoreOutline(body) {
    if (cardType !== "outline") return;
    const description = body.querySelector(":scope > .review-description");
    if (description) description.replaceWith(node("p", "litrev-section-hint", hints.outline));
    const list = body.querySelector(".scroll");
    list?.classList.add("litrev-outline-rows");
    const toolbar = body.querySelector(":scope > .toolbar");
    if (toolbar) {
      body.append(toolbar);
      const add = toolbar.querySelector("button");
      if (add) { add.classList.add("button", "button-secondary", "button-sm"); add.innerHTML = `${plusSvg}<span>添加一级大纲</span>`; }
      toolbar.querySelector(".meta")?.remove();
    }
    const restoreRow = (row, guidance, addChild) => {
      if (!row || row.querySelector(":scope > .litrev-outline-row__actions")) return;
      row.classList.add("litrev-outline-row");
      if (row.classList.contains("child")) row.classList.add("litrev-outline-row--child");
      row.querySelector(".outline-number")?.remove();
      row.prepend(node("span", "litrev-outline-row__marker"));
      const handle = row.querySelector(".drag-handle");
      if (handle) { handle.classList.add("litrev-outline-row__grip"); handle.innerHTML = gripSvg; }
      const actions = node("div", "litrev-outline-row__actions");
      const tools = row.querySelector(":scope > .outline-tools");
      if (guidance) {
        const notes = guidance.closest(".outline-notes");
        const panel = node("div", "review-outline-guidance");
        panel.id = `review-outline-guidance-${++guidanceSequence}`;
        panel.hidden = true;
        panel.append(guidance);
        if (row.classList.contains("child")) row.append(panel); else row.after(panel);
        const edit = node("button", "litrev-icon-button litrev-icon-button--edit"); edit.type = "button"; edit.innerHTML = guidanceSvg;
        edit.title = "编辑写作要求"; edit.setAttribute("aria-label", "编辑写作要求");
        edit.setAttribute("aria-controls", panel.id); edit.setAttribute("aria-expanded", "false");
        edit.addEventListener("click", () => {
          panel.hidden = !panel.hidden;
          row.classList.toggle("litrev-outline-row--guidance-open", !panel.hidden);
          edit.setAttribute("aria-expanded", String(!panel.hidden));
          edit.title = panel.hidden ? "编辑写作要求" : "收起写作要求";
          if (!panel.hidden) guidance.focus({ preventScroll: true });
          schedule();
        });
        actions.append(edit);
        if (notes && !notes.querySelector("textarea, input")) notes.remove();
      }
      if (addChild) {
        addChild.innerHTML = plusSvg; addChild.title = "添加二级大纲"; addChild.setAttribute("aria-label", "添加二级大纲");
        addChild.className = "litrev-icon-button litrev-icon-button--add"; actions.append(addChild);
      }
      const level = tools?.querySelector('button[aria-label="降为二级标题"], button[aria-label="升为一级标题"]');
      level?.remove();
      const remove = row.querySelector(":scope > button.danger") || tools?.querySelector("button.danger");
      if (remove) {
        remove.setAttribute("aria-label", "删除章节"); remove.title = "删除章节"; remove.className = "litrev-icon-button litrev-icon-button--delete";
        remove.innerHTML = trashSvg;
        actions.append(remove);
      }
      if (tools && !tools.children.length) tools.remove();
      row.append(actions);
    };
    for (const panel of body.querySelectorAll(".outline-parent")) {
      const children = panel.querySelector(":scope > .children");
      const head = panel.querySelector(".outline-head");
      restoreRow(head,
        panel.querySelector(":scope > textarea") || panel.querySelector(":scope > .outline-notes textarea"),
        children?.querySelector(":scope > button.secondary") || head?.querySelector('.outline-tools > button[aria-label="增加子标题"]'));
      for (const child of children?.querySelectorAll(".child") || []) {
        restoreRow(child, child.querySelector(":scope > .guidance") || child.querySelector(":scope > .outline-notes .guidance"), null);
      }
    }
  }
  function restoreReferences(body) {
    if (cardType !== "paper-selection") return;
    const list = body.querySelector(".scroll");
    if (!list) return;
    const toolbar = body.querySelector(":scope > .toolbar");
    if (toolbar && !toolbar.classList.contains("review-paper-controls")) {
      const search = toolbar.querySelector('input[type="search"]');
      const count = toolbar.querySelector(".count");
      if (search && count) {
        toolbar.classList.add("review-paper-controls");
        const row = node("div", "review-paper-controls__row");
        const actions = node("div", "review-paper-controls__actions");
        const searchPanel = node("div", "review-paper-controls__search");
        searchPanel.id = `review-paper-search-${++helpSequence}`;
        searchPanel.hidden = true;
        search.setAttribute("aria-label", "搜索文献");
        searchPanel.append(search);
        const searchToggle = node("button", "review-paper-controls__icon");
        searchToggle.type = "button"; searchToggle.innerHTML = searchSvg;
        searchToggle.title = "搜索文献"; searchToggle.setAttribute("aria-label", "搜索文献");
        searchToggle.setAttribute("aria-controls", searchPanel.id); searchToggle.setAttribute("aria-expanded", "false");
        searchToggle.addEventListener("click", () => {
          searchPanel.hidden = !searchPanel.hidden;
          searchToggle.setAttribute("aria-expanded", String(!searchPanel.hidden));
          if (!searchPanel.hidden) search.focus({ preventScroll: true });
          schedule();
        });
        const selectFullText = node("button", "review-paper-controls__fulltext", "勾选有全文");
        selectFullText.type = "button";
        selectFullText.title = "只勾选有全文的文献";
        selectFullText.addEventListener("click", () => {
          for (const paper of list.querySelectorAll(".paper")) {
            const box = paper.querySelector('input[type="checkbox"]');
            if (!box) continue;
            box.checked = paper.dataset.fulltext === "true";
            box.dispatchEvent(new Event("change", { bubbles: true }));
          }
          schedule();
        });
        actions.append(searchToggle, selectFullText);
        row.append(count, actions);
        toolbar.replaceChildren(row, searchPanel);
      }
    }
    list.classList.add("litrev-ref-table");
    let header = list.querySelector(".litrev-ref-table__head");
    if (!header) {
      header = node("div", "litrev-ref-table__head");
      const label = node("label", "litrev-ref-table__select-all");
      const select = node("input"); select.type = "checkbox"; select.setAttribute("aria-label", "全选当前文献");
      select.addEventListener("change", () => {
        for (const paper of list.querySelectorAll(".paper")) {
          if (paper.hidden) continue;
          const box = paper.querySelector('input[type="checkbox"]');
          box.checked = select.checked; box.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
      label.append(select, checkboxGlyph(false));
      header.append(node("span"), label, node("strong", "", "参考文献"), node("strong", "", "文献状态"));
      list.prepend(header);
    }
    const papers = Array.from(list.querySelectorAll(".paper"));
    papers.forEach((paper, index) => {
      if (!paper.classList.contains("litrev-ref-row")) {
        paper.classList.add("litrev-ref-row");
        const box = paper.querySelector('input[type="checkbox"]');
        const detail = paper.querySelector(".paper-title")?.parentElement;
        if (!box || !detail) return;
        const abstract = detail.querySelector("details");
        if (abstract) {
          abstract.classList.add("review-paper-abstract");
          const summary = abstract.querySelector("summary");
          if (summary) {
            summary.innerHTML = chevronSvg;
            const label = () => {
              summary.setAttribute("aria-label", abstract.open ? "收起摘要" : "展开摘要");
              summary.title = abstract.open ? "收起摘要" : "展开摘要";
            };
            label();
            abstract.addEventListener("toggle", label);
          }
        }
        const label = node("label", "litrev-ref-table__select-all");
        box.before(label); label.append(box, checkboxGlyph(box.checked));
        paper.prepend(node("span", "litrev-ref-row__index", String(index + 1)));
        detail.classList.add("litrev-ref-row__text");
        const title = detail.querySelector(".paper-title");
        if (title) title.setAttribute("title", title.textContent || "");
        const status = Array.from(detail.querySelectorAll(".availability")).at(-1);
        const sourceStatus = paper.querySelector(":scope > .source-status");
        const source = node("div", "litrev-ref-row__source");
        if (status) source.append(status);
        if (sourceStatus) source.append(sourceStatus);
        paper.append(source);
      }
      const checked = paper.querySelector('input[type="checkbox"]')?.checked === true;
      paper.classList.toggle("litrev-ref-row--selected", checked);
      const mark = paper.querySelector(".litrev-checkbox"); if (mark) setGlyph(mark, checked);
    });
    const shown = papers.filter((paper) => !paper.hidden);
    const enabled = shown.filter((paper) => paper.querySelector('input[type="checkbox"]')?.checked).length;
    const all = header.querySelector("input"); all.checked = shown.length > 0 && enabled === shown.length;
    all.indeterminate = enabled > 0 && enabled < shown.length;
    all.setAttribute("aria-label", all.checked ? "取消全选当前文献" : "全选当前文献");
    setGlyph(header.querySelector(".litrev-checkbox"), all.checked);
  }
  function restoreOtherCards(body) {
    app.dataset.reviewCardType = cardType;
    if (cardType === "review-spec") {
      body.querySelectorAll(".field").forEach((field) => {
        const label = field.querySelector("span");
        const input = field.querySelector("input,textarea,select");
        if (input && label) input.setAttribute("aria-label", label.textContent);
      });
    }
    if (cardType === "fulltext-recovery") {
      const help = body.querySelector(":scope > .review-description");
      if (help && !help.classList.contains("review-recovery-help")) {
        const descriptions = Array.from(body.querySelectorAll(":scope > .description"));
        const count = descriptions.find((item) => item.textContent.startsWith("已上传 "));
        help.classList.add("review-recovery-help");
        help.querySelector(".litrev-section-hint").textContent = count?.textContent || "补充缺失的全文";
        help.querySelector(".review-description__tooltip")?.replaceChildren(node("p", "", helpText[cardType]));
        descriptions.forEach((item) => item.remove());
      }
      body.querySelectorAll(".recovery-row").forEach((row, index) => {
        if (row.querySelector(".review-recovery-title")) return;
        const detail = row.querySelector(".recovery-detail");
        const title = detail?.querySelector(".paper-title");
        const reason = detail?.querySelector(".recovery-reason");
        const actions = row.querySelector(".recovery-actions");
        const copy = actions?.querySelector(".copy-button");
        const upload = actions?.querySelector("button:not(.copy-button)");
        const picker = actions?.querySelector('input[type="file"]');
        if (!detail || !title || !reason || !actions || !copy || !upload || !picker) return;
        row.prepend(node("span", "review-recovery-index", String(index + 1)));
        const titleLine = node("div", "review-recovery-title");
        title.before(titleLine);
        titleLine.append(title, copy);
        copy.classList.add("review-recovery-copy");
        copy.querySelector("span")?.classList.add("sr-only");
        copy.title = "复制全文链接";
        actions.querySelector(".badge")?.remove();
        const filename = reason.textContent.startsWith("已上传：") ? reason.textContent.slice(4) : "";
        const uploadPending = upload.textContent.includes("上传中") || upload.textContent.includes("替换中");
        row.classList.toggle("review-recovery-row--uploaded", Boolean(filename));
        if (filename) {
          const name = node("span", "review-recovery-file__name", filename);
          const check = node("span", "review-recovery-file__check");
          check.innerHTML = checkSvg;
          reason.classList.add("review-recovery-file");
          upload.classList.add("review-recovery-replace");
          upload.innerHTML = uploadPending ? "更换中…" : replaceSvg;
          upload.classList.toggle("review-recovery-replace--pending", uploadPending);
          upload.title = "更换全文文件";
          upload.setAttribute("aria-label", `更换“${title.textContent}”的全文文件`);
          reason.replaceChildren(check, name, picker, upload);
          actions.remove();
        } else {
          const original = reason.textContent;
          reason.title = original;
          if (original.includes("交互验证")) reason.textContent = "需在网页验证后下载";
          else if (original.includes("自动下载失败")) reason.textContent = "自动下载失败，请手动下载";
          else if (original.includes("白名单")) reason.textContent = "请在网页下载全文";
          else if (original.includes("插件无法自动获取")) reason.textContent = "需手动下载全文";
          else if (original.includes("解析失败")) reason.textContent = "解析失败，请换一个文件";
          upload.classList.add("review-recovery-upload");
          upload.innerHTML = uploadPending ? "上传中…" : `${uploadSvg}<span>上传</span>`;
          upload.title = "上传全文文件";
          upload.setAttribute("aria-label", `上传“${title.textContent}”的全文文件`);
        }
      });
    }
  }
  const update = () => {
    queued = false;
    observer.disconnect();
    try {
      if (!cardType && app.querySelector(".keyword-row")) cardType = "keywords";
      const body = restoreShell();
      if (body) { restoreKeywords(body); restoreOutline(body); restoreReferences(body); restoreOtherCards(body); }
      parent.postMessage({ type: "memmy.plugin.resize", version: 1,
        height: cardType === "review-spec" ? scopeHeight() : Math.ceil(document.body.scrollHeight),
        ...(cardType === "review-spec" ? { collapsed: scopeCollapsed } : {}) }, "*");
    } finally { observer.observe(app, { childList: true, subtree: true }); }
  };
  const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(update); } };
  const observer = new MutationObserver(schedule);
  observer.observe(app, { childList: true, subtree: true });
  app.addEventListener("change", schedule);
  app.addEventListener("input", schedule);
  app.addEventListener("toggle", schedule, true);
  window.addEventListener("message", (event) => {
    if (event.source !== parent || event.data?.type !== "memmy.plugin.render") return;
    const interaction = [...(event.data.events || [])].reverse().find((item) => item.type === "interaction");
    cardType = interaction?.request?.payload?.cardType || cardType;
    const nextInteractionId = interaction?.request?.interactionId || "";
    if (nextInteractionId && nextInteractionId !== scopeInteractionId) { scopeInteractionId = nextInteractionId; scopeCollapsed = false; }
    const height = event.data.presentation?.maxHeight;
    if (typeof height === "number" && Number.isFinite(height)) document.documentElement.style.setProperty("--review-card-max-height", `${Math.max(220, Math.min(680, height))}px`);
    schedule();
  });
  schedule();
})();
