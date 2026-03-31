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
func (db *DB) GetChannelCurrentEpoch(channelID string) (int, error) {
	var epoch int
	err := db.QueryRow(
		`SELECT COALESCE(MAX(epoch), -1) FROM channel_keys WHERE channel_id = ?`,
		channelID,
	).Scan(&epoch)
	return epoch, err
}

func (db *DB) DeleteChannelKeysForDevice(deviceID string) error {
	_, err := db.Exec(`DELETE FROM channel_keys WHERE device_id = ?`, deviceID)
	return err
}

func (db *DB) DeleteChannelKeysForUser(userID string) error {
	_, err := db.Exec(
		`DELETE FROM channel_keys WHERE device_id IN (SELECT id FROM devices WHERE user_id = ?)`,
		userID,
	)
	return err
}

// DeleteChannelKeysForUserOnChannel removes all key entries for a user's devices on a specific channel.
func (db *DB) DeleteChannelKeysForUserOnChannel(channelID, userID string) error {
	_, err := db.Exec(
		`DELETE FROM channel_keys WHERE channel_id = ? AND device_id IN (SELECT id FROM devices WHERE user_id = ?)`,
		channelID, userID,
	)
	return err
}

func (db *DB) DeleteChannelKeyForDevice(channelID, deviceID string) error {
	_, err := db.Exec(`DELETE FROM channel_keys WHERE channel_id = ? AND device_id = ?`, channelID, deviceID)
	return err
}

func (db *DB) DeleteAllChannelKeys(channelID string) error {
	_, err := db.Exec(`DELETE FROM channel_keys WHERE channel_id = ?`, channelID)
	return err
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
