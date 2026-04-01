package db

import (
	"testing"
)

func TestRegisterDevice_FirstAutoApproved(t *testing.T) {
	db := newTestDB(t)
	_, err := db.CreateUser("user-1", "alice", "alice@test.com", "hash1", "Alice")
	if err != nil {
		t.Fatalf("CreateUser failed: %v", err)
	}

	dev, err := db.RegisterDevice("dev-1", "user-1", "Phone", "pk1", "sk1")
	if err != nil {
		t.Fatalf("RegisterDevice failed: %v", err)
	}
	if !dev.Approved {
		t.Error("first device should be auto-approved")
	}
}

func TestRegisterDevice_SecondPendingApproval(t *testing.T) {
	db := newTestDB(t)
	_, _ = db.CreateUser("user-1", "alice", "alice@test.com", "hash1", "Alice")
	db.RegisterDevice("dev-1", "user-1", "Phone", "pk1", "sk1")

	dev2, err := db.RegisterDevice("dev-2", "user-1", "Laptop", "pk2", "sk2")
	if err != nil {
		t.Fatalf("RegisterDevice second failed: %v", err)
	}
	if dev2.Approved {
		t.Error("second device should be pending approval")
	}
}

func TestApproveDevice(t *testing.T) {
	db := newTestDB(t)
	_, _ = db.CreateUser("user-1", "alice", "alice@test.com", "hash1", "Alice")
	db.RegisterDevice("dev-1", "user-1", "Phone", "pk1", "sk1")
	db.RegisterDevice("dev-2", "user-1", "Laptop", "pk2", "sk2")

	err := db.ApproveDevice("dev-2", "user-1")
	if err != nil {
		t.Fatalf("ApproveDevice failed: %v", err)
	}

	dev, err := db.GetDevice("dev-2")
	if err != nil {
		t.Fatalf("GetDevice failed: %v", err)
	}
	if !dev.Approved {
		t.Error("device should be approved after ApproveDevice")
	}
}

func TestApproveDevice_WrongOwner(t *testing.T) {
	db := newTestDB(t)
	_, _ = db.CreateUser("user-1", "alice", "alice@test.com", "hash1", "Alice")
	_, _ = db.CreateUser("user-2", "bob", "bob@test.com", "hash2", "Bob")
	db.RegisterDevice("dev-1", "user-1", "Phone", "pk1", "sk1")
	db.RegisterDevice("dev-2", "user-1", "Laptop", "pk2", "sk2")

	err := db.ApproveDevice("dev-2", "user-2")
	if err == nil {
		t.Error("should fail when non-owner tries to approve")
	}
}

func TestGetDevicesForUser(t *testing.T) {
	db := newTestDB(t)
	_, _ = db.CreateUser("user-1", "alice", "alice@test.com", "hash1", "Alice")
	db.RegisterDevice("dev-1", "user-1", "Phone", "pk1", "sk1")
	db.RegisterDevice("dev-2", "user-1", "Laptop", "pk2", "sk2")

	devices, err := db.GetDevicesForUser("user-1")
	if err != nil {
		t.Fatalf("GetDevicesForUser failed: %v", err)
	}
	if len(devices) != 2 {
		t.Errorf("expected 2 devices, got %d", len(devices))
	}
}

func TestGetPendingDevices(t *testing.T) {
	db := newTestDB(t)
	_, _ = db.CreateUser("user-1", "alice", "alice@test.com", "hash1", "Alice")
	db.RegisterDevice("dev-1", "user-1", "Phone", "pk1", "sk1")
	db.RegisterDevice("dev-2", "user-1", "Laptop", "pk2", "sk2")
	db.RegisterDevice("dev-3", "user-1", "Tablet", "pk3", "sk3")

	pending, err := db.GetPendingDevices("user-1")
	if err != nil {
		t.Fatalf("GetPendingDevices failed: %v", err)
	}
	if len(pending) != 2 {
		t.Errorf("expected 2 pending devices, got %d", len(pending))
	}
}

