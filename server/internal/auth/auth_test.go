package auth

import (
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const testSecret = "test-secret-at-least-32-chars-long"

func TestHashAndCheckPassword(t *testing.T) {
	hash, err := HashPassword("mypassword")
	if err != nil {
		t.Fatalf("HashPassword failed: %v", err)
	}
	if hash == "" {
		t.Fatal("hash should not be empty")
	}
	if hash == "mypassword" {
		t.Fatal("hash should not equal plaintext")
	}

	if !CheckPassword("mypassword", hash) {
		t.Error("CheckPassword should return true for correct password")
	}
	if CheckPassword("wrongpassword", hash) {
		t.Error("CheckPassword should return false for wrong password")
	}
}

func TestGenerateAndValidateToken(t *testing.T) {
	token, err := GenerateToken("user-123", testSecret)
	if err != nil {
		t.Fatalf("GenerateToken failed: %v", err)
	}
	if token == "" {
		t.Fatal("token should not be empty")
	}

	claims, err := ValidateToken(token, testSecret)
	if err != nil {
		t.Fatalf("ValidateToken failed: %v", err)
	}
	if claims.UserID != "user-123" {
		t.Errorf("expected user-123, got %q", claims.UserID)
	}
}

func TestValidateToken_WrongSecret(t *testing.T) {
	token, _ := GenerateToken("user-123", testSecret)

	_, err := ValidateToken(token, "wrong-secret")
	if err == nil {
		t.Error("expected error for wrong secret")
	}
}

func TestValidateToken_ExpiredToken(t *testing.T) {
	claims := Claims{
		UserID: "user-123",
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(-1 * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now().Add(-2 * time.Hour)),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tokenString, _ := token.SignedString([]byte(testSecret))

	_, err := ValidateToken(tokenString, testSecret)
	if err == nil {
		t.Error("expected error for expired token")
	}
}

func TestValidateToken_InvalidFormat(t *testing.T) {
	_, err := ValidateToken("not-a-real-jwt", testSecret)
	if err == nil {
		t.Error("expected error for invalid token format")
	}
}
