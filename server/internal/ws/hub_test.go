package ws

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/relay-chat/relay/internal/db"
)

// newTestDB creates a fresh in-memory SQLite database for hub tests.
func newTestDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.New(":memory:")
	if err != nil {
		t.Fatalf("failed to create test db: %v", err)
	}
	t.Cleanup(func() { database.Close() })
	return database
}

// newTestClient creates a Client with a nil websocket conn.
// Only the send channel is used in hub routing tests.
func newTestClient(hub *Hub, userID string) *Client {
	return &Client{
		hub:    hub,
		conn:   nil,
		userID: userID,
		send:   make(chan []byte, 256),
	}
}

// setupTestWorld creates users, a server, and a channel in the test DB.
// Returns (serverID, channelID).
func setupTestWorld(t *testing.T, database *db.DB) (string, string) {
	t.Helper()
	database.CreateUser("alice", "alice", "alice@test.com", "hash", "Alice")
	database.CreateUser("bob", "bob", "bob@test.com", "hash", "Bob")
	database.CreateUser("charlie", "charlie", "charlie@test.com", "hash", "Charlie")

	database.CreateServer("srv-1", "Test Server", "alice")
	database.AddServerMember("srv-1", "bob", "member")
	database.AddServerMember("srv-1", "charlie", "member")

	database.CreateChannel("chan-1", "srv-1", "general", "text", 0, "")

	return "srv-1", "chan-1"
}

// directRegister bypasses the Run() goroutine and directly registers a client.
func directRegister(h *Hub, c *Client) {
	h.mu.Lock()
	if h.clients[c.userID] == nil {
		h.clients[c.userID] = make(map[*Client]bool)
	}
	h.clients[c.userID][c] = true
	h.mu.Unlock()
}

// directUnregister bypasses the Run() goroutine and directly unregisters a client.
func directUnregister(h *Hub, c *Client) {
	h.mu.Lock()
	conns := h.clients[c.userID]
	delete(conns, c)
	if len(conns) == 0 {
		delete(h.clients, c.userID)
	}
	h.mu.Unlock()
}

// drainMessages reads all pending messages from a client's send channel.
func drainMessages(c *Client, timeout time.Duration) []WSMessage {
	var msgs []WSMessage
	deadline := time.After(timeout)
	for {
		select {
		case data := <-c.send:
			var msg WSMessage
			if err := json.Unmarshal(data, &msg); err == nil {
				msgs = append(msgs, msg)
			}
		case <-deadline:
			return msgs
		}
	}
}

// ──── Presence Sync Tests ────

func TestSendPresenceSync_ReceivesOnlinePeers(t *testing.T) {
	database := newTestDB(t)
	hub := NewHub(database)
	serverID, _ := setupTestWorld(t, database)
	_ = serverID

	// Register Alice (already online)
	aliceClient := newTestClient(hub, "alice")
	directRegister(hub, aliceClient)

	// Now Bob connects — sendPresenceSync should inform Bob that Alice is online
	bobClient := newTestClient(hub, "bob")
	directRegister(hub, bobClient)
	hub.sendPresenceSync(bobClient)

	msgs := drainMessages(bobClient, 50*time.Millisecond)

	// Bob should receive at least one presence message for Alice
	var alicePresence bool
	for _, msg := range msgs {
		if msg.Type == "presence" {
			var payload map[string]string
			json.Unmarshal(msg.Payload, &payload)
			if payload["user_id"] == "alice" && payload["status"] == "online" {
				alicePresence = true
			}
		}
	}
	if !alicePresence {
		t.Errorf("Bob did not receive Alice's online presence; got %d messages", len(msgs))
	}

	// Cleanup
	directUnregister(hub, aliceClient)
	directUnregister(hub, bobClient)
}

