package db

import (
	"github.com/relay-chat/relay/internal/models"
)

func stripScheme(url string) string {
	for _, prefix := range []string{"https://", "http://"} {
		if len(url) > len(prefix) && url[:len(prefix)] == prefix {
			return url[len(prefix):]
		}
	}
	return url
}

// UpsertRemoteUser creates or updates a cached remote user from a federated peer.
// Also creates/updates a synthetic entry in the users table so FK constraints on messages work.
func (db *DB) UpsertRemoteUser(id, originURL, remoteID, username, displayName, avatarURL, nameColor string) (*models.RemoteUser, error) {
	_, err := db.Exec(
		`INSERT INTO remote_users (id, origin_url, remote_id, username, display_name, avatar_url, name_color, cached_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		 ON CONFLICT(origin_url, remote_id) DO UPDATE SET
		   username = excluded.username,
		   display_name = excluded.display_name,
		   avatar_url = excluded.avatar_url,
		   name_color = excluded.name_color,
		   cached_at = CURRENT_TIMESTAMP`,
		id, originURL, remoteID, username, displayName, avatarURL, nameColor,
	)
	if err != nil {
		return nil, err
	}

	// Ensure a synthetic user row exists so messages FK constraint is satisfied.
	// Use short hash suffix for uniqueness (avoids ugly @user@server format in UI).
	fedUsername := username + "#" + remoteID[:8]
	_, err = db.Exec(
		`INSERT INTO users (id, username, email, password_hash, display_name, avatar_url, name_color, status)
		 VALUES (?, ?, ?, '', ?, ?, ?, 'offline')
		 ON CONFLICT(id) DO UPDATE SET
		   username = excluded.username,
		   display_name = excluded.display_name,
		   avatar_url = excluded.avatar_url,
		   name_color = excluded.name_color`,
		id, fedUsername, "federated:"+id, displayName, avatarURL, nameColor,
	)
	if err != nil {
		return nil, err
	}

	return db.GetRemoteUser(id)
}

func (db *DB) GetRemoteUser(id string) (*models.RemoteUser, error) {
	u := &models.RemoteUser{}
	err := db.QueryRow(
		`SELECT id, origin_url, remote_id, username, display_name, avatar_url, name_color, cached_at FROM remote_users WHERE id = ?`,
		id,
	).Scan(&u.ID, &u.OriginURL, &u.RemoteID, &u.Username, &u.DisplayName, &u.AvatarURL, &u.NameColor, &u.CachedAt)
	return u, err
}

func (db *DB) GetRemoteUserByOrigin(originURL, remoteID string) (*models.RemoteUser, error) {
	u := &models.RemoteUser{}
	err := db.QueryRow(
		`SELECT id, origin_url, remote_id, username, display_name, avatar_url, name_color, cached_at FROM remote_users WHERE origin_url = ? AND remote_id = ?`,
		originURL, remoteID,
	).Scan(&u.ID, &u.OriginURL, &u.RemoteID, &u.Username, &u.DisplayName, &u.AvatarURL, &u.NameColor, &u.CachedAt)
	return u, err
}

// AddFederatedMember adds a remote user as a member of a local server.
func (db *DB) AddFederatedMember(serverID, remoteUserID, role string) error {
	_, err := db.Exec(
		`INSERT OR IGNORE INTO federated_members (server_id, remote_user_id, role) VALUES (?, ?, ?)`,
		serverID, remoteUserID, role,
	)
	return err
}

func (db *DB) RemoveFederatedMember(serverID, remoteUserID string) error {
	_, err := db.Exec(
		`DELETE FROM federated_members WHERE server_id = ? AND remote_user_id = ?`,
		serverID, remoteUserID,
	)
	return err
}

