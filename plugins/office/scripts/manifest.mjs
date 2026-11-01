import packageInfo from "../package.json" with { type: "json" };

export const formats = ["docx", "pdf", "pptx", "xlsx"];
const string = { type: "string", minLength: 1 };
const file = { taskId: string, file: string };
const capability = (id, description, properties, required = []) => ({
  id, name: id.replaceAll("_", " "), description, execution: "request",
  inputSchema: { type: "object", additionalProperties: false, properties, required },
  outputSchema: { type: "object" }
});
export const manifest = {
  apiVersion: "memmy/v1", id: "office", name: "Office", version: packageInfo.version,
  rules: { distribution: "public", installation: "manual", requiresLogin: false,
    unavailableVisibility: "visible", autoUpdate: true, recommendsOfficialModel: false },
  runtime: { adapter: "command", config: { command: "runtime/main.cjs", interpreter: "node",
    inputMode: "stdin-json", outputMode: "ndjson", runtimeDependencies: ["office"],
    timeoutMs: 300000, maxOutputBytes: 16777216, sandbox: "required" } },
  permissions: [{ type: "host-service", services: ["plugin-data", "file-input", "artifact-host"],
    description: "读取用户上传的办公文件，在插件专属目录中处理，并将最终文件交付到当前会话。" }],
  skills: formats.map(format => ({ id: `office-${format}`, name: `Office ${format.toUpperCase()}`,
    description: `Create, inspect, edit, render and deliver ${format.toUpperCase()} files through the Office plugin.`,
    entry: `skills/office-${format}/SKILL.md` })),
  capabilities: [
    capability("office_status", "Check supported operations and whether LibreOffice/Poppler are available before starting. Missing runtimes must be reported, never treated as successful QA.", {}),
    capability("office_import", "Copy an uploaded DOCX/PDF/PPTX/XLSX/CSV/TSV into an isolated task. Keep the original unchanged. Returns taskId and file name for later operations.", { path: string }, ["path"]),
    capability("office_execute", "Advanced Office authoring/editing: run an async JavaScript body with preloaded docx, ExcelJS, PptxGenJS, JSZip, PDFLib, DOMParser, XMLSerializer, fs, path and workspace. A fresh task copies selected inputFiles from sourceTaskId. Code runs in a child with Node filesystem permissions, no network/child processes/native addons. Write files inside workspace and return {files:[names]}. All outputs are inspected; render/review/deliver separately. Use this for tables, charts, templates, tracked changes, comments, PDF merging/forms and operations beyond office_create/office_edit.", {
      sourceTaskId: string, inputFiles: { type: "array", maxItems: 30, uniqueItems: true, items: string },
      code: { type: "string", minLength: 1, maxLength: 100000 }
    }, ["code"]),
    capability("office_create", "Create Word/PDF from title and paragraphs, PowerPoint from slides, or Excel from sheets. Returns taskId and file; render and review before office_deliver.", {
      format: { enum: formats }, name: string, title: { type: "string" },
      paragraphs: { type: "array", maxItems: 1000, items: { type: "string" } },
      slides: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", additionalProperties: false,
        properties: { title: string, body: { type: "array", items: { type: "string" }, maxItems: 50 }, notes: { type: "string" } }, required: ["title", "body"] } },
      sheets: { type: "array", minItems: 1, maxItems: 50, items: { type: "object", additionalProperties: false,
        properties: { name: string, rows: { type: "array", maxItems: 10000, items: { type: "array", maxItems: 200,
          items: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" },
            { type: "object", additionalProperties: false, properties: { formula: string }, required: ["formula"] }] } } } }, required: ["name", "rows"] } }
    }, ["format", "name"]),
    capability("office_inspect", "Read document text and structural checks. Excel returns formulas and cached results. This is not visual QA.", file, ["taskId", "file"]),
    capability("office_edit", "Make exact text replacements in DOCX/PPTX or set explicit Excel cells while preserving untouched ZIP parts. Refuse edits with no match. PDF editing uses conversion or recreation. Always creates a new file.", {
      ...file, name: string,
      replacements: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", additionalProperties: false,
        properties: { from: string, to: { type: "string" } }, required: ["from", "to"] } },
      cells: { type: "array", minItems: 1, maxItems: 10000, items: { type: "object", additionalProperties: false,
        properties: { sheet: string, address: { type: "string", pattern: "^[A-Z]{1,3}[1-9][0-9]{0,6}$" }, value: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }] }, formula: string }, required: ["sheet", "address"] } }
    }, ["taskId", "file", "name"]),
    capability("office_convert", "Convert Office files to PDF, or CSV/TSV to XLSX, using isolated LibreOffice. Excel normalization/recalculation requires allowLossy=true because LibreOffice may change unsupported objects. Refuse macro files.", {
      ...file, format: { enum: ["pdf", "xlsx"] }, allowLossy: { type: "boolean" },
      csv: { type: "object", additionalProperties: false, properties: {
        delimiter: { enum: [",", ";", "\t"] }, encoding: { enum: ["UTF-8"] }, bom: { enum: ["present", "absent"] },
        quote: { const: "\"" }, newline: { enum: ["lf", "crlf"] }, malformedRows: { const: "reject" }
      }, required: ["delimiter", "encoding", "bom", "quote", "newline", "malformedRows"] }
    }, ["taskId", "file", "format"]),
    capability("office_render", "Render the actual file to PDF and PNG pages. Returns page count and revision. Use office_review_page for EVERY page to see actual images before office_deliver.", file, ["taskId", "file"]),
    capability("office_review_page", "View one rendered PNG page as an image in the tool response. Inspect each page for overflow, missing glyphs, broken tables and layout defects before delivery.", {
      ...file, revision: string, page: { type: "integer", minimum: 1, maximum: 200 }
    }, ["taskId", "file", "revision", "page"]),
    capability("office_deliver", "Deliver a structurally checked file only after all rendered pages have been inspected. Pass the revision and exact reviewedPages from office_render. Any edit invalidates the previous review. Publishes a preview/download and a workspace output.", {
      ...file, revision: string, reviewedPages: { type: "array", minItems: 1, uniqueItems: true, items: { type: "integer", minimum: 1 } }, reviewNotes: string
    }, ["taskId", "file", "revision", "reviewedPages", "reviewNotes"])
  ]
};
