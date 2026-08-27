const BEGIN_PATCH = "*** Begin Patch";
const END_PATCH = "*** End Patch";
const END_OF_FILE = "*** End of File";
const ADD_FILE_PREFIX = "*** Add File: ";
const DELETE_FILE_PREFIX = "*** Delete File: ";
const UPDATE_FILE_PREFIX = "*** Update File: ";
const MOVE_TO_PREFIX = "*** Move to: ";

export type PatchHunkLine = {
  kind: "context" | "remove" | "add";
  text: string;
};

export type PatchHunk = {
  line: number;
  anchor: string | null;
  lines: PatchHunkLine[];
  endOfFile: boolean;
};

export type PatchAdd = {
  kind: "add";
  path: string;
  line: number;
  lines: string[];
};

export type PatchDelete = {
  kind: "delete";
  path: string;
  line: number;
};

export type PatchUpdate = {
  kind: "update";
  path: string;
  line: number;
  moveTo: string | null;
  moveLine: number | null;
  hunks: PatchHunk[];
};

export type PatchFileOperation = PatchAdd | PatchDelete | PatchUpdate;

export type PatchProgressFile = {
  kind: "add" | "update" | "delete";
  path: string;
  moveTo: string | null;
  added: number;
  deleted: number;
};

export class PatchError extends Error {}

type FileHeader = {
  kind: PatchProgressFile["kind"];
  path: string;
};

function normalizeLineEndings(input: string): string {
  return input.replace(/\r\n?/g, "\n");
}

function fail(line: number, message: string): never {
  throw new PatchError(`line ${line}: ${message}`);
}

function parseFileHeader(line: string, lineNumber: number): FileHeader | null {
  const prefixes: Array<[string, FileHeader["kind"]]> = [
    [ADD_FILE_PREFIX, "add"],
    [DELETE_FILE_PREFIX, "delete"],
    [UPDATE_FILE_PREFIX, "update"],
  ];
  for (const [prefix, kind] of prefixes) {
    if (!line.startsWith(prefix)) continue;
    return { kind, path: normalizePathAtLine(line.slice(prefix.length), lineNumber) };
  }
  return null;
}

