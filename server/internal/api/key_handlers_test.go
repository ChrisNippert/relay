package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/relay-chat/relay/internal/db"
	"github.com/relay-chat/relay/internal/ws"
)

type testEnv struct {
	db  *db.DB
	hub *ws.Hub
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	database, err := db.New(":memory:")
	if err != nil {
		t.Fatalf("failed to create test db: %v", err)
	}
	t.Cleanup(func() { database.Close() })
	hub := ws.NewHub(database)
	return &testEnv{db: database, hub: hub}
}

func authedRequest(method, path, userID string, body []byte) *http.Request {
	var r *http.Request
	if body != nil {
		r = httptest.NewRequest(method, path, bytes.NewReader(body))
	} else {
		r = httptest.NewRequest(method, path, nil)
	}
	ctx := context.WithValue(r.Context(), userIDKey, userID)
	return r.WithContext(ctx)
}

func withChiURLParam(r *http.Request, key, value string) *http.Request {
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add(key, value)
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
}

func setupTestServer(t *testing.T, env *testEnv) {
	t.Helper()
	_, err := env.db.CreateUser("user-1", "alice", "alice@test.com", "hash1", "Alice")
	if err != nil {
		t.Fatalf("create user-1: %v", err)
	}
	_, err = env.db.CreateUser("user-2", "bob", "bob@test.com", "hash2", "Bob")
	if err != nil {
		t.Fatalf("create user-2: %v", err)
	}

	env.db.CreateServer("server-1", "Test Server", "user-1")
	env.db.AddServerMember("server-1", "user-2", "member")
	env.db.CreateChannel("chan-1", "server-1", "encrypted", "text", 0, "")

	env.db.RegisterDevice("dev-1", "user-1", "Phone", "pk1", "sk1")
	env.db.RegisterDevice("dev-2", "user-2", "Laptop", "pk2", "sk2")
}

func TestGetChannelKeysHandler_Empty(t *testing.T) {
	env := newTestEnv(t)
	setupTestServer(t, env)

	r := authedRequest("GET", "/api/channels/chan-1/keys", "user-1", nil)
	r = withChiURLParam(r, "channelID", "chan-1")
	w := httptest.NewRecorder()

	GetChannelKeysHandler(env.db)(w, r)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	if w.Body.String() != "[]" {
		t.Errorf("expected empty array, got %q", w.Body.String())
	}
}

func TestSetChannelKeyHandler_Success(t *testing.T) {
	env := newTestEnv(t)
	setupTestServer(t, env)

	body, _ := json.Marshal(setKeyRequest{
		EncryptedKey: "enc-key-data",
		DeviceID:     "dev-2",
		Epoch:        0,
	})
	r := authedRequest("POST", "/api/channels/chan-1/keys", "user-1", body)
	r = withChiURLParam(r, "channelID", "chan-1")
	w := httptest.NewRecorder()

	SetChannelKeyHandler(env.db, env.hub)(w, r)

	if w.Code != http.StatusNoContent {
		t.Errorf("expected 204, got %d: %s", w.Code, w.Body.String())
	}

	// Verify key was stored
	keys, _ := env.db.GetChannelKeys("chan-1")
	if len(keys) != 1 {
		t.Fatalf("expected 1 key, got %d", len(keys))
	}
	if keys[0].EncryptedKey != "enc-key-data" {
		t.Errorf("key mismatch: %q", keys[0].EncryptedKey)
	}
}

func TestSetChannelKeyHandler_AccessDenied(t *testing.T) {
	env := newTestEnv(t)
	setupTestServer(t, env)

	_, _ = env.db.CreateUser("user-3", "charlie", "charlie@test.com", "hash3", "Charlie")

	body, _ := json.Marshal(setKeyRequest{
		EncryptedKey: "enc-key-data",
		DeviceID:     "dev-2",
		Epoch:        0,
	})
	r := authedRequest("POST", "/api/channels/chan-1/keys", "user-3", body)
	r = withChiURLParam(r, "channelID", "chan-1")
	w := httptest.NewRecorder()

	SetChannelKeyHandler(env.db, env.hub)(w, r)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d", w.Code)
	}
}

