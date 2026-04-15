package models

import "time"

// RemoteUser represents a user from a federated peer instance.
type RemoteUser struct {
	ID          string    `json:"id"`
	OriginURL   string    `json:"origin_url"`
	RemoteID    string    `json:"remote_id"`
	Username    string    `json:"username"`
	DisplayName string    `json:"display_name"`
	AvatarURL   string    `json:"avatar_url,omitempty"`
	NameColor   string    `json:"name_color"`
	CachedAt    time.Time `json:"cached_at"`
}

// FederatedMember tracks a remote user's membership in a local server.
type FederatedMember struct {
	ServerID     string    `json:"server_id"`
	RemoteUserID string    `json:"remote_user_id"`
	Role         string    `json:"role"`
	JoinedAt     time.Time `json:"joined_at"`
}
