package db

import (
	"testing"
)

func TestSetAndGetChannelKey(t *testing.T) {
	db := newTestDB(t)
	setupKeyTestData(t, db)

	err := db.SetChannelKey("chan-1", "device-1", 0, "encrypted-key-data")
	if err != nil {
		t.Fatalf("SetChannelKey failed: %v", err)
	}

	keys, err := db.GetChannelKeys("chan-1")
	if err != nil {
		t.Fatalf("GetChannelKeys failed: %v", err)
	}
	if len(keys) != 1 {
		t.Fatalf("expected 1 key, got %d", len(keys))
	}
	if keys[0].ChannelID != "chan-1" || keys[0].DeviceID != "device-1" || keys[0].Epoch != 0 {
		t.Errorf("unexpected key: %+v", keys[0])
	}
	if keys[0].EncryptedKey != "encrypted-key-data" {
		t.Errorf("expected encrypted key data, got %q", keys[0].EncryptedKey)
	}
}

func TestSetChannelKeyInsertOrIgnore(t *testing.T) {
	db := newTestDB(t)
	setupKeyTestData(t, db)

	if err := db.SetChannelKey("chan-1", "device-1", 0, "original-key"); err != nil {
		t.Fatalf("first SetChannelKey failed: %v", err)
	}
	if err := db.SetChannelKey("chan-1", "device-1", 0, "overwrite-attempt"); err != nil {
		t.Fatalf("second SetChannelKey failed: %v", err)
	}

	key, err := db.GetChannelKeyForDevice("chan-1", "device-1", 0)
	if err != nil {
		t.Fatalf("GetChannelKeyForDevice failed: %v", err)
	}
	if key.EncryptedKey != "original-key" {
		t.Errorf("INSERT OR IGNORE failed: expected %q, got %q", "original-key", key.EncryptedKey)
	}
}

func TestGetChannelKeysForEpoch(t *testing.T) {
	db := newTestDB(t)
	setupKeyTestData(t, db)

	db.SetChannelKey("chan-1", "device-1", 0, "key-d1-e0")
	db.SetChannelKey("chan-1", "device-2", 0, "key-d2-e0")
	db.SetChannelKey("chan-1", "device-1", 1, "key-d1-e1")

	keys, err := db.GetChannelKeysForEpoch("chan-1", 0)
	if err != nil {
		t.Fatalf("GetChannelKeysForEpoch failed: %v", err)
	}
	if len(keys) != 2 {
		t.Fatalf("expected 2 keys at epoch 0, got %d", len(keys))
	}

	keys, err = db.GetChannelKeysForEpoch("chan-1", 1)
	if err != nil {
		t.Fatalf("GetChannelKeysForEpoch for epoch 1 failed: %v", err)
	}
	if len(keys) != 1 {
		t.Fatalf("expected 1 key at epoch 1, got %d", len(keys))
	}
	if keys[0].EncryptedKey != "key-d1-e1" {
		t.Errorf("expected key-d1-e1, got %q", keys[0].EncryptedKey)
	}
}

func TestGetChannelCurrentEpoch(t *testing.T) {
	db := newTestDB(t)
	setupKeyTestData(t, db)

	epoch, err := db.GetChannelCurrentEpoch("chan-1")
	if err != nil {
		t.Fatalf("GetChannelCurrentEpoch failed: %v", err)
	}
	if epoch != -1 {
		t.Errorf("expected epoch -1 for empty channel, got %d", epoch)
	}

	db.SetChannelKey("chan-1", "device-1", 0, "key-e0")
	db.SetChannelKey("chan-1", "device-1", 3, "key-e3")

	epoch, err = db.GetChannelCurrentEpoch("chan-1")
	if err != nil {
		t.Fatalf("GetChannelCurrentEpoch failed: %v", err)
	}
	if epoch != 3 {
		t.Errorf("expected epoch 3, got %d", epoch)
	}
}

func TestGetChannelKeyForDevice(t *testing.T) {
	db := newTestDB(t)
	setupKeyTestData(t, db)

	db.SetChannelKey("chan-1", "device-1", 0, "key-data")

	key, err := db.GetChannelKeyForDevice("chan-1", "device-1", 0)
	if err != nil {
		t.Fatalf("GetChannelKeyForDevice failed: %v", err)
	}
	if key.EncryptedKey != "key-data" {
		t.Errorf("expected key-data, got %q", key.EncryptedKey)
	}

	_, err = db.GetChannelKeyForDevice("chan-1", "device-1", 99)
	if err == nil {
		t.Error("expected error for non-existent key")
	}
}

