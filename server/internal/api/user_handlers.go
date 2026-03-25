package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/relay-chat/relay/internal/db"
)

func GetMeHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, err := database.GetUserByID(GetUserID(r))
		if err != nil {
			http.Error(w, `{"error":"user not found"}`, http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(user)
	}
}

type updateUserRequest struct {
	DisplayName string `json:"display_name"`
	AvatarURL   string `json:"avatar_url"`
}

func UpdateMeHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req updateUserRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}

		user, err := database.UpdateUser(GetUserID(r), req.DisplayName, req.AvatarURL)
		if err != nil {
			http.Error(w, `{"error":"failed to update user"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(user)
	}
}

func GetUserHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID := chi.URLParam(r, "userID")
		user, err := database.GetUserByID(userID)
		if err != nil {
			http.Error(w, `{"error":"user not found"}`, http.StatusNotFound)
			return
		}
		// Don't expose email to other users
		user.Email = ""
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(user)
	}
}

type updateKeyRequest struct {
	PublicKey string `json:"public_key"`
}

func UpdatePublicKeyHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req updateKeyRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}

		if err := database.UpdatePublicKey(GetUserID(r), req.PublicKey); err != nil {
			http.Error(w, `{"error":"failed to update public key"}`, http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}

func SearchUsersHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query().Get("q")
		if query == "" {
			http.Error(w, `{"error":"query parameter 'q' is required"}`, http.StatusBadRequest)
			return
		}

		users, err := database.SearchUsers(query)
		if err != nil {
			http.Error(w, `{"error":"search failed"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		if users == nil {
			w.Write([]byte("[]"))
			return
		}
		json.NewEncoder(w).Encode(users)
	}
}
