import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MEMMY_CONFIG, type MemoryRow } from '../src/index.js';
import { createEmbedder } from '../src/model/embedder.js';
import { Repositories } from '../src/storage/repositories.js';
import { embeddingTextForMemory } from '../src/service/embedding/embedding-pipeline.js';
import { createMemoryServiceFixture, createBatchReflectionLlm } from './fixtures/memory-service-fixture.js';

const fixture = createMemoryServiceFixture();
afterEach(() => { fixture.cleanup(); vi.unstubAllGlobals(); });

function setup(explicit: boolean) {
  const requests: Array<{ sizes: number[]; rejected: boolean }> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    const { input } = JSON.parse(String(init.body)) as { input: string[] };
    const rejected = input.some(text => text.includes('BAD_EMBEDDING_ITEM'));
    requests.push({ sizes: input.map(text => text.length), rejected });
    return new Response(JSON.stringify(rejected
      ? { code: explicit ? 'context_length_exceeded' : 20015, message: explicit ? 'maximum context length exceeded' : 'The parameter is invalid.' }
      : { data: input.map(() => ({ embedding: [1, 0, 0] })) }),
      { status: rejected ? 400 : 200, headers: { 'content-type': 'application/json' } });
  }));
  const embedder = createEmbedder({ ...DEFAULT_MEMMY_CONFIG.embedding,
    provider: 'openai_compatible', model: 'Pro/BAAI/bge-m3',
    endpoint: 'https://embedding-reproduction.invalid/v1', apiKey: 'synthetic-test-key',
    cache: false, maxRetries: 3 }, { usageRecorder: { record() { return "skipped"; } } });
  return { embedder, requests };
}
function skill(id: string, content: string): MemoryRow {
  const at = new Date().toISOString();
  return { id, timeline: at, userId: 'memmy488-test', memoryType: 'SkillMemory',
    status: 'activated', visibility: 'private', memoryKey: id, memoryValue: content,
    tags: [], info: {}, properties: { internal_info: { memory_layer: 'Skill', memory_kind: 'skill',
      skill: { name: id, status: 'active', invocation_guide: content } } },
    memoryLayer: 'Skill', version: 1, createdAt: at, updatedAt: at };
}

describe('MEMMY-488 regression (valid siblings must survive)', () => {
  for (const explicit of [true, false]) {
    it(`fresh worker batch: ${explicit ? 'explicit length error' : 'screenshot error 20015'}`, async () => {
      const { embedder, requests } = setup(explicit);
      const { db, service } = fixture.createTestService({ embedder, llm: createBatchReflectionLlm([], 'Synthetic summary.') });
      const session = service.openSession({ namespace: { source: 'codex', profileId: 'memmy488', userId: 'memmy488-test' } });
      const ids = ['GOOD_A', 'GOOD_B', 'GOOD_C', 'BAD_EMBEDDING_ITEM'].map((answer, i) =>
        service.completeTurn(`turn-${i}`, { sessionId: session.sessionId, query: 'Remember this synthetic test.', answer }).l1MemoryId);
      await service.runWorkerOnce(20, { priorityCohortOnly: true });
      await service.runWorkerOnce(20, { priorityCohortOnly: true });
      const repos = new Repositories(db.db);
      const states = ids.map(id => ({ id, state: repos.processing.get(id)?.state, error: repos.processing.get(id)?.errorCode }));
      expect(states.map(s => s.state)).toEqual(['ready', 'ready', 'ready', explicit ? 'ready_text_only' : 'failed']);
      const vectorRows = db.db.prepare('SELECT memory_id, vector_field FROM memory_vector_entries').all();
      expect(vectorRows.length).toBe(3);
      const before = requests.length;
      await service.runWorkerOnce(20, { priorityCohortOnly: true });
      expect(requests.length).toBe(before);
    });

    it(`legacy retry batch and separate replay: ${explicit ? 'explicit length error' : 'screenshot error 20015'}`, async () => {
      const { embedder, requests } = setup(explicit);
      const { db, service } = fixture.createTestService({ embedder });
      const repos = new Repositories(db.db);
      const memories = ['GOOD_A', 'GOOD_B', 'GOOD_C', 'BAD_EMBEDDING_ITEM'].map((text, i) => skill(`skill-488-${i}`, text));
      const retries = memories.map(memory => {
        repos.memories.insert(memory);
        return repos.runtime.enqueueEmbeddingRetry({ targetKind: 'skill', targetId: memory.id, vectorField: 'vec',
          sourceText: embeddingTextForMemory(memory), embedRole: 'query', now: Date.now() - 1 });
      });
      await service.runWorkerOnce(10);
      const states = retries.map(retry => { const row = repos.runtime.getEmbeddingRetry(retry.id)!; return { status: row.status, attempts: row.attempts }; });
      expect(states.map(s => s.status)).toEqual(['succeeded', 'succeeded', 'succeeded', 'failed']);
      const vectorRows = db.db.prepare('SELECT memory_id, vector_field FROM memory_vector_entries').all();
      expect(vectorRows.length).toBe(3);
      const before = requests.length;
      await service.runWorkerOnce(10);
      expect(requests.length).toBe(before);
      const replay: string[] = [];
      for (const memory of memories) {
        try { await embedder.embedOne(embeddingTextForMemory(memory), 'query'); replay.push('succeeded'); }
        catch { replay.push('failed'); }
      }
      expect(replay).toEqual(['succeeded', 'succeeded', 'succeeded', 'failed']);
    });
  }

  it('long BGE alias text is chunked and preserves the complete input', async () => {
    const sent: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      const { input } = JSON.parse(String(init.body)); sent.push(...input);
      return new Response(JSON.stringify({ data: input.map(() => ({ embedding: [1, 0, 0] })) }), { status: 200 });
    }));
    const embedder = createEmbedder({ ...DEFAULT_MEMMY_CONFIG.embedding, provider: 'openai_compatible',
      model: 'Pro/BAAI/bge-m3', endpoint: 'https://embedding-reproduction.invalid/v1', apiKey: 'synthetic-test-key', cache: false },
      { usageRecorder: { record() { return "skipped"; } } });
    const text = '# Synthetic long document\n' + ' memory'.repeat(16000) + '\nEND_MARKER';
    await embedder.embedOne(text);
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.join('')).toBe(text);
  });
});