func TestDeleteChannelKeysForDevice(t *testing.T) {
	db := newTestDB(t)
	setupKeyTestData(t, db)

	db.SetChannelKey("chan-1", "device-1", 0, "key1")
	db.SetChannelKey("chan-1", "device-1", 1, "key2")
	db.SetChannelKey("chan-1", "device-2", 0, "key3")

	err := db.DeleteChannelKeysForDevice("device-1")
	if err != nil {
		t.Fatalf("DeleteChannelKeysForDevice failed: %v", err)
	}

	keys, _ := db.GetChannelKeys("chan-1")
	if len(keys) != 1 {
		t.Fatalf("expected 1 remaining key, got %d", len(keys))
	}
	if keys[0].DeviceID != "device-2" {
		t.Errorf("expected device-2 key to remain, got device %q", keys[0].DeviceID)
	}
}

func TestDeleteChannelKeysForUser(t *testing.T) {
	db := newTestDB(t)
	setupKeyTestData(t, db)

	db.SetChannelKey("chan-1", "device-1", 0, "key1")
	db.SetChannelKey("chan-1", "device-2", 0, "key2")

	err := db.DeleteChannelKeysForUser("user-1")
	if err != nil {
		t.Fatalf("DeleteChannelKeysForUser failed: %v", err)
	}

	keys, _ := db.GetChannelKeys("chan-1")
	if len(keys) != 1 {
		t.Fatalf("expected 1 key remaining, got %d", len(keys))
	}
	if keys[0].DeviceID != "device-2" {
		t.Errorf("expected device-2 key to remain")
	}
}

func TestDeleteChannelKeysForUserOnChannel(t *testing.T) {
	db := newTestDB(t)
	setupKeyTestData(t, db)

	db.SetChannelKey("chan-1", "device-1", 0, "key1")

	db.Exec("INSERT INTO channels (id, server_id, name, type, position) VALUES ('chan-2', 'server-1', 'other', 'text', 1)")
	db.SetChannelKey("chan-2", "device-1", 0, "key2")

	err := db.DeleteChannelKeysForUserOnChannel("chan-1", "user-1")
	if err != nil {
		t.Fatalf("DeleteChannelKeysForUserOnChannel failed: %v", err)
	}

	keys1, _ := db.GetChannelKeys("chan-1")
	if len(keys1) != 0 {
		t.Errorf("expected 0 keys on chan-1, got %d", len(keys1))
	}

	keys2, _ := db.GetChannelKeys("chan-2")
	if len(keys2) != 1 {
		t.Errorf("expected 1 key on chan-2, got %d", len(keys2))
	}
}

func TestDeleteAllChannelKeys(t *testing.T) {
	db := newTestDB(t)
	setupKeyTestData(t, db)

	db.SetChannelKey("chan-1", "device-1", 0, "key1")
	db.SetChannelKey("chan-1", "device-2", 1, "key2")

	err := db.DeleteAllChannelKeys("chan-1")
	if err != nil {
		t.Fatalf("DeleteAllChannelKeys failed: %v", err)
	}

	keys, _ := db.GetChannelKeys("chan-1")
	if len(keys) != 0 {
		t.Errorf("expected 0 keys after delete all, got %d", len(keys))
	}
}

func TestMultipleEpochsMultipleDevices(t *testing.T) {
	db := newTestDB(t)
	setupKeyTestData(t, db)

	db.SetChannelKey("chan-1", "device-1", 0, "e0-d1")
	db.SetChannelKey("chan-1", "device-2", 0, "e0-d2")
	db.SetChannelKey("chan-1", "device-1", 1, "e1-d1")
	db.SetChannelKey("chan-1", "device-2", 1, "e1-d2")
	db.SetChannelKey("chan-1", "device-1", 2, "e2-d1")
	db.SetChannelKey("chan-1", "device-2", 2, "e2-d2")

	epoch, _ := db.GetChannelCurrentEpoch("chan-1")
	if epoch != 2 {
		t.Errorf("expected current epoch 2, got %d", epoch)
	}

	keys, _ := db.GetChannelKeys("chan-1")
	if len(keys) != 6 {
		t.Errorf("expected 6 total keys, got %d", len(keys))
	}

	e1Keys, _ := db.GetChannelKeysForEpoch("chan-1", 1)
	if len(e1Keys) != 2 {
		t.Errorf("expected 2 keys at epoch 1, got %d", len(e1Keys))
	}
}

