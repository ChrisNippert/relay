package db

import "time"

// RevokeToken adds a token hash to the revocation list.
func (db *DB) RevokeToken(tokenHash string, expiresAt time.Time) error {
	_, err := db.Exec(
		`INSERT OR IGNORE INTO revoked_tokens (token_hash, expires_at) VALUES (?, ?)`,
		tokenHash, expiresAt,
	)
	return err
}

// IsTokenRevoked checks if a token hash has been revoked.
func (db *DB) IsTokenRevoked(tokenHash string) (bool, error) {
	var count int
	err := db.QueryRow(
		`SELECT COUNT(*) FROM revoked_tokens WHERE token_hash = ?`,
		tokenHash,
	).Scan(&count)
	return count > 0, err
}

// CleanExpiredTokens removes revoked tokens that have already expired.
func (db *DB) CleanExpiredTokens() error {
	_, err := db.Exec(`DELETE FROM revoked_tokens WHERE expires_at < ?`, time.Now())
	return err
}
