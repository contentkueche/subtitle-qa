import { SubtitleQAPanel } from "./ui/panel";

let panel: SubtitleQAPanel | undefined;

function ensurePanel(): void {
  if (!panel) {
    panel = new SubtitleQAPanel(document);
  }
}

try {
  const { entrypoints } = require("uxp");
  entrypoints.setup({
    panels: {
      subtitleQAPanel: {
        create() {
          ensurePanel();
        },
        show() {
          ensurePanel();
        }
      }
    }
  });
} catch (error) {
  ensurePanel();
  // Allows the panel HTML to be smoke-tested outside Premiere during development.
  console.warn("UXP entrypoints unavailable; running in development mode.", error);
}
