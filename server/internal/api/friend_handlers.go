package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/relay-chat/relay/internal/db"
)

func GetFriendsHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		friendships, err := database.GetFriendships(GetUserID(r))
		if err != nil {
			http.Error(w, `{"error":"failed to get friends"}`, http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if friendships == nil {
			w.Write([]byte("[]"))
			return
		}
		json.NewEncoder(w).Encode(friendships)
	}
}

type friendRequest struct {
	UserID string `json:"user_id"`
}

func SendFriendRequestHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req friendRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}

		userID := GetUserID(r)
		if req.UserID == userID {
			http.Error(w, `{"error":"cannot friend yourself"}`, http.StatusBadRequest)
			return
		}

		// Check for existing friendship in either direction
		existing, _ := database.GetFriendshipBetween(userID, req.UserID)
		if existing != nil {
			if existing.Status == "accepted" {
				http.Error(w, `{"error":"already friends"}`, http.StatusConflict)
				return
			}
			// If the other user already sent us a pending request, auto-accept it
			if existing.UserID == req.UserID && existing.Status == "pending" {
				if err := database.AcceptFriendship(existing.ID); err != nil {
					http.Error(w, `{"error":"failed to accept existing request"}`, http.StatusInternalServerError)
					return
				}
				existing.Status = "accepted"
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode(existing)
				return
			}
			// We already sent a pending request to them
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(existing)
			return
		}

		friendship, err := database.CreateFriendship(uuid.New().String(), userID, req.UserID)
		if err != nil {
			http.Error(w, `{"error":"failed to send friend request"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(friendship)
	}
}

func AcceptFriendRequestHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		friendshipID := chi.URLParam(r, "friendshipID")

		friendship, err := database.GetFriendship(friendshipID)
		if err != nil {
			http.Error(w, `{"error":"friendship not found"}`, http.StatusNotFound)
			return
		}

		// Only the recipient can accept
		if friendship.FriendID != GetUserID(r) {
			http.Error(w, `{"error":"not authorized"}`, http.StatusForbidden)
			return
		}

		if err := database.AcceptFriendship(friendshipID); err != nil {
			http.Error(w, `{"error":"failed to accept friend request"}`, http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}

func RemoveFriendHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		friendshipID := chi.URLParam(r, "friendshipID")

		friendship, err := database.GetFriendship(friendshipID)
		if err != nil {
			http.Error(w, `{"error":"friendship not found"}`, http.StatusNotFound)
			return
		}

		userID := GetUserID(r)
		if friendship.UserID != userID && friendship.FriendID != userID {
			http.Error(w, `{"error":"not authorized"}`, http.StatusForbidden)
			return
		}

		if err := database.DeleteFriendship(friendshipID); err != nil {
			http.Error(w, `{"error":"failed to remove friend"}`, http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}
