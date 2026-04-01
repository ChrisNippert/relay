package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/relay-chat/relay/internal/db"
	"github.com/relay-chat/relay/internal/models"
	"github.com/relay-chat/relay/internal/ws"
)

// Deduplicates channel_keys_updated notifications per user.
// During key distribution, many setChannelKey calls fire for the same user+channel+epoch.
// We only send one notification per (user, channel, epoch) per dedup window.
var (
	keyNotifSent   = make(map[string]time.Time)
	keyNotifMu     sync.Mutex
	keyNotifWindow = 5 * time.Second
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

		// Notify the target user that a key is available for this channel.
		// Deduplicated per (device, channel, epoch): the notification fires when THIS
		// specific device's key is set, not when ANY device of the same user gets a key.
		// This prevents races where a user's active device misses the notification because
		// it fired for a different device of the same user.
		notifKey := fmt.Sprintf("%s:%s:%d", req.DeviceID, channelID, req.Epoch)
		keyNotifMu.Lock()
		lastSent, exists := keyNotifSent[notifKey]
		shouldNotify := !exists || time.Since(lastSent) > keyNotifWindow
		if shouldNotify {
			keyNotifSent[notifKey] = time.Now()
		}
		// Periodic cleanup of old entries
		if len(keyNotifSent) > 1000 {
			now := time.Now()
			for k, t := range keyNotifSent {
				if now.Sub(t) > keyNotifWindow {
					delete(keyNotifSent, k)
				}
			}
		}
		keyNotifMu.Unlock()

		if shouldNotify {
			evt, _ := json.Marshal(map[string]interface{}{
				"type": "channel_keys_updated",
				"payload": map[string]interface{}{
					"channel_id": channelID,
					"epoch":      req.Epoch,
				},
			})
			hub.SendToUser(device.UserID, evt)
		}

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

// RotateChannelKeyHandler is an admin-only endpoint that bumps the channel epoch.
// It returns the new epoch number so the client can distribute keys at that epoch.
// The actual key generation and distribution happens client-side.
func RotateChannelKeyHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		channelID := chi.URLParam(r, "channelID")
		callerID := GetUserID(r)

		// Check channel access
		channel, err := database.GetChannel(channelID)
		if err != nil {
			http.Error(w, `{"error":"channel not found"}`, http.StatusNotFound)
			return
		}

		// For server channels, require admin role
		if channel.ServerID != "" {
			role, err := database.GetMemberRole(channel.ServerID, callerID)
			if err != nil || role != "admin" {
				http.Error(w, `{"error":"admin access required"}`, http.StatusForbidden)
				return
			}
		} else {
			// DM channels — any participant can rotate
			hasAccess, err := database.IsChannelParticipant(channelID, callerID)
			if err != nil || !hasAccess {
				http.Error(w, `{"error":"access denied"}`, http.StatusForbidden)
				return
			}
		}

		// Get current epoch
		currentEpoch, err := database.GetChannelCurrentEpoch(channelID)
		if err != nil {
			http.Error(w, `{"error":"failed to get current epoch"}`, http.StatusInternalServerError)
			return
		}

		newEpoch := currentEpoch + 1

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]int{"epoch": newEpoch})
	}
}

// ClaimEpochHandler atomically claims the next epoch for a channel.
// Uses INSERT OR IGNORE: the first caller to claim a (channel, epoch) wins.
// Returns {"epoch": N, "claimed": true} if this caller won, or
// {"epoch": N, "claimed": false} if another device already claimed it.
func ClaimEpochHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		channelID := chi.URLParam(r, "channelID")
		callerID := GetUserID(r)

		hasAccess, err := database.IsChannelParticipant(channelID, callerID)
		if err != nil || !hasAccess {
			http.Error(w, `{"error":"access denied"}`, http.StatusForbidden)
			return
		}

		var req struct {
			DeviceID string `json:"device_id"`
			Epoch    int    `json:"epoch"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}

		if req.DeviceID == "" {
			http.Error(w, `{"error":"device_id required"}`, http.StatusBadRequest)
			return
		}

		// Verify the device belongs to the caller
		device, err := database.GetDevice(req.DeviceID)
		if err != nil || device.UserID != callerID {
			http.Error(w, `{"error":"device not found or not owned by caller"}`, http.StatusBadRequest)
			return
		}

		claimed, err := database.ClaimEpoch(channelID, req.DeviceID, req.Epoch)
		if err != nil {
			http.Error(w, `{"error":"failed to claim epoch"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"epoch":   req.Epoch,
			"claimed": claimed,
		})
	}
}

// SetMasterKeysHandler batch-stores per-device encrypted keys for an epoch.
// Any channel participant can upload; INSERT OR IGNORE prevents overwrites.
func SetMasterKeysHandler(database *db.DB, hub *ws.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		channelID := chi.URLParam(r, "channelID")
		callerID := GetUserID(r)

		hasAccess, err := database.IsChannelParticipant(channelID, callerID)
		if err != nil || !hasAccess {
			http.Error(w, `{"error":"access denied"}`, http.StatusForbidden)
			return
		}

		var req struct {
			Epoch int `json:"epoch"`
			Keys  []struct {
				DeviceID     string `json:"device_id"`
				EncryptedKey string `json:"encrypted_key"`
			} `json:"keys"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}
		if len(req.Keys) == 0 {
			http.Error(w, `{"error":"keys required"}`, http.StatusBadRequest)
			return
		}

		entries := make([]models.ChannelKey, len(req.Keys))
		for i, k := range req.Keys {
			entries[i] = models.ChannelKey{
				DeviceID:     k.DeviceID,
				EncryptedKey: k.EncryptedKey,
			}
		}

		if err := database.SetMasterKeys(channelID, req.Epoch, entries); err != nil {
			http.Error(w, `{"error":"failed to set master keys"}`, http.StatusInternalServerError)
			return
		}

		// Notify all channel members that a new epoch key is available
		members, err := database.GetChannelParticipantIDs(channelID)
		if err == nil {
			evt, _ := json.Marshal(map[string]interface{}{
				"type": "channel_keys_updated",
				"payload": map[string]interface{}{
					"channel_id": channelID,
					"epoch":      req.Epoch,
				},
			})
			for _, uid := range members {
				hub.SendToUser(uid, evt)
			}
		}

		w.WriteHeader(http.StatusNoContent)
	}
}

// GetMasterKeysHandler returns all raw epoch keys for a channel.
func GetMasterKeysHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		channelID := chi.URLParam(r, "channelID")
		callerID := GetUserID(r)

		hasAccess, err := database.IsChannelParticipant(channelID, callerID)
		if err != nil || !hasAccess {
			http.Error(w, `{"error":"access denied"}`, http.StatusForbidden)
			return
		}

		keys, err := database.GetMasterKeys(channelID)
		if err != nil {
			http.Error(w, `{"error":"failed to get master keys"}`, http.StatusInternalServerError)
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