func TestSetChannelKeyHandler_MissingDeviceID(t *testing.T) {
	env := newTestEnv(t)
	setupTestServer(t, env)

	body, _ := json.Marshal(setKeyRequest{
		EncryptedKey: "enc-key-data",
		Epoch:        0,
	})
	r := authedRequest("POST", "/api/channels/chan-1/keys", "user-1", body)
	r = withChiURLParam(r, "channelID", "chan-1")
	w := httptest.NewRecorder()

	SetChannelKeyHandler(env.db, env.hub)(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

func TestSetChannelKeyHandler_NonParticipantDevice(t *testing.T) {
	env := newTestEnv(t)
	setupTestServer(t, env)

	_, _ = env.db.CreateUser("user-3", "charlie", "charlie@test.com", "hash3", "Charlie")
	env.db.RegisterDevice("dev-3", "user-3", "Charlie Phone", "pk3", "sk3")

	body, _ := json.Marshal(setKeyRequest{
		EncryptedKey: "enc-key-data",
		DeviceID:     "dev-3",
		Epoch:        0,
	})
	r := authedRequest("POST", "/api/channels/chan-1/keys", "user-1", body)
	r = withChiURLParam(r, "channelID", "chan-1")
	w := httptest.NewRecorder()

	SetChannelKeyHandler(env.db, env.hub)(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

func TestSetChannelKeyHandler_InsertOrIgnore(t *testing.T) {
	env := newTestEnv(t)
	setupTestServer(t, env)

	body1, _ := json.Marshal(setKeyRequest{EncryptedKey: "original-key", DeviceID: "dev-2", Epoch: 0})
	r := authedRequest("POST", "/api/channels/chan-1/keys", "user-1", body1)
	r = withChiURLParam(r, "channelID", "chan-1")
	w := httptest.NewRecorder()
	SetChannelKeyHandler(env.db, env.hub)(w, r)

	body2, _ := json.Marshal(setKeyRequest{EncryptedKey: "overwrite-attempt", DeviceID: "dev-2", Epoch: 0})
	r2 := authedRequest("POST", "/api/channels/chan-1/keys", "user-1", body2)
	r2 = withChiURLParam(r2, "channelID", "chan-1")
	w2 := httptest.NewRecorder()
	SetChannelKeyHandler(env.db, env.hub)(w2, r2)

	key, _ := env.db.GetChannelKeyForDevice("chan-1", "dev-2", 0)
	if key.EncryptedKey != "original-key" {
		t.Errorf("INSERT OR IGNORE failed: got %q, want %q", key.EncryptedKey, "original-key")
	}
}

func TestGetChannelEpochHandler(t *testing.T) {
	env := newTestEnv(t)
	setupTestServer(t, env)

	env.db.SetChannelKey("chan-1", "dev-1", 0, "key-e0")
	env.db.SetChannelKey("chan-1", "dev-1", 2, "key-e2")

	r := authedRequest("GET", "/api/channels/chan-1/keys/epoch", "user-1", nil)
	r = withChiURLParam(r, "channelID", "chan-1")
	w := httptest.NewRecorder()

	GetChannelEpochHandler(env.db)(w, r)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}

	var result map[string]int
	json.Unmarshal(w.Body.Bytes(), &result)
	if result["epoch"] != 2 {
		t.Errorf("expected epoch 2, got %d", result["epoch"])
	}
}

func TestDeleteChannelKeysHandler(t *testing.T) {
	env := newTestEnv(t)
	setupTestServer(t, env)

	env.db.SetChannelKey("chan-1", "dev-1", 0, "key1")
	env.db.SetChannelKey("chan-1", "dev-2", 0, "key2")

	r := authedRequest("DELETE", "/api/channels/chan-1/keys", "user-1", nil)
	r = withChiURLParam(r, "channelID", "chan-1")
	w := httptest.NewRecorder()

	DeleteChannelKeysHandler(env.db)(w, r)

	if w.Code != http.StatusNoContent {
		t.Errorf("expected 204, got %d", w.Code)
	}

	keys, _ := env.db.GetChannelKeys("chan-1")
	if len(keys) != 0 {
		t.Errorf("expected 0 keys after delete, got %d", len(keys))
	}
}

func TestDeleteMyChannelKeysHandler(t *testing.T) {
	env := newTestEnv(t)
	setupTestServer(t, env)

	env.db.SetChannelKey("chan-1", "dev-1", 0, "key-user1")
	env.db.SetChannelKey("chan-1", "dev-2", 0, "key-user2")

	r := authedRequest("DELETE", "/api/keys/mine", "user-1", nil)
	w := httptest.NewRecorder()

	DeleteMyChannelKeysHandler(env.db)(w, r)

	if w.Code != http.StatusNoContent {
		t.Errorf("expected 204, got %d", w.Code)
	}

	keys, _ := env.db.GetChannelKeys("chan-1")
	if len(keys) != 1 {
		t.Errorf("expected 1 remaining key, got %d", len(keys))
	}
	if keys[0].DeviceID != "dev-2" {
		t.Errorf("expected dev-2 key to remain, got %q", keys[0].DeviceID)
	}
}

func TestKeyDistributionFlow(t *testing.T) {
	env := newTestEnv(t)
	setupTestServer(t, env)

	// user-1 distributes epoch-0 key to both devices
	for _, devID := range []string{"dev-1", "dev-2"} {
		body, _ := json.Marshal(setKeyRequest{
			EncryptedKey: "epoch0-for-" + devID,
			DeviceID:     devID,
			Epoch:        0,
		})
		r := authedRequest("POST", "/api/channels/chan-1/keys", "user-1", body)
		r = withChiURLParam(r, "channelID", "chan-1")
		w := httptest.NewRecorder()
		SetChannelKeyHandler(env.db, env.hub)(w, r)
		if w.Code != http.StatusNoContent {
			t.Fatalf("set key for %s: expected 204, got %d", devID, w.Code)
		}
	}

	// verify keys
	keys, _ := env.db.GetChannelKeysForEpoch("chan-1", 0)
	if len(keys) != 2 {
		t.Fatalf("expected 2 keys at epoch 0, got %d", len(keys))
	}

	key1, _ := env.db.GetChannelKeyForDevice("chan-1", "dev-1", 0)
	if key1.EncryptedKey != "epoch0-for-dev-1" {
		t.Errorf("dev-1 key mismatch: %q", key1.EncryptedKey)
	}

	key2, _ := env.db.GetChannelKeyForDevice("chan-1", "dev-2", 0)
	if key2.EncryptedKey != "epoch0-for-dev-2" {
		t.Errorf("dev-2 key mismatch: %q", key2.EncryptedKey)
	}

	// current epoch should be 0
	epoch, _ := env.db.GetChannelCurrentEpoch("chan-1")
	if epoch != 0 {
		t.Errorf("expected epoch 0, got %d", epoch)
	}

	// Rotate to epoch 1
	for _, devID := range []string{"dev-1", "dev-2"} {
		body, _ := json.Marshal(setKeyRequest{
			EncryptedKey: "epoch1-for-" + devID,
			DeviceID:     devID,
			Epoch:        1,
		})
		r := authedRequest("POST", "/api/channels/chan-1/keys", "user-1", body)
		r = withChiURLParam(r, "channelID", "chan-1")
		w := httptest.NewRecorder()
		SetChannelKeyHandler(env.db, env.hub)(w, r)
	}

	epoch, _ = env.db.GetChannelCurrentEpoch("chan-1")
	if epoch != 1 {
		t.Errorf("expected epoch 1, got %d", epoch)
	}

	// old epoch keys should still be accessible
	oldKey, err := env.db.GetChannelKeyForDevice("chan-1", "dev-1", 0)
	if err != nil || oldKey.EncryptedKey != "epoch0-for-dev-1" {
		t.Errorf("old epoch key should still exist")
	}
}