function normalizePathAtLine(raw: string, line: number): string {
  try {
    return normalizePatchPath(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(line, message);
  }
}

function pathKey(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function isAncestorPath(parent: string, child: string): boolean {
  return child.startsWith(`${parent}/`);
}

export function normalizePatchPath(raw: string): string {
  const value = raw.trim();
  if (!value) throw new PatchError("patch path cannot be empty");
  if (value.includes("\0")) throw new PatchError(`patch path contains a null byte: ${raw}`);
  if (
    value.startsWith("~") ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new PatchError(`patch path must be relative: ${raw}`);
  }

  const segments = value.replace(/\\/g, "/").split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new PatchError(`patch path must not contain '..': ${raw}`);
  }
  const normalized = segments.filter((segment) => segment && segment !== ".").join("/");
  if (!normalized) throw new PatchError("patch path cannot be empty");
  return normalized;
}

function validatePathConflicts(operations: PatchFileOperation[]): void {
  const sources = new Map<string, PatchFileOperation>();
  const moveTargets = new Map<string, PatchUpdate>();
  const finalTargets: Array<{ key: string; path: string; line: number }> = [];

  for (const operation of operations) {
    const sourceKey = pathKey(operation.path);
    if (sources.has(sourceKey)) fail(operation.line, `duplicate file operation path: ${operation.path}`);
    if (moveTargets.has(sourceKey)) fail(operation.line, `path conflicts with a move target: ${operation.path}`);
    sources.set(sourceKey, operation);

    if (operation.kind === "add") {
      finalTargets.push({ key: sourceKey, path: operation.path, line: operation.line });
    }
    if (operation.kind === "update" && operation.moveTo) {
      const targetKey = pathKey(operation.moveTo);
      if (targetKey === sourceKey) fail(operation.moveLine!, `move target matches source: ${operation.moveTo}`);
      if (sources.has(targetKey)) fail(operation.moveLine!, `move target conflicts with a source path: ${operation.moveTo}`);
      if (moveTargets.has(targetKey)) fail(operation.moveLine!, `duplicate move target: ${operation.moveTo}`);
      moveTargets.set(targetKey, operation);
      finalTargets.push({ key: targetKey, path: operation.moveTo, line: operation.moveLine! });
    }
  }

  for (const operation of operations) {
    if (operation.kind !== "update" || !operation.moveTo) continue;
    const targetKey = pathKey(operation.moveTo);
    const source = sources.get(targetKey);
    if (source && source !== operation) {
      fail(operation.moveLine!, `move target conflicts with a source path: ${operation.moveTo}`);
    }
  }

  for (let index = 0; index < finalTargets.length; index += 1) {
    for (let other = index + 1; other < finalTargets.length; other += 1) {
      const left = finalTargets[index];
      const right = finalTargets[other];
      if (isAncestorPath(left.key, right.key) || isAncestorPath(right.key, left.key)) {
        fail(right.line, `file targets conflict: ${left.path} and ${right.path}`);
      }
    }
  }
}

function parseHunkHeader(line: string, lineNumber: number): string | null {
  if (line === "@@") return null;
  if (!line.startsWith("@@")) return fail(lineNumber, "expected an update hunk starting with @@");
  if (!line.startsWith("@@ ")) return fail(lineNumber, "invalid hunk header");
  const anchor = line.slice(3);
  if (!anchor || anchor.endsWith(" @@")) return fail(lineNumber, "invalid hunk anchor");
  return anchor;
}

export function parsePatchEnvelope(input: string): PatchFileOperation[] {
  const normalized = normalizeLineEndings(input);
  const body = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  if (body.endsWith("\n")) fail(body.split("\n").length, "only one final newline is allowed");
  const lines = body.split("\n");
  if (lines[0] !== BEGIN_PATCH) fail(1, `expected ${BEGIN_PATCH}`);
  if (lines.at(-1) !== END_PATCH) fail(lines.length, `expected ${END_PATCH}`);

  const operations: PatchFileOperation[] = [];
  let index = 1;
  while (index < lines.length - 1) {
    const lineNumber = index + 1;
    const header = parseFileHeader(lines[index], lineNumber);
    if (!header) fail(lineNumber, "expected a file operation header");
    if (operations.length === 20) fail(lineNumber, "a patch may contain at most 20 file operations");
    index += 1;

    if (header.kind === "add") {
      const addLines: string[] = [];
      while (index < lines.length - 1 && !parseFileHeader(lines[index], index + 1)) {
        const line = lines[index];
        if (!line.startsWith("+")) fail(index + 1, "Add File content lines must start with +");
        addLines.push(line.slice(1));
        index += 1;
      }
      operations.push({ kind: "add", path: header.path, line: lineNumber, lines: addLines });
      continue;
    }

    if (header.kind === "delete") {
      const next = lines[index];
      if (index < lines.length - 1 && !parseFileHeader(next, index + 1)) {
        fail(index + 1, "Delete File cannot contain a body");
      }
      operations.push({ kind: "delete", path: header.path, line: lineNumber });
      continue;
    }

    let moveTo: string | null = null;
    let moveLine: number | null = null;
    if (lines[index]?.startsWith(MOVE_TO_PREFIX)) {
      moveLine = index + 1;
      moveTo = normalizePathAtLine(lines[index].slice(MOVE_TO_PREFIX.length), moveLine);
      index += 1;
    }

    const hunks: PatchHunk[] = [];
    while (index < lines.length - 1 && !parseFileHeader(lines[index], index + 1)) {
      if (lines[index].startsWith(MOVE_TO_PREFIX)) fail(index + 1, "Move to must appear before the first hunk");
      const hunkLine = index + 1;
      const anchor = parseHunkHeader(lines[index], hunkLine);
      index += 1;
      const hunkLines: PatchHunkLine[] = [];
      let endOfFile = false;
      while (index < lines.length - 1) {
        const line = lines[index];
        if (line.startsWith("@@") || parseFileHeader(line, index + 1)) break;
        if (line.startsWith(MOVE_TO_PREFIX)) fail(index + 1, "Move to must appear before the first hunk");
        if (line === END_OF_FILE) {
          endOfFile = true;
          index += 1;
          if (
            index < lines.length - 1 &&
            !lines[index].startsWith("@@") &&
            !parseFileHeader(lines[index], index + 1)
          ) {
            fail(index + 1, `${END_OF_FILE} must be the last line of a hunk`);
          }
          break;
        }
        const prefix = line[0];
        const kind = prefix === " " ? "context" : prefix === "-" ? "remove" : prefix === "+" ? "add" : null;
        if (!kind) fail(index + 1, "hunk lines must start with a space, -, or +");
        hunkLines.push({ kind, text: line.slice(1) });
        index += 1;
      }
      if (!hunkLines.some((line) => line.kind === "remove" || line.kind === "add")) {
        fail(hunkLine, "a hunk must add or remove at least one line");
      }
      if (!anchor && hunkLines.every((line) => line.kind === "add") && !endOfFile) {
        fail(hunkLine, "an add-only hunk without an anchor must end with *** End of File");
      }
      hunks.push({ line: hunkLine, anchor, lines: hunkLines, endOfFile });
    }
    if (!moveTo && hunks.length === 0) fail(lineNumber, "Update File requires a hunk or Move to");
    operations.push({
      kind: "update",
      path: header.path,
      line: lineNumber,
      moveTo,
      moveLine,
      hunks,
    });
  }

  if (operations.length === 0) fail(2, "a patch must contain at least one file operation");
  validatePathConflicts(operations);
  return operations;
}

type ScanState = {
  file: PatchProgressFile;
  phase: "body" | "before-hunk" | "hunk" | "after-eof";
  hasHunk: boolean;
  hunkChanged: boolean;
};

export function scanPatchEnvelopePrefix(inputPrefix: string): PatchProgressFile[] {
  const normalized = normalizeLineEndings(inputPrefix);
  const completeLines = normalized.split("\n");
  if (!normalized.endsWith("\n")) completeLines.pop();
  if (completeLines.at(-1) === "") completeLines.pop();
  if (completeLines[0] !== BEGIN_PATCH) return [];

  const files: PatchProgressFile[] = [];
  let state: ScanState | null = null;
  const closeCurrent = (): boolean => {
    if (!state) return true;
    if (state.file.kind === "update" && !state.hasHunk && !state.file.moveTo) return false;
    if (state.phase === "hunk" && !state.hunkChanged) return false;
    return true;
  };

  for (let index = 1; index < completeLines.length; index += 1) {
    const line = completeLines[index];
    if (line === END_PATCH) break;

    let header: FileHeader | null = null;
    try {
      header = parseFileHeader(line, index + 1);
    } catch {
      break;
    }
    if (header) {
      if (!closeCurrent()) break;
      const file: PatchProgressFile = {
        kind: header.kind,
        path: header.path,
        moveTo: null,
        added: 0,
        deleted: 0,
      };
      files.push(file);
      state = {
        file,
        phase: header.kind === "update" ? "before-hunk" : "body",
        hasHunk: false,
        hunkChanged: false,
      };
      continue;
    }
    if (!state) break;

    if (state.file.kind === "add") {
      if (!line.startsWith("+")) break;
      state.file.added += 1;
      continue;
    }
    if (state.file.kind === "delete") break;

    if (state.phase === "before-hunk" && line.startsWith(MOVE_TO_PREFIX)) {
      if (state.file.moveTo) break;
      try {
        state.file.moveTo = normalizePathAtLine(line.slice(MOVE_TO_PREFIX.length), index + 1);
      } catch {
        break;
      }
      continue;
    }
    if (line === END_OF_FILE) {
      if (state.phase !== "hunk" || !state.hunkChanged) break;
      state.phase = "after-eof";
      continue;
    }
    if (line.startsWith("@@")) {
      if (state.phase === "after-eof" || (state.phase === "hunk" && !state.hunkChanged)) break;
      try {
        parseHunkHeader(line, index + 1);
      } catch {
        break;
      }
      state.phase = "hunk";
      state.hasHunk = true;
      state.hunkChanged = false;
      continue;
    }
    if (state.phase !== "hunk") break;
    if (line.startsWith("+")) {
      state.file.added += 1;
      state.hunkChanged = true;
    } else if (line.startsWith("-")) {
      state.file.deleted += 1;
      state.hunkChanged = true;
    } else if (!line.startsWith(" ")) {
      break;
    }
  }
  return files;
}
