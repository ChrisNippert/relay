package db

import (
	"database/sql"

	"github.com/google/uuid"
	"github.com/relay-chat/relay/internal/models"
)

func (db *DB) CreateMessage(id, channelID, userID, content, nonce, msgType string, replyToID *string) (*models.Message, error) {
	_, err := db.Exec(
		`INSERT INTO messages (id, channel_id, user_id, content, nonce, type, reply_to_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		id, channelID, userID, content, nonce, msgType, replyToID,
	)
	if err != nil {
		return nil, err
	}
	return db.GetMessage(id)
}

func (db *DB) GetMessage(id string) (*models.Message, error) {
	m := &models.Message{}
	var replyToID sql.NullString
	err := db.QueryRow(
		`SELECT id, channel_id, user_id, content, nonce, type, reply_to_id, edited, deleted, created_at, updated_at FROM messages WHERE id = ?`,
		id,
	).Scan(&m.ID, &m.ChannelID, &m.UserID, &m.Content, &m.Nonce, &m.Type, &replyToID, &m.Edited, &m.Deleted, &m.CreatedAt, &m.UpdatedAt)
	if err != nil {
		return nil, err
	}
	if replyToID.Valid {
		m.ReplyToID = &replyToID.String
	}
	attachments, _ := db.GetMessageAttachments(id)
	if attachments != nil {
		m.Attachments = attachments
	}
	// Load reply-to message (one level only)
	if m.ReplyToID != nil {
		reply, err := db.getMessageShallow(*m.ReplyToID)
		if err == nil {
			m.ReplyTo = reply
		}
	}
	return m, nil
}

// getMessageShallow loads a message without its own reply chain (prevents recursion)
func (db *DB) getMessageShallow(id string) (*models.Message, error) {
	m := &models.Message{}
	var replyToID sql.NullString
	var username, displayName, avatarURL, nameColor string
	err := db.QueryRow(
		`SELECT m.id, m.channel_id, m.user_id, m.content, m.type, m.reply_to_id, m.edited, m.deleted, m.created_at,
		        u.username, u.display_name, u.avatar_url, u.name_color
		 FROM messages m
		 JOIN users u ON m.user_id = u.id
		 WHERE m.id = ?`, id,
	).Scan(&m.ID, &m.ChannelID, &m.UserID, &m.Content, &m.Type, &replyToID, &m.Edited, &m.Deleted, &m.CreatedAt,
		&username, &displayName, &avatarURL, &nameColor)
	if err != nil {
		return nil, err
	}
	if replyToID.Valid {
		m.ReplyToID = &replyToID.String
	}
	m.Author = &models.User{
		ID:          m.UserID,
		Username:    username,
		DisplayName: displayName,
		AvatarURL:   avatarURL,
		NameColor:   nameColor,
	}
	return m, nil
}

func (db *DB) UpdateMessage(id, newContent string) (*models.Message, error) {
	// Save current content as edit history entry
	editID := uuid.New().String()
	_, err := db.Exec(
		`INSERT INTO message_edits (id, message_id, content, edited_at)
		 SELECT ?, ?, content, CURRENT_TIMESTAMP FROM messages WHERE id = ?`,
		editID, id, id,
	)
	if err != nil {
		return nil, err
	}

	// Update the message itself
	_, err = db.Exec(
		`UPDATE messages SET content = ?, edited = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
		newContent, id,
	)
	if err != nil {
		return nil, err
	}
	return db.GetMessage(id)
}

