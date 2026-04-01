package db

import (
	"testing"
)

// newTestDB creates a fresh in-memory SQLite database for testing.
func newTestDB(t *testing.T) *DB {
	t.Helper()
	database, err := New(":memory:")
	if err != nil {
		t.Fatalf("failed to create test database: %v", err)
	}
	t.Cleanup(func() { database.Close() })
	return database
}

func TestNewDB(t *testing.T) {
	db := newTestDB(t)
	if db == nil {
		t.Fatal("expected non-nil database")
	}
	// Verify schema was created
	var count int
	err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='users'`).Scan(&count)
	if err != nil {
		t.Fatalf("failed to query tables: %v", err)
	}
	if count != 1 {
		t.Fatalf("expected users table to exist, got count=%d", count)
	}
}
