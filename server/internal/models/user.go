package models

import "time"

type User struct {
	ID           string    `json:"id"`
	Username     string    `json:"username"`
	Email        string    `json:"email,omitempty"`
	PasswordHash string    `json:"-"`
	DisplayName  string    `json:"display_name"`
	PublicKey    string    `json:"public_key,omitempty"`
	AvatarURL    string    `json:"avatar_url,omitempty"`
	Status       string    `json:"status"`
	CustomStatus string    `json:"custom_status"`
	NameColor    string    `json:"name_color"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

type Friendship struct {
	ID        string    `json:"id"`
	UserID    string    `json:"user_id"`
	FriendID  string    `json:"friend_id"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"created_at"`
}
