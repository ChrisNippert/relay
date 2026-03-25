package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/relay-chat/relay/internal/db"
)

type createChannelRequest struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

func CreateChannelHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		serverID := chi.URLParam(r, "serverID")

		role, err := database.GetMemberRole(serverID, GetUserID(r))
		if err != nil || role != "admin" {
			http.Error(w, `{"error":"admin access required"}`, http.StatusForbidden)
			return
		}

		var req createChannelRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}

		if req.Name == "" {
			http.Error(w, `{"error":"name is required"}`, http.StatusBadRequest)
			return
		}

		if req.Type != "text" && req.Type != "voice" {
			http.Error(w, `{"error":"type must be 'text' or 'voice'"}`, http.StatusBadRequest)
			return
		}

		channel, err := database.CreateChannel(uuid.New().String(), serverID, req.Name, req.Type, 0)
		if err != nil {
			http.Error(w, `{"error":"failed to create channel"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(channel)
	}
}

func GetChannelsHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		serverID := chi.URLParam(r, "serverID")

		isMember, err := database.IsServerMember(serverID, GetUserID(r))
		if err != nil || !isMember {
			http.Error(w, `{"error":"not a member of this server"}`, http.StatusForbidden)
			return
		}

		channels, err := database.GetChannelsByServer(serverID)
		if err != nil {
			http.Error(w, `{"error":"failed to get channels"}`, http.StatusInternalServerError)
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

func DeleteChannelHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		channelID := chi.URLParam(r, "channelID")

		channel, err := database.GetChannel(channelID)
		if err != nil {
			http.Error(w, `{"error":"channel not found"}`, http.StatusNotFound)
			return
		}

		if channel.ServerID == "" {
			http.Error(w, `{"error":"cannot delete DM channels"}`, http.StatusBadRequest)
			return
		}

		role, err := database.GetMemberRole(channel.ServerID, GetUserID(r))
		if err != nil || role != "admin" {
			http.Error(w, `{"error":"admin access required"}`, http.StatusForbidden)
			return
		}

		if err := database.DeleteChannel(channelID); err != nil {
			http.Error(w, `{"error":"failed to delete channel"}`, http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}
