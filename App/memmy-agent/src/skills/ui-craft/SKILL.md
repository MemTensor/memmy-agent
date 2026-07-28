---
name: ui-craft
description: Design, build, redesign, or modify browser-visible web interfaces with product-quality composition, visual systems, interaction states, responsive behavior, accessibility, and browser visual QA. Use for HTML, CSS, JavaScript, React, Vue, or Svelte pages and components, landing pages, dashboards, admin tools, settings, forms, onboarding, responsive layouts, prototypes, and any frontend change that alters visible browser output.
---

# UI Craft

Create an intentional interface, not merely valid frontend code. Make the page fit its product, help the user act, and hold up under real browser inspection.

## Establish the design brief

Before editing, identify:

- the user and the situation in which they reach this interface;
- the primary job, decision, or action the interface must support;
- the information that must be noticed first, second, and later;
- the dominant behavior: scan, operate, enter, compare, learn, or explore;
- the important default, loading, empty, error, success, disabled, and permission states;
- the target viewports, input methods, accessibility needs, and engineering constraints.

Ask a small number of focused questions only when a missing answer would materially change the result. Otherwise proceed with conservative assumptions and preserve the user's scope.

## Read the existing visual language

Inspect the rendered page and the source that actually defines it. Read relevant:

- routes and page composition;
- layout shells and navigation;
- theme, token, and global style files;
- nearby components and their variants;
- typography, icons, imagery, and other assets;
- copy conventions and product terminology;
- responsive rules and existing breakpoints.

Treat the repository as the source of truth. Reuse its components and tokens before adding new ones. Do not introduce a parallel palette, spacing scale, radius family, shadow language, or component pattern for one screen.

Preserve the established product language unless the request explicitly calls for a redesign. If the current interface is inconsistent, improve the requested surface without casually rewriting unrelated global styles.

## Choose the composition before decoration

Let the dominant user behavior determine the page structure:

- For scanning or monitoring, favor density, stable alignment, glanceable status, and clear exceptions.
- For operating or managing, favor selection state, nearby actions, feedback, and efficient repeated work.
- For entering or configuring, favor grouping, progressive disclosure, validation, and a clear completion path.
- For comparing, align equivalent information and make differences easy to inspect.
- For learning or deciding, build a paced narrative with one clear idea or action at a time.
- For exploring, make search, filters, results, preview, and wayfinding the primary composition.

Do not give every product surface a marketing hero. Do not default to a centered heading followed by three equal cards. Choose what should dominate, what should support it, and what should recede.

Form a one-sentence visual thesis before implementation. State the intended hierarchy, density, and tone, for example: “A compact operational surface where exceptions lead, controls stay close to data, and color is reserved for state.” Use the thesis to reject choices that do not belong.

## Build a coherent visual system

Use a small number of deliberate decisions consistently.

When no established system exists, define the smallest useful set of local tokens for color, type, spacing, shape, and depth before styling individual components. Keep the system proportional to the deliverable.

### Hierarchy and layout

- Establish hierarchy with scale, position, spacing, alignment, weight, and contrast before adding containers.
- Use whitespace to group and separate information, not simply to make the page airy.
- Align related content to a shared grid.
- Vary emphasis according to importance; avoid making every section, card, and action equally loud.
- Keep the primary action easy to find without turning every control into a primary button.
- Prefer content-driven dimensions over fragile fixed heights and viewport assumptions.

### Typography

- Reuse the product type system when one exists.
- Choose a compact type scale with clear roles for display, heading, body, label, metadata, and numeric content.
- Use weight and size intentionally; do not rely on low-contrast gray text for the entire hierarchy.
- Keep line length, line height, wrapping, and truncation readable at each viewport.
- Use monospace only for content that benefits from it.

### Color, shape, and depth

- Reuse semantic color tokens and verify important text and controls have sufficient contrast.
- Reserve saturated color for meaning, focus, or a small number of high-value accents.
- Use borders, surfaces, shadows, and elevation as one system; do not mix unrelated treatments.
- Keep radii consistent with the product and appropriate to component size.
- Avoid wrapping every group in a rounded card when spacing or a divider would communicate structure better.

### Imagery, icons, and motion

- Use supplied assets and the existing icon system when available.
- Add icons only when they improve recognition or scanning; do not use decorative icon badges as filler.
- Use motion to explain continuity, state change, or feedback.
- Keep motion brief and interruptible, and respect `prefers-reduced-motion`.
- Do not invent elaborate illustrations, fake screenshots, or stock imagery to fill an unresolved composition.

## Keep content honest

Use real provided content or realistic structure that does not invent product claims.

