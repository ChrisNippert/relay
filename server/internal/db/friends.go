package db

import "github.com/relay-chat/relay/internal/models"

func (db *DB) CreateFriendship(id, userID, friendID string) (*models.Friendship, error) {
	_, err := db.Exec(
		`INSERT INTO friendships (id, user_id, friend_id, status) VALUES (?, ?, ?, 'pending')`,
		id, userID, friendID,
	)
	if err != nil {
		return nil, err
	}
	return db.GetFriendship(id)
}

func (db *DB) GetFriendship(id string) (*models.Friendship, error) {
	f := &models.Friendship{}
	err := db.QueryRow(
		`SELECT id, user_id, friend_id, status, created_at FROM friendships WHERE id = ?`,
		id,
	).Scan(&f.ID, &f.UserID, &f.FriendID, &f.Status, &f.CreatedAt)
	if err != nil {
		return nil, err
	}
	return f, nil
}

func (db *DB) AcceptFriendship(id string) error {
	_, err := db.Exec(
		`UPDATE friendships SET status = 'accepted' WHERE id = ?`,
		id,
	)
	return err
}

func (db *DB) DeleteFriendship(id string) error {
	_, err := db.Exec(`DELETE FROM friendships WHERE id = ?`, id)
	return err
}

func (db *DB) GetFriendships(userID string) ([]models.Friendship, error) {
	rows, err := db.Query(
		`SELECT id, user_id, friend_id, status, created_at FROM friendships WHERE user_id = ? OR friend_id = ?`,
		userID, userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var friendships []models.Friendship
	for rows.Next() {
		var f models.Friendship
		if err := rows.Scan(&f.ID, &f.UserID, &f.FriendID, &f.Status, &f.CreatedAt); err != nil {
			return nil, err
		}
		friendships = append(friendships, f)
	}
	return friendships, rows.Err()
}

func (db *DB) GetFriendshipBetween(userID1, userID2 string) (*models.Friendship, error) {
	f := &models.Friendship{}
	err := db.QueryRow(
		`SELECT id, user_id, friend_id, status, created_at FROM friendships
		 WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)`,
		userID1, userID2, userID2, userID1,
	).Scan(&f.ID, &f.UserID, &f.FriendID, &f.Status, &f.CreatedAt)
	if err != nil {
		return nil, err
	}
	return f, nil
}
