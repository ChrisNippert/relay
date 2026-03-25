package db

import (
	"database/sql"
	"time"

	"github.com/relay-chat/relay/internal/models"
)

func (db *DB) CreateInvite(id, serverID, creatorID, code string, maxUses int, expiresAt *time.Time) (*models.ServerInvite, error) {
	var exp interface{}
	if expiresAt != nil {
		exp = *expiresAt
	}
	_, err := db.Exec(
		`INSERT INTO server_invites (id, server_id, creator_id, code, max_uses, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
		id, serverID, creatorID, code, maxUses, exp,
	)
	if err != nil {
		return nil, err
	}
	return db.GetInvite(id)
}

func (db *DB) GetInvite(id string) (*models.ServerInvite, error) {
	inv := &models.ServerInvite{}
	var expiresAt sql.NullTime
	err := db.QueryRow(
		`SELECT id, server_id, creator_id, code, max_uses, uses, expires_at, created_at FROM server_invites WHERE id = ?`,
		id,
	).Scan(&inv.ID, &inv.ServerID, &inv.CreatorID, &inv.Code, &inv.MaxUses, &inv.Uses, &expiresAt, &inv.CreatedAt)
	if err != nil {
		return nil, err
	}
	if expiresAt.Valid {
		inv.ExpiresAt = &expiresAt.Time
	}
	return inv, nil
}

func (db *DB) GetInviteByCode(code string) (*models.ServerInvite, error) {
	inv := &models.ServerInvite{}
	var expiresAt sql.NullTime
	err := db.QueryRow(
		`SELECT id, server_id, creator_id, code, max_uses, uses, expires_at, created_at FROM server_invites WHERE code = ?`,
		code,
	).Scan(&inv.ID, &inv.ServerID, &inv.CreatorID, &inv.Code, &inv.MaxUses, &inv.Uses, &expiresAt, &inv.CreatedAt)
	if err != nil {
		return nil, err
	}
	if expiresAt.Valid {
		inv.ExpiresAt = &expiresAt.Time
	}
	return inv, nil
}

func (db *DB) GetServerInvites(serverID string) ([]models.ServerInvite, error) {
	rows, err := db.Query(
		`SELECT id, server_id, creator_id, code, max_uses, uses, expires_at, created_at FROM server_invites WHERE server_id = ? ORDER BY created_at DESC`,
		serverID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var invites []models.ServerInvite
	for rows.Next() {
		var inv models.ServerInvite
		var expiresAt sql.NullTime
		if err := rows.Scan(&inv.ID, &inv.ServerID, &inv.CreatorID, &inv.Code, &inv.MaxUses, &inv.Uses, &expiresAt, &inv.CreatedAt); err != nil {
			return nil, err
		}
		if expiresAt.Valid {
			inv.ExpiresAt = &expiresAt.Time
		}
		invites = append(invites, inv)
	}
	return invites, rows.Err()
}

func (db *DB) UseInvite(code string) error {
	_, err := db.Exec(`UPDATE server_invites SET uses = uses + 1 WHERE code = ?`, code)
	return err
}

func (db *DB) DeleteInvite(id string) error {
	_, err := db.Exec(`DELETE FROM server_invites WHERE id = ?`, id)
	return err
}