func TestDeleteDevice(t *testing.T) {
	db := newTestDB(t)
	_, _ = db.CreateUser("user-1", "alice", "alice@test.com", "hash1", "Alice")
	db.RegisterDevice("dev-1", "user-1", "Phone", "pk1", "sk1")

	err := db.DeleteDevice("dev-1", "user-1")
	if err != nil {
		t.Fatalf("DeleteDevice failed: %v", err)
	}

	devices, _ := db.GetDevicesForUser("user-1")
	if len(devices) != 0 {
		t.Errorf("expected 0 devices after delete, got %d", len(devices))
	}
}

func TestDeleteDevice_WrongOwner(t *testing.T) {
	db := newTestDB(t)
	_, _ = db.CreateUser("user-1", "alice", "alice@test.com", "hash1", "Alice")
	_, _ = db.CreateUser("user-2", "bob", "bob@test.com", "hash2", "Bob")
	db.RegisterDevice("dev-1", "user-1", "Phone", "pk1", "sk1")

	err := db.DeleteDevice("dev-1", "user-2")
	if err == nil {
		t.Error("should fail when non-owner tries to delete")
	}

	devices, _ := db.GetDevicesForUser("user-1")
	if len(devices) != 1 {
		t.Errorf("device should still exist, got %d devices", len(devices))
	}
}

func TestGetChannelMemberDevices_ServerChannel(t *testing.T) {
	db := newTestDB(t)
	_, _ = db.CreateUser("user-1", "alice", "alice@test.com", "hash1", "Alice")
	_, _ = db.CreateUser("user-2", "bob", "bob@test.com", "hash2", "Bob")
	db.CreateServer("server-1", "Test Server", "user-1")
	db.AddServerMember("server-1", "user-2", "member")
	db.CreateChannel("chan-1", "server-1", "general", "text", 0, "")

	db.RegisterDevice("dev-1", "user-1", "Phone", "pk1", "sk1")
	db.RegisterDevice("dev-2", "user-2", "Laptop", "pk2", "sk2")

	devices, err := db.GetChannelMemberDevices("chan-1")
	if err != nil {
		t.Fatalf("GetChannelMemberDevices failed: %v", err)
	}
	if len(devices) != 2 {
		t.Errorf("expected 2 devices for server channel, got %d", len(devices))
	}
}

func TestGetChannelMemberDevices_DMChannel(t *testing.T) {
	db := newTestDB(t)
	_, _ = db.CreateUser("user-1", "alice", "alice@test.com", "hash1", "Alice")
	_, _ = db.CreateUser("user-2", "bob", "bob@test.com", "hash2", "Bob")
	db.RegisterDevice("dev-1", "user-1", "Phone", "pk1", "sk1")
	db.RegisterDevice("dev-2", "user-2", "Laptop", "pk2", "sk2")

	db.CreateDMChannel("dm-1", "user-1", "user-2")

	devices, err := db.GetChannelMemberDevices("dm-1")
	if err != nil {
		t.Fatalf("GetChannelMemberDevices for DM failed: %v", err)
	}
	if len(devices) != 2 {
		t.Errorf("expected 2 devices for DM channel, got %d", len(devices))
	}
}

func TestGetChannelMemberDevices_IncludesUnapproved(t *testing.T) {
	db := newTestDB(t)
	_, _ = db.CreateUser("user-1", "alice", "alice@test.com", "hash1", "Alice")
	db.CreateServer("server-1", "Test Server", "user-1")
	db.CreateChannel("chan-1", "server-1", "general", "text", 0, "")

	db.RegisterDevice("dev-1", "user-1", "Phone", "pk1", "sk1")
	db.RegisterDevice("dev-2", "user-1", "Laptop", "pk2", "sk2") // pending (unapproved)

	devices, err := db.GetChannelMemberDevices("chan-1")
	if err != nil {
		t.Fatalf("GetChannelMemberDevices failed: %v", err)
	}
	// Both devices should be returned — key distribution needs all devices
	if len(devices) != 2 {
		t.Errorf("expected 2 devices (including unapproved), got %d", len(devices))
	}
}
