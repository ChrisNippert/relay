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