// GetFederatedMembers returns all remote users who are members of a server.
func (db *DB) GetFederatedMembers(serverID string) ([]models.RemoteUser, error) {
	rows, err := db.Query(
		`SELECT ru.id, ru.origin_url, ru.remote_id, ru.username, ru.display_name, ru.avatar_url, ru.name_color, ru.cached_at
		 FROM remote_users ru
		 JOIN federated_members fm ON ru.id = fm.remote_user_id
		 WHERE fm.server_id = ?`,
		serverID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var users []models.RemoteUser
	for rows.Next() {
		var u models.RemoteUser
		if err := rows.Scan(&u.ID, &u.OriginURL, &u.RemoteID, &u.Username, &u.DisplayName, &u.AvatarURL, &u.NameColor, &u.CachedAt); err != nil {
			return nil, err
		}
		users = append(users, u)
	}
	return users, rows.Err()
}

// IsFederatedMember checks if a remote user is a member of a server.
func (db *DB) IsFederatedMember(serverID, remoteUserID string) (bool, error) {
	var count int
	err := db.QueryRow(
		`SELECT COUNT(*) FROM federated_members WHERE server_id = ? AND remote_user_id = ?`,
		serverID, remoteUserID,
	).Scan(&count)
	return count > 0, err
}

// GetFederatedServersByOrigin returns server IDs that have at least one member from the given origin.
func (db *DB) GetFederatedServersByOrigin(originURL string) ([]string, error) {
	rows, err := db.Query(
		`SELECT DISTINCT fm.server_id
		 FROM federated_members fm
		 JOIN remote_users ru ON fm.remote_user_id = ru.id
		 WHERE ru.origin_url = ?`,
		originURL,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// CreateFederatedMessage stores a message received from a federated peer.
// Uses the same messages table but with a "fed:" prefixed user_id pointing to remote_users.
func (db *DB) CreateFederatedMessage(id, channelID, remoteUserID, content, nonce, msgType string, replyToID *string, keyEpoch int) error {
	_, err := db.Exec(
		`INSERT OR IGNORE INTO messages (id, channel_id, user_id, content, nonce, type, reply_to_id, key_epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		id, channelID, remoteUserID, content, nonce, msgType, replyToID, keyEpoch,
	)
	return err
}

// UpdateFederatedMessage updates a federated message's content.
func (db *DB) UpdateFederatedMessage(id, content string) error {
	_, err := db.Exec(
		`UPDATE messages SET content = ?, edited = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
		content, id,
	)
	return err
}

// SoftDeleteFederatedMessage marks a federated message as deleted.
func (db *DB) SoftDeleteFederatedMessage(id string) error {
	_, err := db.Exec(
		`UPDATE messages SET content = '[deleted]', deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
		id,
	)
	return err
}

// CreateFederatedDMChannel creates a DM channel between a local user and a remote user.
func (db *DB) CreateFederatedDMChannel(channelID, localUserID, remoteUserID string) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	_, err = tx.Exec(
		`INSERT OR IGNORE INTO channels (id, name, type) VALUES (?, '', 'dm')`,
		channelID,
	)
	if err != nil {
		return err
	}

	// Add the local user as participant
	_, err = tx.Exec(
		`INSERT OR IGNORE INTO dm_participants (channel_id, user_id) VALUES (?, ?)`,
		channelID, localUserID,
	)
	if err != nil {
		return err
	}

	// We store the remote user ID in dm_participants too so lookups work
	_, err = tx.Exec(
		`INSERT OR IGNORE INTO dm_participants (channel_id, user_id) VALUES (?, ?)`,
		channelID, remoteUserID,
	)
	if err != nil {
		return err
	}

	return tx.Commit()
}

// CreateFederatedServerMirror creates a local mirror of a remote federated server
// and adds the local user as a member. Uses the remote server's ID so incoming
// federated messages (which reference those channel/server IDs) match up.
func (db *DB) CreateFederatedServerMirror(serverID, name, iconURL, instanceURL, localUserID string) error {
	// Create the server entry (federated=1). Use local user as owner to satisfy FK.
	_, err := db.Exec(
		`INSERT OR IGNORE INTO servers (id, name, owner_id, icon_url, federated, instance_url) VALUES (?, ?, ?, ?, 1, ?)`,
		serverID, name, localUserID, iconURL, instanceURL,
	)
	if err != nil {
		return err
	}

	// Add the local user as a member
	_, err = db.Exec(
		`INSERT OR IGNORE INTO server_members (server_id, user_id, role) VALUES (?, ?, 'member')`,
		serverID, localUserID,
	)
	return err
}

// CreateFederatedChannelMirror creates a local mirror of a remote channel.
func (db *DB) CreateFederatedChannelMirror(channelID, serverID, name, channelType string, position int) error {
	_, err := db.Exec(
		`INSERT OR IGNORE INTO channels (id, server_id, name, type, position) VALUES (?, ?, ?, ?, ?)`,
		channelID, serverID, name, channelType, position,
	)
	return err
}
