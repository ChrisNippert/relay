package db

import "github.com/relay-chat/relay/internal/models"

// SetChannelKey inserts a key entry for a specific epoch.
// Uses INSERT OR IGNORE — once a (channel, device, epoch) entry exists it cannot be overwritten.
func (db *DB) SetChannelKey(channelID, deviceID string, epoch int, encryptedKey string) error {
	_, err := db.Exec(
		`INSERT OR IGNORE INTO channel_keys (channel_id, device_id, epoch, encrypted_key) VALUES (?, ?, ?, ?)`,
		channelID, deviceID, epoch, encryptedKey,
	)
	return err
}

// GetChannelKeys returns all key entries for all epochs of a channel.
func (db *DB) GetChannelKeys(channelID string) ([]models.ChannelKey, error) {
	rows, err := db.Query(
		`SELECT channel_id, device_id, epoch, encrypted_key FROM channel_keys WHERE channel_id = ?`,
		channelID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var keys []models.ChannelKey
	for rows.Next() {
		var k models.ChannelKey
		if err := rows.Scan(&k.ChannelID, &k.DeviceID, &k.Epoch, &k.EncryptedKey); err != nil {
			return nil, err
		}
		keys = append(keys, k)
	}
	return keys, rows.Err()
}

// GetChannelKeysForEpoch returns key entries for a specific epoch.
func (db *DB) GetChannelKeysForEpoch(channelID string, epoch int) ([]models.ChannelKey, error) {
	rows, err := db.Query(
		`SELECT channel_id, device_id, epoch, encrypted_key FROM channel_keys WHERE channel_id = ? AND epoch = ?`,
		channelID, epoch,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var keys []models.ChannelKey
	for rows.Next() {
		var k models.ChannelKey
		if err := rows.Scan(&k.ChannelID, &k.DeviceID, &k.Epoch, &k.EncryptedKey); err != nil {
			return nil, err
		}
		keys = append(keys, k)
	}
	return keys, rows.Err()
}

// GetChannelCurrentEpoch returns the highest epoch number for a channel, or -1 if none exist.
// Checks both channel_keys and channel_master_keys tables.
func (db *DB) GetChannelCurrentEpoch(channelID string) (int, error) {
	var epoch int
	err := db.QueryRow(
		`SELECT COALESCE(MAX(epoch), -1) FROM (
			SELECT epoch FROM channel_keys WHERE channel_id = ?
			UNION ALL
			SELECT epoch FROM channel_master_keys WHERE channel_id = ?
		)`,
		channelID, channelID,
	).Scan(&epoch)
	return epoch, err
}

// ClaimEpoch atomically claims an epoch for a channel using a dedicated claims table.
// The PRIMARY KEY is (channel_id, epoch) — only one device can claim a given epoch.
// Returns true if this caller won the claim, false if someone else already claimed it.
func (db *DB) ClaimEpoch(channelID, deviceID string, epoch int) (bool, error) {
	result, err := db.Exec(
		`INSERT OR IGNORE INTO epoch_claims (channel_id, epoch, device_id) VALUES (?, ?, ?)`,
		channelID, epoch, deviceID,
	)
	if err != nil {
		return false, err
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	return rows > 0, nil
}

// UpdateChannelKey updates an existing key entry (used after epoch claim to set the real encrypted key).
func (db *DB) UpdateChannelKey(channelID, deviceID string, epoch int, encryptedKey string) error {
	_, err := db.Exec(
		`UPDATE channel_keys SET encrypted_key = ? WHERE channel_id = ? AND device_id = ? AND epoch = ?`,
		encryptedKey, channelID, deviceID, epoch,
	)
	return err
}

func (db *DB) DeleteChannelKeysForDevice(deviceID string) error {
	if _, err := db.Exec(`DELETE FROM channel_keys WHERE device_id = ?`, deviceID); err != nil {
		return err
	}
	_, err := db.Exec(`DELETE FROM channel_master_keys WHERE device_id = ?`, deviceID)
	return err
}

func (db *DB) DeleteChannelKeysForUser(userID string) error {
	if _, err := db.Exec(
		`DELETE FROM channel_keys WHERE device_id IN (SELECT id FROM devices WHERE user_id = ?)`,
		userID,
	); err != nil {
		return err
	}
	_, err := db.Exec(
		`DELETE FROM channel_master_keys WHERE device_id IN (SELECT id FROM devices WHERE user_id = ?)`,
		userID,
	)
	return err
}

// DeleteChannelKeysForUserOnChannel removes all key entries for a user's devices on a specific channel.
func (db *DB) DeleteChannelKeysForUserOnChannel(channelID, userID string) error {
	if _, err := db.Exec(
		`DELETE FROM channel_keys WHERE channel_id = ? AND device_id IN (SELECT id FROM devices WHERE user_id = ?)`,
		channelID, userID,
	); err != nil {
		return err
	}
	_, err := db.Exec(
		`DELETE FROM channel_master_keys WHERE channel_id = ? AND device_id IN (SELECT id FROM devices WHERE user_id = ?)`,
		channelID, userID,
	)
	return err
}

func (db *DB) DeleteChannelKeyForDevice(channelID, deviceID string) error {
	if _, err := db.Exec(`DELETE FROM channel_keys WHERE channel_id = ? AND device_id = ?`, channelID, deviceID); err != nil {
		return err
	}
	_, err := db.Exec(`DELETE FROM channel_master_keys WHERE channel_id = ? AND device_id = ?`, channelID, deviceID)
	return err
}

func (db *DB) DeleteAllChannelKeys(channelID string) error {
	_, err := db.Exec(`DELETE FROM channel_keys WHERE channel_id = ?`, channelID)
	if err != nil {
		return err
	}
	_, err = db.Exec(`DELETE FROM channel_master_keys WHERE channel_id = ?`, channelID)
	return err
}

// SetMasterKeys batch-inserts per-device encrypted keys for a given epoch.
// Uses INSERT OR IGNORE — existing entries are not overwritten.
func (db *DB) SetMasterKeys(channelID string, epoch int, entries []models.ChannelKey) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	for _, e := range entries {
		if _, err := tx.Exec(
			`INSERT OR IGNORE INTO channel_master_keys (channel_id, epoch, device_id, encrypted_key) VALUES (?, ?, ?, ?)`,
			channelID, epoch, e.DeviceID, e.EncryptedKey,
		); err != nil {
			tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

// GetMasterKeys returns all per-device encrypted key entries for a channel.
func (db *DB) GetMasterKeys(channelID string) ([]models.ChannelKey, error) {
	rows, err := db.Query(
		`SELECT channel_id, device_id, epoch, encrypted_key FROM channel_master_keys WHERE channel_id = ? ORDER BY epoch`,
		channelID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var keys []models.ChannelKey
	for rows.Next() {
		var k models.ChannelKey
		if err := rows.Scan(&k.ChannelID, &k.DeviceID, &k.Epoch, &k.EncryptedKey); err != nil {
			return nil, err
		}
		keys = append(keys, k)
	}
	return keys, rows.Err()
}

func (db *DB) GetChannelKeyForDevice(channelID, deviceID string, epoch int) (*models.ChannelKey, error) {
	k := &models.ChannelKey{}
	err := db.QueryRow(
		`SELECT channel_id, device_id, epoch, encrypted_key FROM channel_keys WHERE channel_id = ? AND device_id = ? AND epoch = ?`,
		channelID, deviceID, epoch,
	).Scan(&k.ChannelID, &k.DeviceID, &k.Epoch, &k.EncryptedKey)
	if err != nil {
		return nil, err
	}
	return k, nil
}
