package db

import "github.com/relay-chat/relay/internal/models"

func (db *DB) CreateServer(id, name, ownerID string) (*models.Server, error) {
	tx, err := db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	_, err = tx.Exec(
		`INSERT INTO servers (id, name, owner_id) VALUES (?, ?, ?)`,
		id, name, ownerID,
	)
	if err != nil {
		return nil, err
	}

	// Owner is automatically an admin member
	_, err = tx.Exec(
		`INSERT INTO server_members (server_id, user_id, role) VALUES (?, ?, 'admin')`,
		id, ownerID,
	)
	if err != nil {
		return nil, err
	}

	// Create default text and voice channels
	_, err = tx.Exec(
		`INSERT INTO channels (id, server_id, name, type, position) VALUES (?, ?, 'general', 'text', 0)`,
		id+"-general-text", id,
	)
	if err != nil {
		return nil, err
	}

	_, err = tx.Exec(
		`INSERT INTO channels (id, server_id, name, type, position) VALUES (?, ?, 'General', 'voice', 0)`,
		id+"-general-voice", id,
	)
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}

	return db.GetServer(id)
}

func (db *DB) GetServer(id string) (*models.Server, error) {
	s := &models.Server{}
	err := db.QueryRow(
		`SELECT id, name, owner_id, icon_url, created_at, updated_at FROM servers WHERE id = ?`,
		id,
	).Scan(&s.ID, &s.Name, &s.OwnerID, &s.IconURL, &s.CreatedAt, &s.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return s, nil
}

func (db *DB) GetServersByUser(userID string) ([]models.Server, error) {
	rows, err := db.Query(
		`SELECT s.id, s.name, s.owner_id, s.icon_url, s.created_at, s.updated_at
		 FROM servers s
		 JOIN server_members sm ON s.id = sm.server_id
		 WHERE sm.user_id = ?
		 ORDER BY s.name`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var servers []models.Server
	for rows.Next() {
		var s models.Server
		if err := rows.Scan(&s.ID, &s.Name, &s.OwnerID, &s.IconURL, &s.CreatedAt, &s.UpdatedAt); err != nil {
			return nil, err
		}
		servers = append(servers, s)
	}
	return servers, rows.Err()
}

func (db *DB) UpdateServer(id, name, iconURL string) (*models.Server, error) {
	_, err := db.Exec(
		`UPDATE servers SET name = ?, icon_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
		name, iconURL, id,
	)
	if err != nil {
		return nil, err
	}
	return db.GetServer(id)
}

func (db *DB) DeleteServer(id string) error {
	_, err := db.Exec(`DELETE FROM servers WHERE id = ?`, id)
	return err
}

func (db *DB) AddServerMember(serverID, userID, role string) error {
	_, err := db.Exec(
		`INSERT OR IGNORE INTO server_members (server_id, user_id, role) VALUES (?, ?, ?)`,
		serverID, userID, role,
	)
	return err
}

func (db *DB) RemoveServerMember(serverID, userID string) error {
	_, err := db.Exec(
		`DELETE FROM server_members WHERE server_id = ? AND user_id = ?`,
		serverID, userID,
	)
	return err
}

func (db *DB) GetServerMembers(serverID string) ([]models.ServerMember, error) {
	rows, err := db.Query(
		`SELECT server_id, user_id, role, joined_at FROM server_members WHERE server_id = ?`,
		serverID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var members []models.ServerMember
	for rows.Next() {
		var m models.ServerMember
		if err := rows.Scan(&m.ServerID, &m.UserID, &m.Role, &m.JoinedAt); err != nil {
			return nil, err
		}
		members = append(members, m)
	}
	return members, rows.Err()
}

func (db *DB) GetMemberRole(serverID, userID string) (string, error) {
	var role string
	err := db.QueryRow(
		`SELECT role FROM server_members WHERE server_id = ? AND user_id = ?`,
		serverID, userID,
	).Scan(&role)
	return role, err
}

func (db *DB) IsServerMember(serverID, userID string) (bool, error) {
	var count int
	err := db.QueryRow(
		`SELECT COUNT(*) FROM server_members WHERE server_id = ? AND user_id = ?`,
		serverID, userID,
	).Scan(&count)
	return count > 0, err
}

func (db *DB) UpdateMemberRole(serverID, userID, role string) error {
	_, err := db.Exec(
		`UPDATE server_members SET role = ? WHERE server_id = ? AND user_id = ?`,
		role, serverID, userID,
	)
	return err
}
