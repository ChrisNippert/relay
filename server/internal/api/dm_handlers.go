package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/relay-chat/relay/internal/db"
)

type createDMRequest struct {
	UserID string `json:"user_id"`
}

func CreateDMHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req createDMRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}

		userID := GetUserID(r)
		if req.UserID == userID {
			http.Error(w, `{"error":"cannot DM yourself"}`, http.StatusBadRequest)
			return
		}

		// Check if DM already exists
		existing, err := database.GetExistingDM(userID, req.UserID)
		if err == nil && existing != nil {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(existing)
			return
		}

		channel, err := database.CreateDMChannel(uuid.New().String(), userID, req.UserID)
		if err != nil {
			http.Error(w, `{"error":"failed to create DM"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(channel)
	}
}

func GetDMsHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		channels, err := database.GetDMChannels(GetUserID(r))
		if err != nil {
			http.Error(w, `{"error":"failed to get DMs"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		if channels == nil {
			w.Write([]byte("[]"))
			return
		}
		json.NewEncoder(w).Encode(channels)
	}
}

func GetDMParticipantsHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		channelID := chi.URLParam(r, "channelID")
		userID := GetUserID(r)

		// Verify caller is a participant
		participants, err := database.GetDMParticipants(channelID)
		if err != nil {
			http.Error(w, `{"error":"channel not found"}`, http.StatusNotFound)
			return
		}

		isMember := false
		for _, p := range participants {
			if p == userID {
				isMember = true
				break
			}
		}
		if !isMember {
			http.Error(w, `{"error":"not a participant"}`, http.StatusForbidden)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(participants)
	}
}