func TestSendPresenceSync_DoesNotReceiveOfflinePeers(t *testing.T) {
	database := newTestDB(t)
	hub := NewHub(database)
	setupTestWorld(t, database)

	// Alice is NOT online (not registered)
	// Bob connects
	bobClient := newTestClient(hub, "bob")
	directRegister(hub, bobClient)
	hub.sendPresenceSync(bobClient)

	msgs := drainMessages(bobClient, 50*time.Millisecond)

	// Bob should NOT receive any presence messages for Alice
	for _, msg := range msgs {
		if msg.Type == "presence" {
			var payload map[string]string
			json.Unmarshal(msg.Payload, &payload)
			if payload["user_id"] == "alice" {
				t.Errorf("Bob received presence for offline Alice: %v", payload)
			}
		}
	}

	directUnregister(hub, bobClient)
}

func TestSendPresenceSync_MultipleOnlinePeers(t *testing.T) {
	database := newTestDB(t)
	hub := NewHub(database)
	setupTestWorld(t, database)

	// Alice and Charlie both online
	aliceClient := newTestClient(hub, "alice")
	charlieClient := newTestClient(hub, "charlie")
	directRegister(hub, aliceClient)
	directRegister(hub, charlieClient)

	// Bob connects
	bobClient := newTestClient(hub, "bob")
	directRegister(hub, bobClient)
	hub.sendPresenceSync(bobClient)

	msgs := drainMessages(bobClient, 50*time.Millisecond)

	onlineUsers := map[string]bool{}
	for _, msg := range msgs {
		if msg.Type == "presence" {
			var payload map[string]string
			json.Unmarshal(msg.Payload, &payload)
			if payload["status"] == "online" {
				onlineUsers[payload["user_id"]] = true
			}
		}
	}
	if !onlineUsers["alice"] || !onlineUsers["charlie"] {
		t.Errorf("Expected Alice and Charlie online, got: %v", onlineUsers)
	}

	directUnregister(hub, aliceClient)
	directUnregister(hub, charlieClient)
	directUnregister(hub, bobClient)
}

// ──── Broadcast Presence Tests ────

func TestBroadcastPresence_NotifiesPeers(t *testing.T) {
	database := newTestDB(t)
	hub := NewHub(database)
	setupTestWorld(t, database)

	// Bob is already online
	bobClient := newTestClient(hub, "bob")
	directRegister(hub, bobClient)

	// Alice comes online — Bob should be notified
	hub.broadcastPresence("alice", "online")

	msgs := drainMessages(bobClient, 50*time.Millisecond)

	var found bool
	for _, msg := range msgs {
		if msg.Type == "presence" {
			var payload map[string]string
			json.Unmarshal(msg.Payload, &payload)
			if payload["user_id"] == "alice" && payload["status"] == "online" {
				found = true
			}
		}
	}
	if !found {
		t.Error("Bob did not receive Alice's online broadcast")
	}

	directUnregister(hub, bobClient)
}

func TestBroadcastPresence_OfflineNotification(t *testing.T) {
	database := newTestDB(t)
	hub := NewHub(database)
	setupTestWorld(t, database)

	bobClient := newTestClient(hub, "bob")
	directRegister(hub, bobClient)

	hub.broadcastPresence("alice", "offline")

	msgs := drainMessages(bobClient, 50*time.Millisecond)
	var found bool
	for _, msg := range msgs {
		if msg.Type == "presence" {
			var payload map[string]string
			json.Unmarshal(msg.Payload, &payload)
			if payload["user_id"] == "alice" && payload["status"] == "offline" {
				found = true
			}
		}
	}
	if !found {
		t.Error("Bob did not receive Alice's offline broadcast")
	}

	directUnregister(hub, bobClient)
}

func TestBroadcastPresence_DoesNotNotifyUnrelatedUsers(t *testing.T) {
	database := newTestDB(t)
	hub := NewHub(database)

	// Create two separate servers with no shared members
	database.CreateUser("dave", "dave", "dave@test.com", "hash", "Dave")
	database.CreateUser("eve", "eve", "eve@test.com", "hash", "Eve")
	database.CreateServer("srv-a", "Server A", "dave")
	database.CreateServer("srv-b", "Server B", "eve")

	daveClient := newTestClient(hub, "dave")
	directRegister(hub, daveClient)

	// Eve comes online — Dave should NOT be notified (no shared server)
	hub.broadcastPresence("eve", "online")

	msgs := drainMessages(daveClient, 50*time.Millisecond)
	if len(msgs) > 0 {
		t.Errorf("Dave received %d unexpected messages from unrelated user Eve", len(msgs))
	}

	directUnregister(hub, daveClient)
}

