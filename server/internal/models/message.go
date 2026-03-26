package models

import "time"

type Message struct {
	ID          string        `json:"id"`
	ChannelID   string        `json:"channel_id"`
	UserID      string        `json:"user_id"`
	Content     string        `json:"content"`
	Nonce       string        `json:"nonce,omitempty"`
	Type        string        `json:"type"`
	ReplyToID   *string       `json:"reply_to_id,omitempty"`
	ReplyTo     *Message      `json:"reply_to,omitempty"`
	Edited      bool          `json:"edited"`
	Deleted     bool          `json:"deleted"`
	CreatedAt   time.Time     `json:"created_at"`
	UpdatedAt   time.Time     `json:"updated_at"`
	Attachments []Attachment  `json:"attachments,omitempty"`
	Author      *User         `json:"author,omitempty"`
	EditHistory []MessageEdit `json:"edit_history,omitempty"`
}

type MessageEdit struct {
	ID        string    `json:"id"`
	MessageID string    `json:"message_id"`
	Content   string    `json:"content"`
	EditedAt  time.Time `json:"edited_at"`
}

type Attachment struct {
	ID        string    `json:"id"`
	MessageID string    `json:"message_id"`
	Filename  string    `json:"filename"`
	FilePath  string    `json:"-"`
	FileSize  int64     `json:"file_size"`
	MimeType  string    `json:"mime_type"`
	CreatedAt time.Time `json:"created_at"`
}

type ChannelKey struct {
	ChannelID    string `json:"channel_id"`
	UserID       string `json:"user_id"`
	EncryptedKey string `json:"encrypted_key"`
}
