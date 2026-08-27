CREATE TABLE ItemTable (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO ItemTable (key, value)
VALUES (
  'composerData:conv-1',
  '{
    "conversationId": "conv-1",
    "messages": [
      {
        "id": "msg-user-1",
        "role": "user",
        "content": "Please remember OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCD",
        "createdAt": "2026-05-28T10:00:00.000Z"
      },
      {
        "id": "msg-assistant-1",
        "role": "assistant",
        "content": "I can help with that.",
        "createdAt": "2026-05-28T10:00:01.000Z"
      }
    ]
  }'
);
