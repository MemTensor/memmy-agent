import { encodeAgentImage } from "../lib/agent-image-encode.js";

self.onmessage = (event: MessageEvent<{ id: string; file: File }>) => {
  void encodeAgentImage(event.data.file)
    .then((encoded) => {
      self.postMessage({
        id: event.data.id,
        ok: true,
        blob: encoded.blob,
        mime: encoded.mime,
        bytes: encoded.bytes,
        normalized: encoded.normalized
      });
    })
    .catch((error: unknown) => {
      self.postMessage({
        id: event.data.id,
        ok: false,
        error: error instanceof Error && error.message ? error.message : "home.media.error.sendReadFailed"
      });
    });
};
