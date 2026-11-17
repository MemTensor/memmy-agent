import { rawTurnSummary } from "../session/session-turn-service.js";
import { DEFAULT_MEMMY_CONFIG } from "../../config/index.js";
import { Repositories } from "../../storage/repositories.js";
import type { MemoryDb } from "../../storage/db.js";
import { PanelReadModel } from "../read-model/panel-read.js";
import { episodeRef } from "../read-model/episode.js";

/** Only pure panel methods are exposed by the worker dispatcher. No model or writer is initialized. */
export function createPanelReaderModel(db: MemoryDb): PanelReadModel {
  const unavailable = (): never => {
    throw new Error("Not available in panel reader");
  };
  return new PanelReadModel({
    repos: new Repositories(db.db),
    config: () => DEFAULT_MEMMY_CONFIG,
    schemaVersion: () => db.schemaVersion(),
    storageCapabilities: unavailable,
    health: unavailable,
    models: unavailable,
    resolveContext: unavailable,
    encodeChangeCursor: unavailable,
    decodeChangeCursor: unavailable,
    episodeRef,
    rawTurnSummary
  });
}