// ──── SendToServer Tests ────

func TestSendToServer_ReachesAllMembers(t *testing.T) {
	database := newTestDB(t)
	hub := NewHub(database)
	serverID, _ := setupTestWorld(t, database)

	aliceClient := newTestClient(hub, "alice")
	bobClient := newTestClient(hub, "bob")
	charlieClient := newTestClient(hub, "charlie")
	directRegister(hub, aliceClient)
	directRegister(hub, bobClient)
	directRegister(hub, charlieClient)

	testData := mustMarshal(WSMessage{Type: "test", Payload: json.RawMessage(`{"hello":"world"}`)})
	hub.SendToServer(serverID, testData)

	for _, c := range []*Client{aliceClient, bobClient, charlieClient} {
		msgs := drainMessages(c, 50*time.Millisecond)
		if len(msgs) != 1 {
			t.Errorf("User %s expected 1 message, got %d", c.userID, len(msgs))
		} else if msgs[0].Type != "test" {
			t.Errorf("User %s expected type=test, got %s", c.userID, msgs[0].Type)
		}
	}

	directUnregister(hub, aliceClient)
	directUnregister(hub, bobClient)
	directUnregister(hub, charlieClient)
}

func TestSendToServer_SkipsOfflineMembers(t *testing.T) {
	database := newTestDB(t)
	hub := NewHub(database)
	serverID, _ := setupTestWorld(t, database)

	// Only Alice is online
	aliceClient := newTestClient(hub, "alice")
	directRegister(hub, aliceClient)

	testData := mustMarshal(WSMessage{Type: "test", Payload: json.RawMessage(`{}`)})
	hub.SendToServer(serverID, testData)

	msgs := drainMessages(aliceClient, 50*time.Millisecond)
	if len(msgs) != 1 {
		t.Errorf("Alice expected 1 message, got %d", len(msgs))
	}
	// Bob and Charlie don't panic or cause issues (they're nil / not registered)

	directUnregister(hub, aliceClient)
}

// ──── SendToChannel Tests ────

func TestSendToChannel_ReachesMembers(t *testing.T) {
	database := newTestDB(t)
	hub := NewHub(database)
	_, channelID := setupTestWorld(t, database)

	aliceClient := newTestClient(hub, "alice")
	bobClient := newTestClient(hub, "bob")
	directRegister(hub, aliceClient)
	directRegister(hub, bobClient)

	testData := mustMarshal(WSMessage{Type: "channel_msg", Payload: json.RawMessage(`{}`)})
	hub.SendToChannel(channelID, testData, "")

	for _, c := range []*Client{aliceClient, bobClient} {
		msgs := drainMessages(c, 50*time.Millisecond)
		if len(msgs) != 1 {
			t.Errorf("User %s expected 1 message, got %d", c.userID, len(msgs))
		}
	}

	directUnregister(hub, aliceClient)
	directUnregister(hub, bobClient)
}

func TestSendToChannel_ExcludesUser(t *testing.T) {
	database := newTestDB(t)
	hub := NewHub(database)
	_, channelID := setupTestWorld(t, database)

	aliceClient := newTestClient(hub, "alice")
	bobClient := newTestClient(hub, "bob")
	directRegister(hub, aliceClient)
	directRegister(hub, bobClient)

	testData := mustMarshal(WSMessage{Type: "msg", Payload: json.RawMessage(`{}`)})
	hub.SendToChannel(channelID, testData, "alice") // exclude Alice

	aliceMsgs := drainMessages(aliceClient, 50*time.Millisecond)
	bobMsgs := drainMessages(bobClient, 50*time.Millisecond)

	if len(aliceMsgs) != 0 {
		t.Errorf("Alice should have been excluded but got %d messages", len(aliceMsgs))
	}
	if len(bobMsgs) != 1 {
		t.Errorf("Bob expected 1 message, got %d", len(bobMsgs))
	}

	directUnregister(hub, aliceClient)
	directUnregister(hub, bobClient)
}

