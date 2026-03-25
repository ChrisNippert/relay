package db

import "github.com/relay-chat/relay/internal/models"

func (db *DB) CreateMessage(id, channelID, userID, content, nonce, msgType string) (*models.Message, error) {
	_, err := db.Exec(
		`INSERT INTO messages (id, channel_id, user_id, content, nonce, type) VALUES (?, ?, ?, ?, ?, ?)`,
		id, channelID, userID, content, nonce, msgType,
	)
	if err != nil {
		return nil, err
	}
	return db.GetMessage(id)
}

func (db *DB) GetMessage(id string) (*models.Message, error) {
	m := &models.Message{}
	err := db.QueryRow(
		`SELECT id, channel_id, user_id, content, nonce, type, created_at, updated_at FROM messages WHERE id = ?`,
		id,
	).Scan(&m.ID, &m.ChannelID, &m.UserID, &m.Content, &m.Nonce, &m.Type, &m.CreatedAt, &m.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return m, nil
}

func (db *DB) GetMessages(channelID string, limit, offset int) ([]models.Message, error) {
	rows, err := db.Query(
		`SELECT m.id, m.channel_id, m.user_id, m.content, m.nonce, m.type, m.created_at, m.updated_at,
		        u.username, u.display_name, u.avatar_url
		 FROM messages m
		 JOIN users u ON m.user_id = u.id
		 WHERE m.channel_id = ?
		 ORDER BY m.created_at DESC
		 LIMIT ? OFFSET ?`,
		channelID, limit, offset,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var messages []models.Message
	for rows.Next() {
		var m models.Message
		var username, displayName, avatarURL string
		if err := rows.Scan(&m.ID, &m.ChannelID, &m.UserID, &m.Content, &m.Nonce, &m.Type,
			&m.CreatedAt, &m.UpdatedAt, &username, &displayName, &avatarURL); err != nil {
			return nil, err
		}
		m.Author = &models.User{
			ID:          m.UserID,
			Username:    username,
			DisplayName: displayName,
			AvatarURL:   avatarURL,
		}
		messages = append(messages, m)
	}
	return messages, rows.Err()
}
