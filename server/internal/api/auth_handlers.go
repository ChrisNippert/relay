package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/relay-chat/relay/internal/auth"
	"github.com/relay-chat/relay/internal/config"
	"github.com/relay-chat/relay/internal/db"
)

type registerRequest struct {
	Username    string `json:"username"`
	Email       string `json:"email"`
	Password    string `json:"password"`
	DisplayName string `json:"display_name"`
}

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type authResponse struct {
	Token string      `json:"token"`
	User  interface{} `json:"user"`
}

func RegisterHandler(database *db.DB, cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req registerRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}

		req.Username = strings.TrimSpace(req.Username)
		req.Email = strings.TrimSpace(strings.ToLower(req.Email))
		req.DisplayName = strings.TrimSpace(req.DisplayName)

		if req.Username == "" || req.Email == "" || req.Password == "" {
			http.Error(w, `{"error":"username, email, and password are required"}`, http.StatusBadRequest)
			return
		}

		if len(req.Password) < 8 {
			http.Error(w, `{"error":"password must be at least 8 characters"}`, http.StatusBadRequest)
			return
		}

		if req.DisplayName == "" {
			req.DisplayName = req.Username
		}

		hash, err := auth.HashPassword(req.Password)
		if err != nil {
			http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
			return
		}

		userID := uuid.New().String()

		user, err := database.CreateUser(userID, req.Username, req.Email, hash, req.DisplayName)
		if err != nil {
			if strings.Contains(err.Error(), "UNIQUE") {
				http.Error(w, `{"error":"username or email already taken"}`, http.StatusConflict)
				return
			}
			http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
			return
		}

		token, err := auth.GenerateToken(userID, cfg.JWTSecret)
		if err != nil {
			http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(authResponse{Token: token, User: user})
	}
}

func LoginHandler(database *db.DB, cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req loginRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}

		req.Email = strings.TrimSpace(strings.ToLower(req.Email))

		user, err := database.GetUserByEmail(req.Email)
		if err != nil {
			http.Error(w, `{"error":"invalid email or password"}`, http.StatusUnauthorized)
			return
		}

		if !auth.CheckPassword(req.Password, user.PasswordHash) {
			http.Error(w, `{"error":"invalid email or password"}`, http.StatusUnauthorized)
			return
		}

		token, err := auth.GenerateToken(user.ID, cfg.JWTSecret)
		if err != nil {
			http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(authResponse{Token: token, User: user})
	}
}
