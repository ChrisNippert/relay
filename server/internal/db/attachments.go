package db

import (
	"github.com/relay-chat/relay/internal/models"
)

func (db *DB) CreateAttachment(id, messageID, filename, filePath string, fileSize int64, mimeType string) error {
	var msgID interface{}
	if messageID != "" {
		msgID = messageID
	}
	_, err := db.Exec(
		`INSERT INTO attachments (id, message_id, filename, file_path, file_size, mime_type) VALUES (?, ?, ?, ?, ?, ?)`,
		id, msgID, filename, filePath, fileSize, mimeType,
	)
	return err
}

func (db *DB) LinkAttachment(attachmentID, messageID string) error {
	_, err := db.Exec(`UPDATE attachments SET message_id = ? WHERE id = ?`, messageID, attachmentID)
	return err
}

func (db *DB) GetMessageAttachments(messageID string) ([]models.Attachment, error) {
	rows, err := db.Query(
		`SELECT id, message_id, filename, file_path, file_size, mime_type, created_at FROM attachments WHERE message_id = ?`,
		messageID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var attachments []models.Attachment
	for rows.Next() {
		var a models.Attachment
		if err := rows.Scan(&a.ID, &a.MessageID, &a.Filename, &a.FilePath, &a.FileSize, &a.MimeType, &a.CreatedAt); err != nil {
			return nil, err
		}
		attachments = append(attachments, a)
	}
	return attachments, rows.Err()
}
