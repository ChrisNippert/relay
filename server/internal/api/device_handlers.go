package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/relay-chat/relay/internal/db"
	"github.com/relay-chat/relay/internal/ws"
)

type registerDeviceRequest struct {
	PublicKey  string `json:"public_key"`
	SigningKey string `json:"signing_key"`
	Name       string `json:"name"`
}

func RegisterDeviceHandler(database *db.DB, hub *ws.Hub) http.HandlerFunc {
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

		userID := GetUserID(r)
		id := uuid.New().String()
		device, err := database.RegisterDevice(id, userID, req.Name, req.PublicKey, req.SigningKey)
		if err != nil {
			http.Error(w, `{"error":"failed to register device"}`, http.StatusInternalServerError)
			return
		}

		// If the device requires approval, notify existing devices
		if !device.Approved {
			evt, _ := json.Marshal(map[string]interface{}{
				"type": "device_pending",
				"payload": map[string]interface{}{
					"device_id": device.ID,
					"name":      device.Name,
				},
			})
			hub.SendToUser(userID, evt)
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

// GetPendingDevicesHandler returns devices awaiting approval for the current user.
func GetPendingDevicesHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		devices, err := database.GetPendingDevices(GetUserID(r))
		if err != nil {
			http.Error(w, `{"error":"failed to get pending devices"}`, http.StatusInternalServerError)
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

// ApproveDeviceHandler approves a pending device. The caller must own the device.
func ApproveDeviceHandler(database *db.DB, hub *ws.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		deviceID := chi.URLParam(r, "deviceID")
		userID := GetUserID(r)

		if err := database.ApproveDevice(deviceID, userID); err != nil {
			http.Error(w, `{"error":"device not found or not yours"}`, http.StatusNotFound)
			return
		}

		// Notify the newly approved device
		evt, _ := json.Marshal(map[string]interface{}{
			"type": "device_approved",
			"payload": map[string]interface{}{
				"device_id": deviceID,
			},
		})
		hub.SendToUser(userID, evt)

		w.WriteHeader(http.StatusNoContent)
	}
}

// RejectDeviceHandler deletes a pending device. The caller must own the device.
func RejectDeviceHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		deviceID := chi.URLParam(r, "deviceID")
		userID := GetUserID(r)

		// Verify the device is pending before deleting
		device, err := database.GetDevice(deviceID)
		if err != nil || device.UserID != userID || device.Approved {
			http.Error(w, `{"error":"device not found or already approved"}`, http.StatusNotFound)
			return
		}

		if err := database.DeleteDevice(deviceID, userID); err != nil {
			http.Error(w, `{"error":"failed to reject device"}`, http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
