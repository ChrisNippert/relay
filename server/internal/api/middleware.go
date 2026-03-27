package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"

	"github.com/relay-chat/relay/internal/auth"
	"github.com/relay-chat/relay/internal/config"
	"github.com/relay-chat/relay/internal/db"
)

type contextKey string

const userIDKey contextKey = "userID"
const rawTokenKey contextKey = "rawToken"

func AuthMiddleware(cfg *config.Config, database *db.DB) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			header := r.Header.Get("Authorization")
			if header == "" {
				http.Error(w, `{"error":"missing authorization header"}`, http.StatusUnauthorized)
				return
			}

			parts := strings.SplitN(header, " ", 2)
			if len(parts) != 2 || parts[0] != "Bearer" {
				http.Error(w, `{"error":"invalid authorization format"}`, http.StatusUnauthorized)
				return
			}

			token := parts[1]

			claims, err := auth.ValidateToken(token, cfg.JWTSecret)
			if err != nil {
				http.Error(w, `{"error":"invalid token"}`, http.StatusUnauthorized)
				return
			}

			// Check if token has been revoked
			hash := hashToken(token)
			revoked, err := database.IsTokenRevoked(hash)
			if err != nil || revoked {
				http.Error(w, `{"error":"token has been revoked"}`, http.StatusUnauthorized)
				return
			}

			ctx := context.WithValue(r.Context(), userIDKey, claims.UserID)
			ctx = context.WithValue(ctx, rawTokenKey, token)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func GetUserID(r *http.Request) string {
	if id, ok := r.Context().Value(userIDKey).(string); ok {
		return id
	}
	return ""
}

func GetRawToken(r *http.Request) string {
	if t, ok := r.Context().Value(rawTokenKey).(string); ok {
		return t
	}
	return ""
}

func hashToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}