// ──── SendToUser Tests ────

func TestSendToUser_DeliversToAllSessions(t *testing.T) {
	database := newTestDB(t)
	hub := NewHub(database)
	database.CreateUser("alice", "alice", "alice@test.com", "hash", "Alice")

	// Alice has 3 concurrent sessions (e.g. phone, laptop, desktop)
	clients := make([]*Client, 3)
	for i := range clients {
		clients[i] = newTestClient(hub, "alice")
		directRegister(hub, clients[i])
	}

	testData := mustMarshal(WSMessage{Type: "dm", Payload: json.RawMessage(`{"text":"hi"}`)})
	hub.SendToUser("alice", testData)

	for i, c := range clients {
		msgs := drainMessages(c, 50*time.Millisecond)
		if len(msgs) != 1 {
			t.Errorf("Session %d: expected 1 message, got %d", i, len(msgs))
		}
	}

	for _, c := range clients {
		directUnregister(hub, c)
	}
}

// ──── Register/Unregister Lifecycle Tests ────

func TestIsUserOnline_TrueWhenRegistered(t *testing.T) {
	database := newTestDB(t)
	hub := NewHub(database)
	database.CreateUser("alice", "alice", "alice@test.com", "hash", "Alice")

	if hub.IsUserOnline("alice") {
		t.Error("Alice should be offline initially")
	}

	client := newTestClient(hub, "alice")
	directRegister(hub, client)

	if !hub.IsUserOnline("alice") {
		t.Error("Alice should be online after registration")
	}

	directUnregister(hub, client)

	if hub.IsUserOnline("alice") {
		t.Error("Alice should be offline after unregistration")
	}
}

func TestMultipleConnections_OnlineUntilLastDisconnects(t *testing.T) {
	database := newTestDB(t)
	hub := NewHub(database)
	database.CreateUser("alice", "alice", "alice@test.com", "hash", "Alice")

	c1 := newTestClient(hub, "alice")
	c2 := newTestClient(hub, "alice")
	directRegister(hub, c1)
	directRegister(hub, c2)

	if !hub.IsUserOnline("alice") {
		t.Error("Alice should be online with 2 connections")
	}

	directUnregister(hub, c1)
	if !hub.IsUserOnline("alice") {
		t.Error("Alice should still be online with 1 remaining connection")
	}

	directUnregister(hub, c2)
	if hub.IsUserOnline("alice") {
		t.Error("Alice should be offline after all connections removed")
	}
}

func TestGetOnlineUserIDs(t *testing.T) {
	database := newTestDB(t)
	hub := NewHub(database)
	database.CreateUser("alice", "alice", "alice@test.com", "hash", "Alice")
	database.CreateUser("bob", "bob", "bob@test.com", "hash", "Bob")

	aliceClient := newTestClient(hub, "alice")
	bobClient := newTestClient(hub, "bob")
	directRegister(hub, aliceClient)
	directRegister(hub, bobClient)

	online := hub.GetOnlineUserIDs()
	if !online["alice"] || !online["bob"] {
		t.Errorf("Expected alice and bob online, got: %v", online)
	}

	directUnregister(hub, aliceClient)
	directUnregister(hub, bobClient)
}

// ──── DM Presence Tests ────

