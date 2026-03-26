package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/relay-chat/relay/internal/db"
	"github.com/relay-chat/relay/internal/ws"
)

type createChannelRequest struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

func broadcastChannelEvent(hub *ws.Hub, serverID, eventType string, payload interface{}) {
	msg := map[string]interface{}{
		"type":    eventType,
		"payload": payload,
	}
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	hub.SendToServer(serverID, data)
}

func CreateChannelHandler(database *db.DB, hub *ws.Hub) http.HandlerFunc {
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

		broadcastChannelEvent(hub, serverID, "channel_created", channel)

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

func DeleteChannelHandler(database *db.DB, hub *ws.Hub) http.HandlerFunc {
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

		broadcastChannelEvent(hub, channel.ServerID, "channel_deleted", map[string]string{
			"id":        channelID,
			"server_id": channel.ServerID,
		})

		w.WriteHeader(http.StatusNoContent)
	}
}

type updateChannelRequest struct {
	Name string `json:"name"`
}

func UpdateChannelHandler(database *db.DB, hub *ws.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		channelID := chi.URLParam(r, "channelID")

		channel, err := database.GetChannel(channelID)
		if err != nil {
			http.Error(w, `{"error":"channel not found"}`, http.StatusNotFound)
			return
		}

		if channel.ServerID == "" {
			http.Error(w, `{"error":"cannot edit DM channels"}`, http.StatusBadRequest)
			return
		}

		role, err := database.GetMemberRole(channel.ServerID, GetUserID(r))
		if err != nil || role != "admin" {
			http.Error(w, `{"error":"admin access required"}`, http.StatusForbidden)
			return
		}

		var req updateChannelRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}

		if req.Name == "" {
			http.Error(w, `{"error":"name is required"}`, http.StatusBadRequest)
			return
		}

		updated, err := database.UpdateChannel(channelID, req.Name)
		if err != nil {
			http.Error(w, `{"error":"failed to update channel"}`, http.StatusInternalServerError)
			return
		}

		broadcastChannelEvent(hub, channel.ServerID, "channel_updated", updated)

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(updated)
	}
}

type updateChannelPositionsRequest struct {
	Positions map[string]int `json:"positions"`
}

func UpdateChannelPositionsHandler(database *db.DB, hub *ws.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		serverID := chi.URLParam(r, "serverID")

		role, err := database.GetMemberRole(serverID, GetUserID(r))
		if err != nil || role != "admin" {
			http.Error(w, `{"error":"admin access required"}`, http.StatusForbidden)
			return
		}

		var req updateChannelPositionsRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}

		if len(req.Positions) == 0 {
			http.Error(w, `{"error":"positions required"}`, http.StatusBadRequest)
			return
		}

		if err := database.UpdateChannelPositions(serverID, req.Positions); err != nil {
			http.Error(w, `{"error":"failed to update positions"}`, http.StatusInternalServerError)
			return
		}

		// Broadcast refreshed channel list
		channels, _ := database.GetChannelsByServer(serverID)
		broadcastChannelEvent(hub, serverID, "channels_reordered", map[string]interface{}{
			"server_id": serverID,
			"channels":  channels,
		})

		w.WriteHeader(http.StatusNoContent)
	}
}
