package db

import (
	"database/sql"

	"github.com/relay-chat/relay/internal/models"
)

func (db *DB) CreateUser(id, username, email, passwordHash, displayName string) (*models.User, error) {
	_, err := db.Exec(
		`INSERT INTO users (id, username, email, password_hash, display_name) VALUES (?, ?, ?, ?, ?)`,
		id, username, email, passwordHash, displayName,
	)
	if err != nil {
		return nil, err
	}
	return db.GetUserByID(id)
}

func (db *DB) GetUserByID(id string) (*models.User, error) {
	user := &models.User{}
	err := db.QueryRow(
		`SELECT id, username, email, password_hash, display_name, public_key, avatar_url, status, created_at, updated_at FROM users WHERE id = ?`,
		id,
	).Scan(&user.ID, &user.Username, &user.Email, &user.PasswordHash, &user.DisplayName,
		&user.PublicKey, &user.AvatarURL, &user.Status, &user.CreatedAt, &user.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, ErrNotFound
	}
	return user, err
}

func (db *DB) GetUserByEmail(email string) (*models.User, error) {
	user := &models.User{}
	err := db.QueryRow(
		`SELECT id, username, email, password_hash, display_name, public_key, avatar_url, status, created_at, updated_at FROM users WHERE email = ?`,
		email,
	).Scan(&user.ID, &user.Username, &user.Email, &user.PasswordHash, &user.DisplayName,
		&user.PublicKey, &user.AvatarURL, &user.Status, &user.CreatedAt, &user.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, ErrNotFound
	}
	return user, err
}

func (db *DB) UpdateUser(id, displayName, avatarURL string) (*models.User, error) {
	_, err := db.Exec(
		`UPDATE users SET display_name = ?, avatar_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
		displayName, avatarURL, id,
	)
	if err != nil {
		return nil, err
	}
	return db.GetUserByID(id)
}

func (db *DB) UpdatePublicKey(id, publicKey string) error {
	_, err := db.Exec(
		`UPDATE users SET public_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
		publicKey, id,
	)
	return err
}

func (db *DB) UpdateUserStatus(id, status string) error {
	_, err := db.Exec(
		`UPDATE users SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
		status, id,
	)
	return err
}

func (db *DB) SearchUsers(query string) ([]models.User, error) {
	rows, err := db.Query(
		`SELECT id, username, display_name, avatar_url, status FROM users WHERE username LIKE ? OR display_name LIKE ? LIMIT 20`,
		"%"+query+"%", "%"+query+"%",
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var users []models.User
	for rows.Next() {
		var u models.User
		if err := rows.Scan(&u.ID, &u.Username, &u.DisplayName, &u.AvatarURL, &u.Status); err != nil {
			return nil, err
		}
		users = append(users, u)
	}
	return users, rows.Err()
}
