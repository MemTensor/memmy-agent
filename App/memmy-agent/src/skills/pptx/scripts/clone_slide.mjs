#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import JSZip from "jszip";

const usage = `Usage: clone_slide.mjs --input <deck.pptx|unpacked-dir> --slide <slide.xml> [--after <slide.xml>] [-o|--output <deck.pptx>]
       clone_slide.mjs <deck.pptx|unpacked-dir> <slide.xml> [--after <slide.xml>] [-o|--output <deck.pptx>]`;

function parseArgs(argv) {
  const result = { input: null, slide: null, after: null, output: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    else if (arg === "--json") result.json = true;
    else if (arg === "--input" || arg === "-i") result.input = argv[++i];
    else if (arg === "--slide" || arg === "-s") result.slide = argv[++i];
    else if (arg === "--after") result.after = argv[++i];
    else if (arg === "--output" || arg === "-o") result.output = argv[++i];
    else if (!arg.startsWith("-") && !result.input) result.input = arg;
    else if (!arg.startsWith("-") && !result.slide) result.slide = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!result.input || !result.slide) throw new Error("Input and slide are required");
  return result;
}

async function readDirectory(directory, root = directory, result = new Map()) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await readDirectory(file, root, result);
    else result.set(path.relative(root, file).split(path.sep).join("/"), await fs.readFile(file));
  }
  return result;
}

async function readInput(input) {
  const stat = await fs.stat(input).catch(() => null);
  if (!stat) throw new Error(`Input does not exist: ${input}`);
  if (stat.isDirectory()) return { files: await readDirectory(input), directory: true };
  const zip = await JSZip.loadAsync(await fs.readFile(input), { checkCRC32: true });
  const files = new Map();
  for (const [name, entry] of Object.entries(zip.files)) if (!entry.dir) files.set(path.posix.normalize(name), await entry.async("nodebuffer"));
  return { files, directory: false };
}

