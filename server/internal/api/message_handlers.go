package api

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/relay-chat/relay/internal/db"
)

func GetMessagesHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		channelID := chi.URLParam(r, "channelID")

		hasAccess, err := database.IsChannelParticipant(channelID, GetUserID(r))
		if err != nil || !hasAccess {
			http.Error(w, `{"error":"access denied"}`, http.StatusForbidden)
			return
		}

		limit := 50
		offset := 0

		if l := r.URL.Query().Get("limit"); l != "" {
			if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 && parsed <= 100 {
				limit = parsed
			}
		}
		if o := r.URL.Query().Get("offset"); o != "" {
			if parsed, err := strconv.Atoi(o); err == nil && parsed >= 0 {
				offset = parsed
			}
		}

		messages, err := database.GetMessages(channelID, limit, offset)
		if err != nil {
			http.Error(w, `{"error":"failed to get messages"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		if messages == nil {
			w.Write([]byte("[]"))
			return
		}
		json.NewEncoder(w).Encode(messages)
	}
}

func EditMessageHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		msgID := chi.URLParam(r, "messageID")
		userID := GetUserID(r)

		// Verify ownership
		msg, err := database.GetMessage(msgID)
		if err != nil {
			http.Error(w, `{"error":"message not found"}`, http.StatusNotFound)
			return
		}
		if msg.UserID != userID {
			http.Error(w, `{"error":"not your message"}`, http.StatusForbidden)
			return
		}

		var body struct {
			Content string `json:"content"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Content == "" {
			http.Error(w, `{"error":"content required"}`, http.StatusBadRequest)
			return
		}

		updated, err := database.UpdateMessage(msgID, body.Content)
		if err != nil {
			http.Error(w, `{"error":"failed to update"}`, http.StatusInternalServerError)
			return
		}

		// Get author info
		author, _ := database.GetUserByID(userID)
		if author != nil {
			author.Email = ""
			updated.Author = author
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(updated)
	}
}

func GetEditHistoryHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		msgID := chi.URLParam(r, "messageID")

		// Verify access - get the message to find its channel
		msg, err := database.GetMessage(msgID)
		if err != nil {
			http.Error(w, `{"error":"message not found"}`, http.StatusNotFound)
			return
		}

		hasAccess, err := database.IsChannelParticipant(msg.ChannelID, GetUserID(r))
		if err != nil || !hasAccess {
			http.Error(w, `{"error":"access denied"}`, http.StatusForbidden)
			return
		}

		edits, err := database.GetMessageEditHistory(msgID)
		if err != nil {
			http.Error(w, `{"error":"failed to get history"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		if edits == nil {
			w.Write([]byte("[]"))
			return
		}
		json.NewEncoder(w).Encode(edits)
	}
}
