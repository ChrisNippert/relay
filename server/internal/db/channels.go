package db

import "github.com/relay-chat/relay/internal/models"

func (db *DB) CreateChannel(id, serverID, name, channelType string, position int) (*models.Channel, error) {
	_, err := db.Exec(
		`INSERT INTO channels (id, server_id, name, type, position) VALUES (?, ?, ?, ?, ?)`,
		id, serverID, name, channelType, position,
	)
	if err != nil {
		return nil, err
	}
	return db.GetChannel(id)
}

func (db *DB) GetChannel(id string) (*models.Channel, error) {
	c := &models.Channel{}
	var serverID *string
	err := db.QueryRow(
		`SELECT id, server_id, name, type, position, created_at FROM channels WHERE id = ?`,
		id,
	).Scan(&c.ID, &serverID, &c.Name, &c.Type, &c.Position, &c.CreatedAt)
	if err != nil {
		return nil, err
	}
	if serverID != nil {
		c.ServerID = *serverID
	}
	return c, nil
}

func (db *DB) GetChannelsByServer(serverID string) ([]models.Channel, error) {
	rows, err := db.Query(
		`SELECT id, server_id, name, type, position, created_at FROM channels WHERE server_id = ? ORDER BY type, position`,
		serverID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var channels []models.Channel
	for rows.Next() {
		var c models.Channel
		var sid *string
		if err := rows.Scan(&c.ID, &sid, &c.Name, &c.Type, &c.Position, &c.CreatedAt); err != nil {
			return nil, err
		}
		if sid != nil {
			c.ServerID = *sid
		}
		channels = append(channels, c)
	}
	return channels, rows.Err()
}

func (db *DB) DeleteChannel(id string) error {
	_, err := db.Exec(`DELETE FROM channels WHERE id = ?`, id)
	return err
}

func (db *DB) UpdateChannel(id, name string) (*models.Channel, error) {
	_, err := db.Exec(`UPDATE channels SET name = ? WHERE id = ?`, name, id)
	if err != nil {
		return nil, err
	}
	return db.GetChannel(id)
}

func (db *DB) UpdateChannelPositions(serverID string, positions map[string]int) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for channelID, pos := range positions {
		_, err := tx.Exec(`UPDATE channels SET position = ? WHERE id = ? AND server_id = ?`, pos, channelID, serverID)
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (db *DB) CreateDMChannel(channelID, userID1, userID2 string) (*models.Channel, error) {
	tx, err := db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	_, err = tx.Exec(
		`INSERT INTO channels (id, name, type) VALUES (?, '', 'dm')`,
		channelID,
	)
	if err != nil {
		return nil, err
	}

	_, err = tx.Exec(
		`INSERT INTO dm_participants (channel_id, user_id) VALUES (?, ?), (?, ?)`,
		channelID, userID1, channelID, userID2,
	)
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}

	return db.GetChannel(channelID)
}

func (db *DB) GetDMChannels(userID string) ([]models.Channel, error) {
	rows, err := db.Query(
		`SELECT c.id, c.server_id, c.name, c.type, c.position, c.created_at
		 FROM channels c
		 JOIN dm_participants dp ON c.id = dp.channel_id
		 WHERE dp.user_id = ? AND c.type = 'dm'`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var channels []models.Channel
	for rows.Next() {
		var c models.Channel
		var sid *string
		if err := rows.Scan(&c.ID, &sid, &c.Name, &c.Type, &c.Position, &c.CreatedAt); err != nil {
			return nil, err
		}
		if sid != nil {
			c.ServerID = *sid
		}
		channels = append(channels, c)
	}
	return channels, rows.Err()
}

func (db *DB) GetExistingDM(userID1, userID2 string) (*models.Channel, error) {
	c := &models.Channel{}
	var sid *string
	err := db.QueryRow(
		`SELECT c.id, c.server_id, c.name, c.type, c.position, c.created_at
		 FROM channels c
		 JOIN dm_participants dp1 ON c.id = dp1.channel_id AND dp1.user_id = ?
		 JOIN dm_participants dp2 ON c.id = dp2.channel_id AND dp2.user_id = ?
		 WHERE c.type = 'dm'`,
		userID1, userID2,
	).Scan(&c.ID, &sid, &c.Name, &c.Type, &c.Position, &c.CreatedAt)
	if err != nil {
		return nil, err
	}
	if sid != nil {
		c.ServerID = *sid
	}
	return c, nil
}

func (db *DB) GetDMParticipants(channelID string) ([]string, error) {
	rows, err := db.Query(
		`SELECT user_id FROM dm_participants WHERE channel_id = ?`,
		channelID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var userIDs []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		userIDs = append(userIDs, id)
	}
	return userIDs, rows.Err()
}

func (db *DB) IsChannelParticipant(channelID, userID string) (bool, error) {
	channel, err := db.GetChannel(channelID)
	if err != nil {
		return false, err
	}

	if channel.Type == "dm" {
		var count int
		err := db.QueryRow(
			`SELECT COUNT(*) FROM dm_participants WHERE channel_id = ? AND user_id = ?`,
			channelID, userID,
		).Scan(&count)
		return count > 0, err
	}

	return db.IsServerMember(channel.ServerID, userID)
}
