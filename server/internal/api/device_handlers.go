package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/relay-chat/relay/internal/db"
)

type registerDeviceRequest struct {
	PublicKey  string `json:"public_key"`
	SigningKey string `json:"signing_key"`
	Name       string `json:"name"`
}

func RegisterDeviceHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req registerDeviceRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}
		if req.PublicKey == "" {
			http.Error(w, `{"error":"public_key required"}`, http.StatusBadRequest)
			return
		}

		id := uuid.New().String()
		device, err := database.RegisterDevice(id, GetUserID(r), req.Name, req.PublicKey, req.SigningKey)
		if err != nil {
			http.Error(w, `{"error":"failed to register device"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(device)
	}
}

func GetMyDevicesHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		devices, err := database.GetDevicesForUser(GetUserID(r))
		if err != nil {
			http.Error(w, `{"error":"failed to get devices"}`, http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if devices == nil {
			w.Write([]byte("[]"))
			return
		}
		json.NewEncoder(w).Encode(devices)
	}
}

func GetUserDevicesHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID := chi.URLParam(r, "userID")
		devices, err := database.GetDevicesForUser(userID)
		if err != nil {
			http.Error(w, `{"error":"failed to get devices"}`, http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if devices == nil {
			w.Write([]byte("[]"))
			return
		}
		json.NewEncoder(w).Encode(devices)
	}
}

func DeleteDeviceHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		deviceID := chi.URLParam(r, "deviceID")
		if err := database.DeleteDevice(deviceID, GetUserID(r)); err != nil {
			http.Error(w, `{"error":"device not found"}`, http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// GetChannelDevicesHandler returns all devices for members of a channel.
func GetChannelDevicesHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		channelID := chi.URLParam(r, "channelID")

		hasAccess, err := database.IsChannelParticipant(channelID, GetUserID(r))
		if err != nil || !hasAccess {
			http.Error(w, `{"error":"access denied"}`, http.StatusForbidden)
			return
		}

		devices, err := database.GetChannelMemberDevices(channelID)
		if err != nil {
			http.Error(w, `{"error":"failed to get devices"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		if devices == nil {
			w.Write([]byte("[]"))
			return
		}
		json.NewEncoder(w).Encode(devices)
	}
}