- Do not add fake metrics, testimonials, customers, integrations, or strategic claims.
- Do not add generic feature sections merely to fill space.
- Use specific labels and actions instead of vague words such as “Optimize,” “Insights,” or “Transform.”
- Preserve domain terminology from the product.
- Mark unavoidable placeholder copy clearly when it could be mistaken for final content.

## Implement the real interface

- Work in the repository's actual framework, component architecture, package manager, and styling approach.
- Implement the requested deliverable in runnable form. In an existing product, modify the actual route or component; create a standalone artifact only when the user requests one.
- Keep semantics meaningful and controls keyboard-accessible.
- Provide visible focus, hover, active, selected, disabled, loading, empty, error, and success behavior where applicable.
- Associate labels, descriptions, validation, and errors with the controls they explain.
- Keep touch targets usable and avoid interactions that depend only on hover.
- Make layout behavior intentional across relevant widths; do not treat mobile as a scaled-down desktop.
- Prevent clipping, overlap, accidental horizontal scroll, unreadable wrapping, and controls moving off-screen.
- Preserve working behavior while improving presentation. Do not trade correctness for visual novelty.
- Keep changes scoped and avoid unrelated refactors.

For exploratory work, create multiple directions only when the user requests alternatives or the visual direction is genuinely unresolved. Make each direction differ in composition, hierarchy, density, or interaction model—not only color. Keep experiments separate from production code until a direction is selected.

## Run the anti-template review

Inspect the rendered composition before polishing details. Look for:

- a page archetype copied from an unrelated use case;
- a centered intro or oversized headline where users need to act or scan;
- repeated equal-weight cards with no visual priority;
- excessive rounded containers, pills, icon tiles, or badges;
- arbitrary blue-purple gradients, glow, blur, or glass effects;
- decoration compensating for weak hierarchy;
- invented data or copy used as visual filler;
- every section using the same rhythm and proportions;
- default typography with no deliberate hierarchy;
- low-contrast text, tiny labels, or color carrying meaning alone;
- responsive layouts that merely stack everything without reconsidering priority.

Diagnose the cause before changing details:

- Recompose when the page structure or dominant behavior is wrong.
- Rebalance hierarchy when everything has equal emphasis.
- Remove decoration when it does not communicate meaning.
- Refine type, color, and spacing only when the underlying composition is sound.

Do not declare the interface polished while a structural problem remains.

## Browser visual QA

When the `browser_*` tools are available, complete the following workflow before declaring visible frontend work finished:

1. Classify the target by runtime needs, not by file count:
   - For independent static HTML whose files run as written without a build, backend, or application route, pass the permitted local `.html`/`.htm` path directly to `browser_navigate`.
   - For framework or service-backed work, start the project's existing development or preview command in the foreground with `yield_time_ms`, wait until it is ready, and use its HTTP or HTTPS route.
2. Use `browser_navigate` to open the real rendered page. Do not substitute source inspection for opening it.
3. Use `browser_snapshot` to inspect page structure, visible content, semantics, and important controls.
4. Exercise the primary interaction and important states with `browser_find`, `browser_click`, `browser_type`, `browser_select_option`, `browser_press_key`, or `browser_wait_for` as relevant.
5. Use `browser_console_messages` to inspect errors and meaningful warnings.
6. Use `browser_network_requests` to inspect failed, blocked, duplicated, or unexpected requests.
7. Use `browser_take_screenshot` and visually inspect the primary viewport.
8. Use `browser_resize` for at least one materially different relevant viewport, then repeat structural and screenshot inspection there.
9. Judge the screenshots, not merely the presence of DOM nodes. Check composition, hierarchy, alignment, spacing rhythm, typography, contrast, content density, clipping, overflow, control prominence, and visual consistency.
10. Run the anti-template review against the screenshots.
11. Fix every material issue and repeat the complete relevant sequence until the implementation and the rendered result are sound.
12. If this task started a development or preview service, terminate its Exec session after validation.

Treat console, network, snapshot, and screenshot checks as different evidence. A clean console does not prove the layout is good, and an attractive screenshot does not prove the interactions work.

If browser tools are unavailable, run the strongest static and project checks available and explicitly report that browser validation was not performed. Do not claim observations that were not made.

## Completion gate

Finish only when:

- the interface supports the primary user job and has a clear hierarchy;
- the visual choices form one coherent system and fit the surrounding product;
- relevant interaction and content states are implemented;
- accessibility and responsive behavior have been checked;
- project validation passes;
- browser structure, console, network, interactions, and screenshots have been inspected when tools are available;
- material visual problems found during review have been repaired and rechecked.

Report concisely:

- the visible outcome;
- the important design decisions;
- the files or routes changed;
- the viewport and interaction coverage;
- the browser and project validation performed;
- any remaining limitation that affects confidence.
