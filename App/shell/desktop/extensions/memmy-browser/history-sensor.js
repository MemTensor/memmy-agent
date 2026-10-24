/* Generated from App/memmy-agent/src/tools/computer-history/browser-history-sensor.ts. */
"use strict";
(() => {
  globalThis.__memmyInstallBrowserHistorySensor = function browserHistorySensor(config, publish) {
    const page = globalThis;
    const bindingName = config.bindingName ?? "__memmyBrowserHistory";
    if (!/^[A-Za-z_$][\w$]{0,80}$/u.test(bindingName) || typeof config.generation !== "string" || config.generation.length > 200
        || !/^[A-Za-z0-9._:-]{1,200}$/u.test(config.documentId))
        throw new Error("Invalid browser History sensor configuration");
    const document = page.document, location = page.location, slot = "__memmyBrowserHistorySensor";
    page[slot]?.stop?.();
    const controller = new page.AbortController(), timers = new Set(), pendingInputs = new Map(), pendingActions = new Map();
    let stopped = false, sequence = 0, scrollTimer = null, previousUrl = location.href, lastUserInput = 0;
    const luhn = (digits) => {
        let sum = 0;
        for (let index = 0; index < digits.length; index++) {
            let digit = Number(digits[digits.length - 1 - index]);
            if (index % 2) {
                digit *= 2;
                if (digit > 9)
                    digit -= 9;
            }
            sum += digit;
        }
        return sum % 10 === 0;
    };
    // Bound the input before any regex: an interaction must not scan a whole page's text.
    const clean = (value) => String(value ?? "").slice(0, 2_000).replace(/\s+/gu, " ").trim().slice(0, 500)
        .replace(/\bBearer\s+[a-z0-9._~+/-]{12,}/giu, "Bearer [REDACTED]")
        .replace(/\bsk-[a-z0-9_-]{12,}\b/giu, "[REDACTED]")
        .replace(/((?:api[ _-]?key|access[ _-]?token|auth[ _-]?token|password|secret|验证码|动态码|密码|口令|密钥)\s*[:：=]\s*)[^\s,;]+/giu, "$1[REDACTED]")
        .replace(/((?:otp|verification code|验证码|动态码|校验码)\s*[:：=]?\s*)\d{4,8}\b/giu, "$1[REDACTED]")
        .replace(/\b\d(?:[ -]?\d){12,18}\b/gu, match => luhn(match.replace(/\D/gu, "")) ? "[REDACTED]" : match);
    const safeUrl = () => {
        const url = new page.URL(location.href);
        url.search = "";
        url.hash = "";
        url.username = "";
        url.password = "";
        return url.href;
    };
    const sensitive = (el) => !!el && (el.type === "password" || el.type === "hidden"
        || /one-time-code|current-password|new-password|cc-number|cc-csc|cc-exp/iu.test(el.autocomplete || "")
        || /password|passcode|secret|token|otp|one[-_ ]?time|verification|cvv|cvc|card[-_ ]?(?:number|no)|验证码|动态码|校验码|安全码|密码|口令|密钥|卡号|身份证/iu
            .test([el.name, el.id, el.getAttribute?.("aria-label"), el.getAttribute?.("placeholder")].join(" ")));
    // The first visible-text characters of an element, without serializing its subtree.
    const brief = (el, limit) => {
        if (typeof document.createTreeWalker !== "function")
            return "";
        const walker = document.createTreeWalker(el, 4);
        let text = "", node, visited = 0;
        while ((node = walker.nextNode()) && text.length < limit && visited++ < 200) {
            if (!/^(?:SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/u.test(node.parentElement?.tagName))
                text += " " + node.nodeValue;
        }
        return text.slice(0, limit);
    };
    const control = (el, tag) => /^(?:button|a|summary|option|label|legend)$/u.test(tag)
        || /^(?:button|link|menuitem|menuitemcheckbox|menuitemradio|tab|option|checkbox|radio|switch|treeitem)$/u.test(el.getAttribute("role") || "");
    const metadata = (el) => {
        if (!el || el.nodeType !== 1)
            return undefined;
        const secret = sensitive(el), tag = el.tagName.toLowerCase();
        const name = clean(el.getAttribute("aria-label") || el.labels?.[0]?.innerText || el.getAttribute("title")
            || el.getAttribute("placeholder") || ((secret || tag === "input" || tag === "textarea" || el.isContentEditable) ? ""
            : control(el, tag) ? el.innerText : brief(el, 160)));
        const roles = { button: "button", a: "link", select: "combobox", textarea: "textbox" };
        const role = el.getAttribute("role") || roles[tag] || (tag === "input" ? (/checkbox|radio/u.test(el.type) ? el.type : "textbox") : "generic");
        const result = { role: clean(role), name, tag, inputType: clean(el.type), autocomplete: clean(el.autocomplete), sensitive: secret };
        if ("checked" in el)
            result.checked = !!el.checked;
        else if (["true", "false"].includes(el.getAttribute("aria-checked")))
            result.checked = el.getAttribute("aria-checked") === "true";
        if ("selected" in el)
            result.selected = !!el.selected;
        else if (["true", "false"].includes(el.getAttribute("aria-selected")))
            result.selected = el.getAttribute("aria-selected") === "true";
        if (el.hasAttribute("aria-expanded"))
            result.expanded = el.getAttribute("aria-expanded") === "true";
        // Secret values are never read into the binding/message payload.
        if ("value" in el || el.isContentEditable)
            result.value = secret || !config.captureText ? "[REDACTED]"
                : clean(el.isContentEditable ? brief(el, 600) : el.value);
        return result;
    };
    const state = (el) => {
        const target = metadata(el), secret = sensitive(el);
        const scope = el?.closest?.('[role="dialog"], form, [role="region"], main') || el?.parentElement;
        let text = [];
        if (secret || !config.captureText)
            text = ["[REDACTED]"];
        else if (scope && typeof document.createTreeWalker === "function") {
            const walker = document.createTreeWalker(scope, 4); // SHOW_TEXT; no hidden HTML/script extraction.
            // Sibling text shares ancestors; decide each ancestor's visibility once.
            const hiddenAncestors = new Map();
            const hiddenAncestor = (ancestor) => {
                if (!hiddenAncestors.has(ancestor)) {
                    const style = page.getComputedStyle(ancestor);
                    hiddenAncestors.set(ancestor, /^(?:SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/u.test(ancestor.tagName) || sensitive(ancestor)
                        || ancestor.hidden || ancestor.getAttribute?.("aria-hidden") === "true" || ancestor.hasAttribute?.("inert")
                        || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse");
                }
                return hiddenAncestors.get(ancestor);
            };
            let node, visited = 0;
            while ((node = walker.nextNode()) && text.length < 12 && visited++ < 300) {
                const parent = node.parentElement;
                if (!parent || !parent.getClientRects?.().length)
                    continue;
                let blocked = false;
                for (let ancestor = parent; ancestor; ancestor = ancestor.parentElement) {
                    if (hiddenAncestor(ancestor)) {
                        blocked = true;
                        break;
                    }
                    if (ancestor === scope)
                        break;
                }
                if (blocked)
                    continue;
                const range = document.createRange();
                range.selectNodeContents(node);
                const visible = [...range.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0
                    && rect.bottom > 0 && rect.right > 0 && rect.top < page.innerHeight && rect.left < page.innerWidth);
                if (!visible)
                    continue;
                // Read text only after establishing it belongs to a visible, non-secret node.
                const value = clean(node.nodeValue);
                if (value)
                    text.push(value);
            }
        }
        return { url: safeUrl(), title: secret ? "[REDACTED]" : clean(document.title), text, ...(target ? { target } : {}) };
    };
    const nextId = () => "dom-" + (page.crypto?.randomUUID?.() || Date.now() + "-" + (++sequence));
    const emit = (action, el, before, key, phase = "observed", interactionId) => {
        if (stopped || (!publish && typeof page[bindingName] !== "function"))
            return;
        const target = metadata(el), after = phase === "attempt" ? undefined : state(el);
        const payload = { version: 1, eventId: nextId(), observedAt: Date.now(),
            generation: config.generation, documentId: config.documentId, action, phase, ...(interactionId ? { interactionId } : {}),
            ...(target ? { target } : {}), ...(before ? { before } : {}), ...(after ? { after } : {}),
            ...(key ? { key: key.length === 1 || sensitive(el) ? "[REDACTED]" : clean(key) } : {}) };
        const encoded = JSON.stringify(payload);
        if (encoded.length <= 24_000) {
            if (publish)
                publish(payload);
            else
                page[bindingName](encoded);
        }
    };
    const later = (fn, delay = 180) => {
        const timer = page.setTimeout(() => { timers.delete(timer); if (!stopped)
            fn(); }, delay);
        timers.add(timer);
        return timer;
    };
    const element = (event) => {
        const el = event.composedPath?.().find((node) => node?.nodeType === 1) || event.target;
        return el?.tagName === "LABEL" && el.control ? el.control : el;
    };
    const listen = (name, fn) => page.addEventListener(name, fn, { capture: true, passive: true, signal: controller.signal });
    const rememberBefore = (event) => {
        if (!event.isTrusted)
            return;
        lastUserInput = Date.now();
        const el = element(event);
        if (pendingActions.size >= 128)
            pendingActions.delete(pendingActions.keys().next().value);
        const pending = { before: state(el), at: Date.now(), interactionId: nextId() };
        pendingActions.set(el, pending);
        return pending;
    };
    listen("pointerdown", event => {
        const pending = rememberBefore(event);
        if (pending)
            emit("click", element(event), pending.before, undefined, "attempt", pending.interactionId);
    });
    for (const name of ["click", "change", "submit"])
        listen(name, event => {
            if (!event.isTrusted)
                return;
            const el = element(event);
            // Native checkbox/radio pre-activation happens before click listeners. Record the change once,
            // using pointer/key state from before activation rather than another toggle instruction.
            if (name === "click" && /^(?:checkbox|radio)$/u.test(el?.type))
                return;
            const remembered = pendingActions.get(el);
            pendingActions.delete(el);
            const pending = remembered && Date.now() - remembered.at <= 1500 ? remembered : undefined;
            const before = pending?.before ?? state(el);
            later(() => emit(name, el, before, undefined, "observed", pending?.interactionId));
        });
    listen("beforeinput", event => {
        if (!event.isTrusted)
            return;
        const el = element(event);
        if (!pendingInputs.has(el))
            pendingInputs.set(el, { before: state(el), timer: null });
    });
    listen("input", event => {
        if (!event.isTrusted)
            return;
        const el = element(event);
        if (/^(?:checkbox|radio)$/u.test(el?.type) || el?.tagName === "SELECT")
            return;
        const pending = pendingInputs.get(el) || { before: undefined, timer: null };
        if (pending.timer) {
            page.clearTimeout(pending.timer);
            timers.delete(pending.timer);
        }
        pending.timer = later(() => { pendingInputs.delete(el); emit("input", el, pending.before); }, 400);
        pendingInputs.set(el, pending);
    });
    for (const name of ["wheel", "touchmove"])
        listen(name, event => { if (event.isTrusted)
            lastUserInput = Date.now(); });
    listen("keydown", event => {
        if (event.isTrusted)
            lastUserInput = Date.now();
        // A held key repeats many times a second; its first press is the step.
        if (event.repeat)
            return;
        const pending = event.isTrusted && ["Enter", " ", "Spacebar"].includes(event.key) ? rememberBefore(event) : undefined;
        if (pending && event.key === "Enter")
            emit("key", element(event), pending.before, event.key, "attempt", pending.interactionId);
        if (!event.isTrusted || !["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key))
            return;
        const el = element(event), before = pending?.before ?? state(el);
        later(() => emit("key", el, before, event.key, "observed", pending?.interactionId));
    });
    listen("scroll", event => {
        // Pages scroll themselves (live feeds, streamed answers); only user scrolling is a step.
        if (Date.now() - lastUserInput > 1_000)
            return;
        if (scrollTimer) {
            page.clearTimeout(scrollTimer);
            timers.delete(scrollTimer);
        }
        scrollTimer = later(() => { scrollTimer = null; emit("scroll", element(event)); }, 500);
    });
    for (const name of ["popstate", "hashchange"])
        listen(name, () => {
            if (previousUrl === location.href)
                return;
            previousUrl = location.href;
            later(() => emit("navigation"));
        });
    page[slot] = { stop() {
            stopped = true;
            controller.abort();
            for (const timer of timers)
                page.clearTimeout(timer);
            timers.clear();
            pendingInputs.clear();
            pendingActions.clear();
            delete page[slot];
        } };
    // A newly authorized document supplies context, without claiming which action caused it.
    emit("navigation", undefined, undefined, undefined, "context");
    return true;
};
})();
