package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/relay-chat/relay/internal/db"
)

func GetChannelKeysHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		channelID := chi.URLParam(r, "channelID")

		hasAccess, err := database.IsChannelParticipant(channelID, GetUserID(r))
		if err != nil || !hasAccess {
			http.Error(w, `{"error":"access denied"}`, http.StatusForbidden)
			return
		}

		keys, err := database.GetChannelKeys(channelID)
		if err != nil {
			http.Error(w, `{"error":"failed to get keys"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		if keys == nil {
			w.Write([]byte("[]"))
			return
		}
		json.NewEncoder(w).Encode(keys)
	}
}

type setKeyRequest struct {
	EncryptedKey string `json:"encrypted_key"`
}

func SetChannelKeyHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		channelID := chi.URLParam(r, "channelID")
		userID := GetUserID(r)

		hasAccess, err := database.IsChannelParticipant(channelID, userID)
		if err != nil || !hasAccess {
			http.Error(w, `{"error":"access denied"}`, http.StatusForbidden)
			return
		}

		var req setKeyRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}

		if err := database.SetChannelKey(channelID, userID, req.EncryptedKey); err != nil {
			http.Error(w, `{"error":"failed to set key"}`, http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}
