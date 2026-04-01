package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/relay-chat/relay/internal/config"
	"github.com/relay-chat/relay/internal/db"
)

func newTestConfig() *config.Config {
	return &config.Config{
		JWTSecret: "test-secret-at-least-32-chars-long",
	}
}

func newAuthTestDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.New(":memory:")
	if err != nil {
		t.Fatalf("failed to create test db: %v", err)
	}
	t.Cleanup(func() { database.Close() })
	return database
}

func TestRegisterHandler_Success(t *testing.T) {
	database := newAuthTestDB(t)
	cfg := newTestConfig()

	body, _ := json.Marshal(registerRequest{
		Username:    "alice",
		Email:       "alice@test.com",
		Password:    "password123",
		DisplayName: "Alice",
	})

	r := httptest.NewRequest("POST", "/api/register", bytes.NewReader(body))
	w := httptest.NewRecorder()

	RegisterHandler(database, cfg)(w, r)

	if w.Code != http.StatusCreated {
		t.Errorf("expected 201, got %d: %s", w.Code, w.Body.String())
	}

	var resp authResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if resp.Token == "" {
		t.Error("expected token in response")
	}
}

func TestRegisterHandler_DuplicateUsername(t *testing.T) {
	database := newAuthTestDB(t)
	cfg := newTestConfig()

	body, _ := json.Marshal(registerRequest{
		Username: "alice",
		Email:    "alice@test.com",
		Password: "password123",
	})

	// First registration
	r1 := httptest.NewRequest("POST", "/api/register", bytes.NewReader(body))
	w1 := httptest.NewRecorder()
	RegisterHandler(database, cfg)(w1, r1)

	// Second registration with same username
	body2, _ := json.Marshal(registerRequest{
		Username: "alice",
		Email:    "alice2@test.com",
		Password: "password123",
	})
	r2 := httptest.NewRequest("POST", "/api/register", bytes.NewReader(body2))
	w2 := httptest.NewRecorder()
	RegisterHandler(database, cfg)(w2, r2)

	if w2.Code != http.StatusConflict {
		t.Errorf("expected 409, got %d: %s", w2.Code, w2.Body.String())
	}
}

func TestRegisterHandler_ShortPassword(t *testing.T) {
	database := newAuthTestDB(t)
	cfg := newTestConfig()

	body, _ := json.Marshal(registerRequest{
		Username: "alice",
		Email:    "alice@test.com",
		Password: "short",
	})

	r := httptest.NewRequest("POST", "/api/register", bytes.NewReader(body))
	w := httptest.NewRecorder()
	RegisterHandler(database, cfg)(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestRegisterHandler_MissingFields(t *testing.T) {
	database := newAuthTestDB(t)
	cfg := newTestConfig()

	body, _ := json.Marshal(registerRequest{
		Username: "alice",
		Password: "password123",
	})

	r := httptest.NewRequest("POST", "/api/register", bytes.NewReader(body))
	w := httptest.NewRecorder()
	RegisterHandler(database, cfg)(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

func TestLoginHandler_Success(t *testing.T) {
	database := newAuthTestDB(t)
	cfg := newTestConfig()

	// Register first
	regBody, _ := json.Marshal(registerRequest{
		Username: "alice",
		Email:    "alice@test.com",
		Password: "password123",
	})
	rr := httptest.NewRequest("POST", "/api/register", bytes.NewReader(regBody))
	rw := httptest.NewRecorder()
	RegisterHandler(database, cfg)(rw, rr)

	// Login
	loginBody, _ := json.Marshal(loginRequest{
		Email:    "alice@test.com",
		Password: "password123",
	})
	r := httptest.NewRequest("POST", "/api/login", bytes.NewReader(loginBody))
	w := httptest.NewRecorder()
	LoginHandler(database, cfg)(w, r)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp authResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if resp.Token == "" {
		t.Error("expected token in response")
	}
}

func TestLoginHandler_WrongPassword(t *testing.T) {
	database := newAuthTestDB(t)
	cfg := newTestConfig()

	// Register
	regBody, _ := json.Marshal(registerRequest{
		Username: "alice",
		Email:    "alice@test.com",
		Password: "password123",
	})
	rr := httptest.NewRequest("POST", "/api/register", bytes.NewReader(regBody))
	rw := httptest.NewRecorder()
	RegisterHandler(database, cfg)(rw, rr)

	// Login with wrong password
	loginBody, _ := json.Marshal(loginRequest{
		Email:    "alice@test.com",
		Password: "wrongpassword",
	})
	r := httptest.NewRequest("POST", "/api/login", bytes.NewReader(loginBody))
	w := httptest.NewRecorder()
	LoginHandler(database, cfg)(w, r)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

func TestLoginHandler_NonexistentUser(t *testing.T) {
	database := newAuthTestDB(t)
	cfg := newTestConfig()

	loginBody, _ := json.Marshal(loginRequest{
		Email:    "nobody@test.com",
		Password: "password123",
	})
	r := httptest.NewRequest("POST", "/api/login", bytes.NewReader(loginBody))
	w := httptest.NewRecorder()
	LoginHandler(database, cfg)(w, r)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}
