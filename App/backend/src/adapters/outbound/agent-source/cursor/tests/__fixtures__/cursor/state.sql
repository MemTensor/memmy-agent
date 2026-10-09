-- A Cursor workspace database keeps editor state only. Chats live in globalStorage,
-- so this fixture must stay a non-conversation store.
CREATE TABLE ItemTable (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO ItemTable (key, value)
VALUES ('workbench.explorer.treeViewState', '{"focus":[]}');
