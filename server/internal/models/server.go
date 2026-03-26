package models

import "time"

type Server struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	OwnerID   string    `json:"owner_id"`
	IconURL   string    `json:"icon_url,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type ServerMember struct {
	ServerID string    `json:"server_id"`
	UserID   string    `json:"user_id"`
	Role     string    `json:"role"`
	JoinedAt time.Time `json:"joined_at"`
}

type Channel struct {
	ID          string    `json:"id"`
	ServerID    string    `json:"server_id,omitempty"`
	Name        string    `json:"name"`
	Type        string    `json:"type"`
	Position    int       `json:"position"`
	Description string    `json:"description"`
	CreatedAt   time.Time `json:"created_at"`
}

type ServerInvite struct {
	ID        string     `json:"id"`
	ServerID  string     `json:"server_id"`
	CreatorID string     `json:"creator_id"`
	Code      string     `json:"code"`
	MaxUses   int        `json:"max_uses"`
	Uses      int        `json:"uses"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
}
