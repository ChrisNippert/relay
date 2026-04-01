package db

import (
	"database/sql"

	"github.com/relay-chat/relay/internal/models"
)

func (db *DB) RegisterDevice(id, userID, name, publicKey, signingKey string) (*models.Device, error) {
	// First device for a user is auto-approved; subsequent ones need approval
	var count int
	db.QueryRow(`SELECT COUNT(*) FROM devices WHERE user_id = ?`, userID).Scan(&count)
	approved := 1
	if count > 0 {
		approved = 0
	}

	_, err := db.Exec(
		`INSERT INTO devices (id, user_id, name, public_key, signing_key, approved) VALUES (?, ?, ?, ?, ?, ?)`,
		id, userID, name, publicKey, signingKey, approved,
	)
	if err != nil {
		return nil, err
	}
	return db.GetDevice(id)
}

func (db *DB) GetDevice(id string) (*models.Device, error) {
	d := &models.Device{}
	err := db.QueryRow(
		`SELECT id, user_id, name, public_key, COALESCE(signing_key, ''), COALESCE(approved, 1), created_at FROM devices WHERE id = ?`, id,
	).Scan(&d.ID, &d.UserID, &d.Name, &d.PublicKey, &d.SigningKey, &d.Approved, &d.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, ErrNotFound
	}
	return d, err
}

func (db *DB) GetDevicesForUser(userID string) ([]models.Device, error) {
	rows, err := db.Query(
		`SELECT id, user_id, name, public_key, COALESCE(signing_key, ''), COALESCE(approved, 1), created_at FROM devices WHERE user_id = ?`, userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var devices []models.Device
	for rows.Next() {
		var d models.Device
		if err := rows.Scan(&d.ID, &d.UserID, &d.Name, &d.PublicKey, &d.SigningKey, &d.Approved, &d.CreatedAt); err != nil {
			return nil, err
		}
		devices = append(devices, d)
	}
	return devices, rows.Err()
}

func (db *DB) DeleteDevice(id, userID string) error {
	res, err := db.Exec(`DELETE FROM devices WHERE id = ? AND user_id = ?`, id, userID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (db *DB) ApproveDevice(deviceID, ownerUserID string) error {
	res, err := db.Exec(`UPDATE devices SET approved = 1 WHERE id = ? AND user_id = ?`, deviceID, ownerUserID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (db *DB) GetPendingDevices(userID string) ([]models.Device, error) {
	rows, err := db.Query(
		`SELECT id, user_id, name, public_key, COALESCE(signing_key, ''), 0, created_at FROM devices WHERE user_id = ? AND approved = 0`, userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var devices []models.Device
	for rows.Next() {
		var d models.Device
		if err := rows.Scan(&d.ID, &d.UserID, &d.Name, &d.PublicKey, &d.SigningKey, &d.Approved, &d.CreatedAt); err != nil {
			return nil, err
		}
		devices = append(devices, d)
	}
	return devices, rows.Err()
}

// GetChannelMemberDevices returns all devices belonging to participants of a channel.
// Includes unapproved devices so key distribution covers all devices; the client
// can check the 'approved' field if it needs to filter.
func (db *DB) GetChannelMemberDevices(channelID string) ([]models.Device, error) {
	rows, err := db.Query(
		`SELECT d.id, d.user_id, d.name, d.public_key, COALESCE(d.signing_key, ''), COALESCE(d.approved, 1), d.created_at
		 FROM devices d
		 WHERE d.user_id IN (
		   SELECT user_id FROM server_members WHERE server_id = (
		     SELECT server_id FROM channels WHERE id = ? AND server_id IS NOT NULL
		   )
		   UNION
		   SELECT user_id FROM dm_participants WHERE channel_id = ?
		 )`, channelID, channelID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var devices []models.Device
	for rows.Next() {
		var d models.Device
		if err := rows.Scan(&d.ID, &d.UserID, &d.Name, &d.PublicKey, &d.SigningKey, &d.Approved, &d.CreatedAt); err != nil {
			return nil, err
		}
		devices = append(devices, d)
	}
	return devices, rows.Err()
}
