package db

import (
	"database/sql"

	"github.com/relay-chat/relay/internal/models"
)

func (db *DB) RegisterDevice(id, userID, name, publicKey, signingKey string) (*models.Device, error) {
	_, err := db.Exec(
		`INSERT INTO devices (id, user_id, name, public_key, signing_key) VALUES (?, ?, ?, ?, ?)`,
		id, userID, name, publicKey, signingKey,
	)
	if err != nil {
		return nil, err
	}
	return db.GetDevice(id)
}

func (db *DB) GetDevice(id string) (*models.Device, error) {
	d := &models.Device{}
	err := db.QueryRow(
		`SELECT id, user_id, name, public_key, COALESCE(signing_key, ''), created_at FROM devices WHERE id = ?`, id,
	).Scan(&d.ID, &d.UserID, &d.Name, &d.PublicKey, &d.SigningKey, &d.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, ErrNotFound
	}
	return d, err
}

func (db *DB) GetDevicesForUser(userID string) ([]models.Device, error) {
	rows, err := db.Query(
		`SELECT id, user_id, name, public_key, COALESCE(signing_key, ''), created_at FROM devices WHERE user_id = ?`, userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var devices []models.Device
	for rows.Next() {
		var d models.Device
		if err := rows.Scan(&d.ID, &d.UserID, &d.Name, &d.PublicKey, &d.SigningKey, &d.CreatedAt); err != nil {
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

// GetChannelMemberDevices returns all devices belonging to participants of a channel.
func (db *DB) GetChannelMemberDevices(channelID string) ([]models.Device, error) {
	rows, err := db.Query(
		`SELECT d.id, d.user_id, d.name, d.public_key, COALESCE(d.signing_key, ''), d.created_at
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
		if err := rows.Scan(&d.ID, &d.UserID, &d.Name, &d.PublicKey, &d.SigningKey, &d.CreatedAt); err != nil {
			return nil, err
		}
		devices = append(devices, d)
	}
	return devices, rows.Err()
}
