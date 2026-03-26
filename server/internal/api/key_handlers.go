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
	UserID       string `json:"user_id,omitempty"` // optional: set key for another member
}

func SetChannelKeyHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		channelID := chi.URLParam(r, "channelID")
		callerID := GetUserID(r)

		hasAccess, err := database.IsChannelParticipant(channelID, callerID)
		if err != nil || !hasAccess {
			http.Error(w, `{"error":"access denied"}`, http.StatusForbidden)
			return
		}

		var req setKeyRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}

		targetUserID := callerID
		if req.UserID != "" {
			// Verify the target user is also a channel participant
			targetAccess, err := database.IsChannelParticipant(channelID, req.UserID)
			if err != nil || !targetAccess {
				http.Error(w, `{"error":"target user is not a channel participant"}`, http.StatusBadRequest)
				return
			}
			targetUserID = req.UserID
		}

		if err := database.SetChannelKey(channelID, targetUserID, req.EncryptedKey); err != nil {
			http.Error(w, `{"error":"failed to set key"}`, http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}
