package models

import "time"

type Message struct {
	ID          string       `json:"id"`
	ChannelID   string       `json:"channel_id"`
	UserID      string       `json:"user_id"`
	Content     string       `json:"content"`
	Nonce       string       `json:"nonce,omitempty"`
	Type        string       `json:"type"`
	CreatedAt   time.Time    `json:"created_at"`
	UpdatedAt   time.Time    `json:"updated_at"`
	Attachments []Attachment `json:"attachments,omitempty"`
	Author      *User        `json:"author,omitempty"`
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