func setupKeyTestData(t *testing.T, db *DB) {
	t.Helper()

	_, err := db.CreateUser("user-1", "alice", "alice@test.com", "hash1", "Alice")
	if err != nil {
		t.Fatalf("failed to create user-1: %v", err)
	}
	_, err = db.CreateUser("user-2", "bob", "bob@test.com", "hash2", "Bob")
	if err != nil {
		t.Fatalf("failed to create user-2: %v", err)
	}

	_, err = db.CreateServer("server-1", "Test Server", "user-1")
	if err != nil {
		t.Fatalf("failed to create server: %v", err)
	}

	if err := db.AddServerMember("server-1", "user-2", "member"); err != nil {
		t.Fatalf("failed to add user-2 to server: %v", err)
	}

	_, err = db.CreateChannel("chan-1", "server-1", "encrypted", "text", 0, "")
	if err != nil {
		t.Fatalf("failed to create channel: %v", err)
	}

	_, err = db.RegisterDevice("device-1", "user-1", "Alice Phone", "pk-alice", "sk-alice")
	if err != nil {
		t.Fatalf("failed to register device-1: %v", err)
	}
	_, err = db.RegisterDevice("device-2", "user-2", "Bob Laptop", "pk-bob", "sk-bob")
	if err != nil {
		t.Fatalf("failed to register device-2: %v", err)
	}
}

func TestClaimEpochFirstCallerWins(t *testing.T) {
	db := newTestDB(t)
	setupKeyTestData(t, db)

	claimed, err := db.ClaimEpoch("chan-1", "device-1", 0)
	if err != nil {
		t.Fatalf("ClaimEpoch failed: %v", err)
	}
	if !claimed {
		t.Error("first caller should win the claim")
	}
}

func TestClaimEpochSecondCallerLoses(t *testing.T) {
	db := newTestDB(t)
	setupKeyTestData(t, db)

	claimed1, err := db.ClaimEpoch("chan-1", "device-1", 0)
	if err != nil {
		t.Fatalf("ClaimEpoch (first) failed: %v", err)
	}
	if !claimed1 {
		t.Error("first caller should win")
	}

	claimed2, err := db.ClaimEpoch("chan-1", "device-2", 0)
	if err != nil {
		t.Fatalf("ClaimEpoch (second) failed: %v", err)
	}
	if claimed2 {
		t.Error("second caller should lose the claim")
	}
}

func TestClaimPendingNotInChannelKeys(t *testing.T) {
	db := newTestDB(t)
	setupKeyTestData(t, db)

	// Claiming an epoch should NOT create any row in channel_keys
	db.ClaimEpoch("chan-1", "device-1", 0)

	keys, err := db.GetChannelKeys("chan-1")
	if err != nil {
		t.Fatalf("GetChannelKeys failed: %v", err)
	}
	if len(keys) != 0 {
		t.Errorf("expected 0 keys in channel_keys after claim, got %d", len(keys))
	}

	epoch, err := db.GetChannelCurrentEpoch("chan-1")
	if err != nil {
		t.Fatalf("GetChannelCurrentEpoch failed: %v", err)
	}
	if epoch != -1 {
		t.Errorf("expected epoch -1 (no real keys), got %d", epoch)
	}
}

func TestSetChannelKeyAfterClaim(t *testing.T) {
	db := newTestDB(t)
	setupKeyTestData(t, db)

	// Claim epoch 0 for device-1
	claimed, _ := db.ClaimEpoch("chan-1", "device-1", 0)
	if !claimed {
		t.Fatal("claim should succeed")
	}

	// SetChannelKey inserts the real key (claim is in a separate table)
	err := db.SetChannelKey("chan-1", "device-1", 0, "real-encrypted-key")
	if err != nil {
		t.Fatalf("SetChannelKey failed: %v", err)
	}

	keys, _ := db.GetChannelKeys("chan-1")
	if len(keys) != 1 {
		t.Fatalf("expected 1 key, got %d", len(keys))
	}
	if keys[0].EncryptedKey != "real-encrypted-key" {
		t.Errorf("expected real key, got %q", keys[0].EncryptedKey)
	}
}

func TestSetChannelKeyDoesNotOverwriteRealKey(t *testing.T) {
	db := newTestDB(t)
	setupKeyTestData(t, db)

	// Set a real key
	db.SetChannelKey("chan-1", "device-1", 0, "original-real-key")

	// Another SetChannelKey should NOT overwrite it
	db.SetChannelKey("chan-1", "device-1", 0, "attacker-replacement")

	key, _ := db.GetChannelKeyForDevice("chan-1", "device-1", 0)
	if key.EncryptedKey != "original-real-key" {
		t.Errorf("real key was overwritten: expected %q, got %q", "original-real-key", key.EncryptedKey)
	}
}

func TestClaimDifferentEpochsIndependent(t *testing.T) {
	db := newTestDB(t)
	setupKeyTestData(t, db)

	// Device-1 claims epoch 0
	c0, _ := db.ClaimEpoch("chan-1", "device-1", 0)
	if !c0 {
		t.Error("device-1 should claim epoch 0")
	}

	// Device-2 can still claim epoch 1 (different epoch)
	c1, _ := db.ClaimEpoch("chan-1", "device-2", 1)
	if !c1 {
		t.Error("device-2 should claim epoch 1")
	}
}
