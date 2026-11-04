import { describe, expect, it } from "vitest";
import {
  agentAttachmentAccept,
  classifyAgentAttachmentFile,
  safeAgentAttachmentFilename,
} from "../agent-attachment.js";

function file(name: string, type: string): Pick<File, "name" | "type"> {
  return { name, type };
}

describe("classifyAgentAttachmentFile", () => {
  it("classifies documents and images without opting into anything", () => {
    expect(classifyAgentAttachmentFile(file("report.pdf", "application/pdf"))).toEqual({
      kind: "file",
      mime: "application/pdf",
      extension: ".pdf",
    });
    expect(classifyAgentAttachmentFile(file("shot.png", "image/png"))).toMatchObject({ kind: "image" });
  });

  it("refuses audio unless the caller asks for it", () => {
    // The chat composer hands attachments to the model as documents, where a
    // recording is useless, so audio must not slip in by default.
    for (const name of ["interview.wav", "interview.mp3", "interview.m4a"]) {
      expect(classifyAgentAttachmentFile(file(name, "audio/wav")), name).toBeNull();
    }
    expect(agentAttachmentAccept()).not.toContain("audio/");
  });

  it("accepts audio once allowed, trusting the extension over the browser's label", () => {
    expect(classifyAgentAttachmentFile(file("interview.wav", "audio/wav"), { allowAudio: true })).toEqual({
      kind: "audio",
      mime: "audio/wav",
      extension: ".wav",
    });
    // Safari says audio/x-m4a, Chrome says audio/mp4, a file picker may say nothing.
    expect(classifyAgentAttachmentFile(file("interview.m4a", "audio/x-m4a"), { allowAudio: true })).toMatchObject({
      kind: "audio",
      mime: "audio/mp4",
    });
    expect(classifyAgentAttachmentFile(file("interview.m4a", ""), { allowAudio: true })).toMatchObject({
      kind: "audio",
      mime: "audio/mp4",
    });
    expect(classifyAgentAttachmentFile(file("interview.opus", "application/octet-stream"), { allowAudio: true }))
      .toMatchObject({ kind: "audio", mime: "audio/opus" });
  });

  it("rejects audio extensions whose declared type contradicts them", () => {
    expect(classifyAgentAttachmentFile(file("payload.wav", "text/html"), { allowAudio: true })).toBeNull();
  });

  it("keeps the original name and extension for audio uploads", () => {
    const classification = classifyAgentAttachmentFile(file("现场访谈.wav", "audio/wav"), { allowAudio: true })!;
    expect(safeAgentAttachmentFilename("现场访谈.wav", classification)).toBe("现场访谈.wav");
  });
});
