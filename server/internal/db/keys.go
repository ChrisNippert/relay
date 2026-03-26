package db

import "github.com/relay-chat/relay/internal/models"

func (db *DB) SetChannelKey(channelID, userID, encryptedKey string) error {
	_, err := db.Exec(
		`INSERT OR REPLACE INTO channel_keys (channel_id, user_id, encrypted_key) VALUES (?, ?, ?)`,
		channelID, userID, encryptedKey,
	)
	return err
}

func (db *DB) GetChannelKeys(channelID string) ([]models.ChannelKey, error) {
	rows, err := db.Query(
		`SELECT channel_id, user_id, encrypted_key FROM channel_keys WHERE channel_id = ?`,
		channelID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var keys []models.ChannelKey
	for rows.Next() {
		var k models.ChannelKey
		if err := rows.Scan(&k.ChannelID, &k.UserID, &k.EncryptedKey); err != nil {
			return nil, err
		}
		keys = append(keys, k)
	}
	return keys, rows.Err()
}

func (db *DB) DeleteChannelKeysForUser(userID string) error {
	_, err := db.Exec(`DELETE FROM channel_keys WHERE user_id = ?`, userID)
	return err
}

func (db *DB) GetChannelKeyForUser(channelID, userID string) (*models.ChannelKey, error) {
	k := &models.ChannelKey{}
	err := db.QueryRow(
		`SELECT channel_id, user_id, encrypted_key FROM channel_keys WHERE channel_id = ? AND user_id = ?`,
		channelID, userID,
	).Scan(&k.ChannelID, &k.UserID, &k.EncryptedKey)
	if err != nil {
		return nil, err
	}
	return k, nil
}