func TestPresenceSync_IncludesDMPartners(t *testing.T) {
	database := newTestDB(t)
	hub := NewHub(database)

	database.CreateUser("alice", "alice", "alice@test.com", "hash", "Alice")
	database.CreateUser("bob", "bob", "bob@test.com", "hash", "Bob")

	// Create a DM channel between Alice and Bob (no shared server)
	database.CreateDMChannel("dm-1", "alice", "bob")

	// Alice is online
	aliceClient := newTestClient(hub, "alice")
	directRegister(hub, aliceClient)

	// Bob connects — should see Alice as online (DM partner)
	bobClient := newTestClient(hub, "bob")
	directRegister(hub, bobClient)
	hub.sendPresenceSync(bobClient)

	msgs := drainMessages(bobClient, 50*time.Millisecond)
	var aliceOnline bool
	for _, msg := range msgs {
		if msg.Type == "presence" {
			var payload map[string]string
			json.Unmarshal(msg.Payload, &payload)
			if payload["user_id"] == "alice" && payload["status"] == "online" {
				aliceOnline = true
			}
		}
	}
	if !aliceOnline {
		t.Error("Bob should see DM partner Alice as online")
	}

	directUnregister(hub, aliceClient)
	directUnregister(hub, bobClient)
}

// ──── Voice Channel Tests ────

func TestVoiceJoinLeave(t *testing.T) {
	database := newTestDB(t)
	hub := NewHub(database)

	users := hub.VoiceJoin("vc-1", "alice")
	if len(users) != 1 || users[0] != "alice" {
		t.Errorf("Expected [alice], got %v", users)
	}

	users = hub.VoiceJoin("vc-1", "bob")
	if len(users) != 2 {
		t.Errorf("Expected 2 users, got %d", len(users))
	}

	hub.VoiceLeave("vc-1", "alice")
	users = hub.VoiceUsers("vc-1")
	if len(users) != 1 || users[0] != "bob" {
		t.Errorf("Expected [bob] after Alice left, got %v", users)
	}

	hub.VoiceLeave("vc-1", "bob")
	users = hub.VoiceUsers("vc-1")
	if len(users) != 0 {
		t.Errorf("Expected empty after all left, got %v", users)
	}
}

func TestVoiceLeaveAll(t *testing.T) {
	database := newTestDB(t)
	hub := NewHub(database)

	hub.VoiceJoin("vc-1", "alice")
	hub.VoiceJoin("vc-2", "alice")
	hub.VoiceJoin("vc-1", "bob")

	channels := hub.VoiceLeaveAll("alice")
	if len(channels) != 2 {
		t.Errorf("Expected alice to leave 2 channels, got %d: %v", len(channels), channels)
	}

	// Bob should still be in vc-1
	users := hub.VoiceUsers("vc-1")
	if len(users) != 1 || users[0] != "bob" {
		t.Errorf("Expected [bob] in vc-1, got %v", users)
	}
}

// ──── Full Registration via Run() Loop ────

func TestHubRun_RegisterBroadcastsPresence(t *testing.T) {
	database := newTestDB(t)
	hub := NewHub(database)
	setupTestWorld(t, database)

	go hub.Run()

	// Bob is online first
	bobClient := newTestClient(hub, "bob")
	hub.register <- bobClient
	// Allow processing
	time.Sleep(50 * time.Millisecond)

	// Alice connects via register channel
	aliceClient := newTestClient(hub, "alice")
	hub.register <- aliceClient
	// Allow processing
	time.Sleep(50 * time.Millisecond)

	// Bob should have received Alice's online presence
	bobMsgs := drainMessages(bobClient, 50*time.Millisecond)
	var aliceOnline bool
	for _, msg := range bobMsgs {
		if msg.Type == "presence" {
			var payload map[string]string
			json.Unmarshal(msg.Payload, &payload)
			if payload["user_id"] == "alice" && payload["status"] == "online" {
				aliceOnline = true
			}
		}
	}
	if !aliceOnline {
		t.Error("Bob should receive Alice's online presence via hub.Run()")
	}

	// Alice should have received Bob's online presence via sendPresenceSync
	aliceMsgs := drainMessages(aliceClient, 50*time.Millisecond)
	var bobOnline bool
	for _, msg := range aliceMsgs {
		if msg.Type == "presence" {
			var payload map[string]string
			json.Unmarshal(msg.Payload, &payload)
			if payload["user_id"] == "bob" && payload["status"] == "online" {
				bobOnline = true
			}
		}
	}
	if !bobOnline {
		t.Error("Alice should receive Bob's online presence via sendPresenceSync")
	}
}
