package db

import (
	"database/sql"

	_ "modernc.org/sqlite"
)

type DB struct {
	*sql.DB
}

func New(path string) (*DB, error) {
	sqlDB, err := sql.Open("sqlite", path+"?_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}

	// Allow a small pool so HTTP handlers and the WS hub don't deadlock
	// each other on the single connection. SQLite WAL mode supports
	// concurrent readers with one writer.
	sqlDB.SetMaxOpenConns(4)
	sqlDB.SetMaxIdleConns(2)

	db := &DB{sqlDB}
	if err := db.migrate(); err != nil {
		return nil, err
	}

	return db, nil
}

func (db *DB) migrate() error {
	if _, err := db.Exec(schema); err != nil {
		return err
	}
	// Add columns that may be missing on pre-existing databases.
	// SQLite errors if a column already exists, so we ignore those errors.
	alterations := []string{
		`ALTER TABLE messages ADD COLUMN reply_to_id TEXT REFERENCES messages(id) ON DELETE SET NULL`,
		`ALTER TABLE messages ADD COLUMN edited INTEGER DEFAULT 0`,
		`ALTER TABLE messages ADD COLUMN deleted INTEGER DEFAULT 0`,
		`CREATE TABLE IF NOT EXISTS message_edits (id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, content TEXT NOT NULL, edited_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
		`ALTER TABLE users ADD COLUMN custom_status TEXT DEFAULT ''`,
		`ALTER TABLE users ADD COLUMN name_color TEXT DEFAULT ''`,
		`ALTER TABLE channels ADD COLUMN description TEXT DEFAULT ''`,
	}
	for _, stmt := range alterations {
		db.Exec(stmt) // intentionally ignore "duplicate column" errors
	}
	return nil
}

const schema = `
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    public_key TEXT DEFAULT '',
    avatar_url TEXT DEFAULT '',
    status TEXT DEFAULT 'offline',
    custom_status TEXT DEFAULT '',
    name_color TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS friendships (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    friend_id TEXT NOT NULL REFERENCES users(id),
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, friend_id)
);

CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id),
    icon_url TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS server_members (
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    role TEXT DEFAULT 'member',
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (server_id, user_id)
);

CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    server_id TEXT REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT DEFAULT '',
    type TEXT NOT NULL,
    position INTEGER DEFAULT 0,
    description TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS dm_participants (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    content TEXT NOT NULL,
    nonce TEXT DEFAULT '',
    type TEXT DEFAULT 'text',
    reply_to_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    edited INTEGER DEFAULT 0,
    deleted INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS message_edits (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    edited_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_message_edits_message ON message_edits(message_id, edited_at);

CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    mime_type TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS channel_keys (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    encrypted_key TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (channel_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_server_members_user ON server_members(user_id);
CREATE INDEX IF NOT EXISTS idx_friendships_user ON friendships(user_id);
CREATE INDEX IF NOT EXISTS idx_friendships_friend ON friendships(friend_id);
CREATE INDEX IF NOT EXISTS idx_dm_participants_user ON dm_participants(user_id);

CREATE TABLE IF NOT EXISTS server_invites (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    creator_id TEXT NOT NULL REFERENCES users(id),
    code TEXT UNIQUE NOT NULL,
    max_uses INTEGER DEFAULT 0,
    uses INTEGER DEFAULT 0,
    expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_server_invites_code ON server_invites(code);
CREATE INDEX IF NOT EXISTS idx_server_invites_server ON server_invites(server_id);
`