function findSlide(files, requested) {
  const normalized = requested.replaceAll("\\", "/").replace(/^\.?\//, "");
  if (files.has(normalized)) return normalized;
  const candidate = normalized.includes("/") ? normalized : `ppt/slides/${normalized}`;
  if (files.has(candidate)) return candidate;
  const basename = path.posix.basename(normalized);
  const match = [...files.keys()].find((name) => path.posix.basename(name) === basename && /^ppt\/slides\/slide\d+\.xml$/i.test(name));
  if (!match) throw new Error(`Slide not found: ${requested}`);
  return match;
}

function nextNumber(files, prefix) {
  return Math.max(0, ...[...files.keys()].filter((name) => name.startsWith(prefix)).map((name) => Number(name.match(/(\d+)(?:\.xml|\.rels)$/)?.[1] ?? 0))) + 1;
}

function nextRelationshipId(xml) {
  return Math.max(0, ...[...xml.matchAll(/\bId=["']rId(\d+)["']/g)].map((match) => Number(match[1]))) + 1;
}

function nextSlideId(xml) {
  return Math.max(255, ...[...xml.matchAll(/<p:sldId\b[^>]*\bid=["'](\d+)["']/g)].map((match) => Number(match[1]))) + 1;
}

function addPresentationEntry(xml, relationshipId, slideId, afterRelationshipId) {
  const entry = `<p:sldId id="${slideId}" r:id="${relationshipId}"/>`;
  if (afterRelationshipId) {
    const pattern = new RegExp(`(<p:sldId\\b[^>]*\\br:id=["']${afterRelationshipId}["'][^>]*/>)`);
    if (pattern.test(xml)) return xml.replace(pattern, `$1${entry}`);
  }
  if (/<\/p:sldIdLst>/.test(xml)) return xml.replace(/<\/p:sldIdLst>/, `${entry}</p:sldIdLst>`);
  throw new Error("p:sldIdLst is missing from presentation.xml");
}

function addRelationship(xml, relationshipId, target) {
  const entry = `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="${target}"/>`;
  if (!/<\/Relationships>/.test(xml)) throw new Error("Presentation relationships are missing");
  return xml.replace(/<\/Relationships>/, `${entry}</Relationships>`);
}

function addContentType(xml, slidePath) {
  const entry = `<Override PartName="/${slidePath}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`;
  if (xml.includes(`PartName="/${slidePath}"`)) return xml;
  if (!/<\/Types>/.test(xml)) throw new Error("Content types are missing");
  return xml.replace(/<\/Types>/, `${entry}</Types>`);
}

async function writeOutput(files, input, output, wasDirectory) {
  if (wasDirectory && !output) {
    for (const [name, bytes] of files) {
      const target = path.join(input, ...name.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes);
    }
    return input;
  }
  const destination = output || input;
  const zip = new JSZip();
  for (const [name, bytes] of files) zip.file(name, bytes);
  const temporary = `${destination}.tmp-${process.pid}`;
  await fs.writeFile(temporary, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  await fs.rename(temporary, destination);
  return destination;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(usage);
  process.exit(0);
}
try {
  const loaded = await readInput(options.input);
  const files = loaded.files;
  const sourceSlide = findSlide(files, options.slide);
  const slideMatch = sourceSlide.match(/^(.*\/slide)(\d+)(\.xml)$/i);
  if (!slideMatch) throw new Error(`Unsupported slide name: ${sourceSlide}`);
  const prefix = slideMatch[1];
  const newNumber = nextNumber(files, prefix);
  const targetSlide = `${prefix}${newNumber}.xml`;
  files.set(targetSlide, files.get(sourceSlide));
  const sourceRels = sourceSlide.replace("/slides/", "/slides/_rels/").replace(/\.xml$/i, ".xml.rels");
  if (files.has(sourceRels)) files.set(targetSlide.replace("/slides/", "/slides/_rels/").replace(/\.xml$/i, ".xml.rels"), files.get(sourceRels));
  const presentationBytes = files.get("ppt/presentation.xml");
  const relationshipBytes = files.get("ppt/_rels/presentation.xml.rels");
  const contentTypeBytes = files.get("[Content_Types].xml");
  if (!presentationBytes || !relationshipBytes || !contentTypeBytes) throw new Error("Presentation package parts are missing");
  const presentation = presentationBytes.toString("utf8");
  const relationships = relationshipBytes.toString("utf8");
  const relationId = `rId${nextRelationshipId(relationships)}`;
  const slideId = nextSlideId(presentation);
  let afterId = null;
  if (options.after) {
    const afterSlide = findSlide(files, options.after);
    const afterName = path.posix.basename(afterSlide);
    const relationshipMatch = new RegExp(`<p:sldId\\b[^>]*\\br:id=["']([^"']+)["'][^>]*>[^<]*</p:sldId>|<p:sldId\\b[^>]*\\br:id=["']([^"']+)["'][^>]*/>`, "g");
    const ids = [...presentation.matchAll(relationshipMatch)];
    const index = [...files.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name)).sort().findIndex((name) => path.posix.basename(name) === afterName);
    afterId = index >= 0 ? ids[index]?.[1] || ids[index]?.[2] || null : null;
    if (!afterId) throw new Error(`Cannot locate --after slide in presentation: ${options.after}`);
  }
  files.set("ppt/presentation.xml", Buffer.from(addPresentationEntry(presentation, relationId, slideId, afterId)));
  files.set("ppt/_rels/presentation.xml.rels", Buffer.from(addRelationship(relationships, relationId, `slides/slide${newNumber}.xml`)));
  files.set("[Content_Types].xml", Buffer.from(addContentType(contentTypeBytes.toString("utf8"), targetSlide)));
  const destination = await writeOutput(files, options.input, options.output, loaded.directory);
  console.log(JSON.stringify({ ok: true, source: sourceSlide, clone: targetSlide, slideId, relationshipId: relationId, output: path.resolve(destination) }));
} catch (error) {
  if (options.json) console.log(JSON.stringify({ ok: false, checker: "pptx.clone", errors: [{ code: "input_error", message: error.message }] }));
  else console.error(error.message);
  process.exitCode = 1;
}