func (db *DB) GetMessageEditHistory(messageID string) ([]models.MessageEdit, error) {
	rows, err := db.Query(
		`SELECT id, message_id, content, edited_at FROM message_edits WHERE message_id = ? ORDER BY edited_at ASC`,
		messageID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var edits []models.MessageEdit
	for rows.Next() {
		var e models.MessageEdit
		if err := rows.Scan(&e.ID, &e.MessageID, &e.Content, &e.EditedAt); err != nil {
			return nil, err
		}
		edits = append(edits, e)
	}
	return edits, rows.Err()
}

func (db *DB) GetMessages(channelID string, limit, offset int) ([]models.Message, error) {
	rows, err := db.Query(
		`SELECT m.id, m.channel_id, m.user_id, m.content, m.nonce, m.type, m.reply_to_id, m.edited, m.deleted, m.created_at, m.updated_at,
		        u.username, u.display_name, u.avatar_url, u.name_color
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
		var username, displayName, avatarURL, nameColor string
		var replyToID sql.NullString
		if err := rows.Scan(&m.ID, &m.ChannelID, &m.UserID, &m.Content, &m.Nonce, &m.Type,
			&replyToID, &m.Edited, &m.Deleted, &m.CreatedAt, &m.UpdatedAt, &username, &displayName, &avatarURL, &nameColor); err != nil {
			return nil, err
		}
		if replyToID.Valid {
			m.ReplyToID = &replyToID.String
		}
		m.Author = &models.User{
			ID:          m.UserID,
			Username:    username,
			DisplayName: displayName,
			AvatarURL:   avatarURL,
			NameColor:   nameColor,
		}
		attachments, _ := db.GetMessageAttachments(m.ID)
		if attachments != nil {
			m.Attachments = attachments
		}
		// Load reply-to preview (shallow)
		if m.ReplyToID != nil {
			reply, err := db.getMessageShallow(*m.ReplyToID)
			if err == nil {
				m.ReplyTo = reply
			}
		}
		messages = append(messages, m)
	}
	return messages, rows.Err()
}

func (db *DB) SearchMessages(channelID, query string, limit int) ([]models.Message, error) {
	rows, err := db.Query(
		`SELECT m.id, m.channel_id, m.user_id, m.content, m.nonce, m.type, m.reply_to_id, m.edited, m.deleted, m.created_at, m.updated_at,
		        u.username, u.display_name, u.avatar_url, u.name_color
		 FROM messages m
		 JOIN users u ON m.user_id = u.id
		 WHERE m.channel_id = ? AND m.deleted = 0 AND m.content LIKE '%' || ? || '%'
		 ORDER BY m.created_at DESC
		 LIMIT ?`,
		channelID, query, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var messages []models.Message
	for rows.Next() {
		var m models.Message
		var username, displayName, avatarURL, nameColor string
		var replyToID sql.NullString
		if err := rows.Scan(&m.ID, &m.ChannelID, &m.UserID, &m.Content, &m.Nonce, &m.Type,
			&replyToID, &m.Edited, &m.Deleted, &m.CreatedAt, &m.UpdatedAt, &username, &displayName, &avatarURL, &nameColor); err != nil {
			return nil, err
		}
		if replyToID.Valid {
			m.ReplyToID = &replyToID.String
		}
		m.Author = &models.User{
			ID:          m.UserID,
			Username:    username,
			DisplayName: displayName,
			AvatarURL:   avatarURL,
			NameColor:   nameColor,
		}
		attachments, _ := db.GetMessageAttachments(m.ID)
		if attachments != nil {
			m.Attachments = attachments
		}
		messages = append(messages, m)
	}
	return messages, rows.Err()
}

// DeleteMessage soft-deletes a message: records the original content in edit
// history, replaces content with "[deleted]", and sets deleted=1.
func (db *DB) DeleteMessage(id, requestingUserID string) (*models.Message, error) {
	// Save current content as history entry so it shows in the history view
	editID := uuid.New().String()
	_, err := db.Exec(
		`INSERT INTO message_edits (id, message_id, content, edited_at)
                 SELECT ?, ?, content, CURRENT_TIMESTAMP FROM messages WHERE id = ?`,
		editID, id, id,
	)
	if err != nil {
		return nil, err
	}

	_, err = db.Exec(
		`UPDATE messages SET content = '[deleted]', deleted = 1, edited = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
		id,
	)
	if err != nil {
		return nil, err
	}
	return db.GetMessage(id)
}
