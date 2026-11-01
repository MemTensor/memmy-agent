import theme from "./literature-review-card-theme.css?raw";
import enhancement from "./literature-review-card-enhancement.js?raw";
import originalDesign from "./literature-review-original-cards.css?raw";

/** First-party presentation adapter; original inputs, validation and protocol remain in the plugin. */
export function themeLiteratureReviewCard(html: string): string {
  // Unknown/new renderers retain their layout rather than receiving incompatible selectors.
  if (!html.includes('id="app"') || !html.includes("function renderKeywords()")) return html;
  const additions = `<style data-memmy-review-theme>${originalDesign}\n${theme}</style><script>${enhancement}</script>`;
  return html.replace(/<\/body>/i, `${additions}</body>`);
}
