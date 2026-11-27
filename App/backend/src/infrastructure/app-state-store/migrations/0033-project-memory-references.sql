CREATE TABLE project_memory_references (
  account TEXT NOT NULL, source TEXT NOT NULL, conversation TEXT NOT NULL, turn TEXT NOT NULL,
  project TEXT NOT NULL, memory TEXT NOT NULL, origin TEXT NOT NULL, kind TEXT NOT NULL,
  PRIMARY KEY (account, source, conversation, turn, project, memory, origin, kind),
  FOREIGN KEY (account, source, conversation, turn)
    REFERENCES project_memory_turns(account, source, conversation, turn) ON DELETE CASCADE
);
