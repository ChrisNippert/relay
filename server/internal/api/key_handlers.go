package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/relay-chat/relay/internal/db"
	"github.com/relay-chat/relay/internal/ws"
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

func DeleteMyChannelKeysHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := database.DeleteChannelKeysForUser(GetUserID(r)); err != nil {
			http.Error(w, `{"error":"failed to delete keys"}`, http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

type setKeyRequest struct {
	EncryptedKey string `json:"encrypted_key"`
	DeviceID     string `json:"device_id,omitempty"` // target device
	Epoch        int    `json:"epoch"`
}

func SetChannelKeyHandler(database *db.DB, hub *ws.Hub) http.HandlerFunc {
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

		if req.DeviceID == "" {
			http.Error(w, `{"error":"device_id required"}`, http.StatusBadRequest)
			return
		}

		// Verify the target device belongs to a channel participant
		device, err := database.GetDevice(req.DeviceID)
		if err != nil {
			http.Error(w, `{"error":"device not found"}`, http.StatusBadRequest)
			return
		}
		targetAccess, err := database.IsChannelParticipant(channelID, device.UserID)
		if err != nil || !targetAccess {
			http.Error(w, `{"error":"device owner is not a channel participant"}`, http.StatusBadRequest)
			return
		}

		// Uses INSERT OR IGNORE — once a (channel, device, epoch) entry exists it cannot be overwritten
		if err := database.SetChannelKey(channelID, req.DeviceID, req.Epoch, req.EncryptedKey); err != nil {
			http.Error(w, `{"error":"failed to set key"}`, http.StatusInternalServerError)
			return
		}

		// Notify the target user that a key is available for this channel
		evt, _ := json.Marshal(map[string]interface{}{
			"type": "channel_keys_updated",
			"payload": map[string]interface{}{
				"channel_id": channelID,
				"epoch":      req.Epoch,
			},
		})
		hub.SendToUser(device.UserID, evt)

		w.WriteHeader(http.StatusNoContent)
	}
}

func DeleteChannelKeysHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		channelID := chi.URLParam(r, "channelID")

		hasAccess, err := database.IsChannelParticipant(channelID, GetUserID(r))
		if err != nil || !hasAccess {
			http.Error(w, `{"error":"access denied"}`, http.StatusForbidden)
			return
		}

		if err := database.DeleteAllChannelKeys(channelID); err != nil {
			http.Error(w, `{"error":"failed to delete keys"}`, http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}

// GetChannelEpochHandler returns the current (latest) epoch for a channel.
func GetChannelEpochHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		channelID := chi.URLParam(r, "channelID")

		hasAccess, err := database.IsChannelParticipant(channelID, GetUserID(r))
		if err != nil || !hasAccess {
			http.Error(w, `{"error":"access denied"}`, http.StatusForbidden)
			return
		}

		epoch, err := database.GetChannelCurrentEpoch(channelID)
		if err != nil {
			http.Error(w, `{"error":"failed to get epoch"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]int{"epoch": epoch})
	}
}
