package api

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/relay-chat/relay/internal/config"
	"github.com/relay-chat/relay/internal/db"
)

func UploadHandler(cfg *config.Config, database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		maxBytes := int64(cfg.MaxUploadMB) * 1024 * 1024
		r.Body = http.MaxBytesReader(w, r.Body, maxBytes)

		if err := r.ParseMultipartForm(maxBytes); err != nil {
			http.Error(w, `{"error":"file too large"}`, http.StatusRequestEntityTooLarge)
			return
		}

		file, header, err := r.FormFile("file")
		if err != nil {
			http.Error(w, `{"error":"no file provided"}`, http.StatusBadRequest)
			return
		}
		defer file.Close()

		// Generate unique filename to prevent path traversal
		fileID := uuid.New().String()
		ext := sanitizeExt(filepath.Ext(header.Filename))
		storedName := fileID + ext

		if err := os.MkdirAll(cfg.UploadDir, 0750); err != nil {
			http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
			return
		}

		destPath := filepath.Join(cfg.UploadDir, storedName)
		dest, err := os.Create(destPath)
		if err != nil {
			http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
			return
		}
		defer dest.Close()

		if _, err := io.Copy(dest, file); err != nil {
			http.Error(w, `{"error":"failed to save file"}`, http.StatusInternalServerError)
			return
		}

		mimeType := header.Header.Get("Content-Type")
		// Create attachment record (with empty message_id, will be linked later)
		database.CreateAttachment(fileID, "", header.Filename, destPath, header.Size, mimeType)

		resp := map[string]interface{}{
			"id":        fileID,
			"filename":  header.Filename,
			"file_size": header.Size,
			"mime_type": mimeType,
			"url":       "/api/files/" + fileID,
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(resp)
	}
}

func sanitizeExt(ext string) string {
	ext = strings.ToLower(ext)
	allowed := map[string]bool{
		".jpg": true, ".jpeg": true, ".png": true, ".gif": true, ".webp": true,
		".mp4": true, ".webm": true, ".mp3": true, ".ogg": true, ".wav": true,
		".pdf": true, ".txt": true, ".zip": true, ".tar": true, ".gz": true,
	}
	if allowed[ext] {
		return ext
	}
	return ".bin"
}

func DownloadHandler(cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		fileID := chi.URLParam(r, "fileID")

		// Validate fileID is a proper UUID to prevent directory traversal
		if _, err := uuid.Parse(fileID); err != nil {
			http.Error(w, `{"error":"invalid file id"}`, http.StatusBadRequest)
			return
		}

		absUpload, err := filepath.Abs(cfg.UploadDir)
		if err != nil {
			http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
			return
		}

		// Find the file on disk
		matches, err := filepath.Glob(filepath.Join(absUpload, fileID+".*"))
		if err != nil || len(matches) == 0 {
			http.Error(w, `{"error":"file not found"}`, http.StatusNotFound)
			return
		}

		// Verify the matched path is within upload dir
		absFile, err := filepath.Abs(matches[0])
		if err != nil || !strings.HasPrefix(absFile, absUpload+string(filepath.Separator)) {
			http.Error(w, `{"error":"access denied"}`, http.StatusForbidden)
			return
		}

		http.ServeFile(w, r, absFile)
	}
}
