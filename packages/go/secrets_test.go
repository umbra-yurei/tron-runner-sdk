package tronrunner

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

func TestFileSecretStore_SaveLoadRemove(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileSecretStore(dir)
	if err != nil {
		t.Fatalf("NewFileSecretStore: %v", err)
	}

	// Save and load
	deliveryID := "test-delivery"
	secret := "my-secret"
	if err := store.Save(deliveryID, secret); err != nil {
		t.Fatalf("Save: %v", err)
	}

	loaded, found, err := store.Load(deliveryID)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !found {
		t.Fatal("Load: found=false, expected true")
	}
	if loaded != secret {
		t.Fatalf("Load: got %q, want %q", loaded, secret)
	}

	// Check file mode is 0600
	filename := filepath.Join(dir, deliveryID+".secret")
	info, err := os.Stat(filename)
	if err != nil {
		t.Fatalf("Stat secret file: %v", err)
	}
	mode := info.Mode().Perm()
	if mode != 0o600 {
		t.Fatalf("secret file mode: got %o, want 0o600", mode)
	}

	// Note: t.TempDir() creates the directory before NewFileSecretStore is called,
	// so we can't check that FileSecretStore creates it with 0700 mode in this test.
	// NewFileSecretStore will use MkdirAll which respects the mode if it needs to create,
	// but if the directory already exists it won't change the mode.

	// Replace with second Save
	secret2 := "new-secret"
	if err := store.Save(deliveryID, secret2); err != nil {
		t.Fatalf("second Save: %v", err)
	}

	loaded, found, err = store.Load(deliveryID)
	if err != nil {
		t.Fatalf("Load after second Save: %v", err)
	}
	if !found {
		t.Fatal("Load after second Save: found=false")
	}
	if loaded != secret2 {
		t.Fatalf("Load after second Save: got %q, want %q", loaded, secret2)
	}

	// Remove
	if err := store.Remove(deliveryID); err != nil {
		t.Fatalf("Remove: %v", err)
	}

	_, found, err = store.Load(deliveryID)
	if err != nil {
		t.Fatalf("Load after Remove: %v", err)
	}
	if found {
		t.Fatal("Load after Remove: found=true, expected false")
	}
}

func TestFileSecretStore_LoadMissing(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileSecretStore(dir)
	if err != nil {
		t.Fatalf("NewFileSecretStore: %v", err)
	}

	secret, found, err := store.Load("nonexistent")
	if err != nil {
		t.Fatalf("Load missing: unexpected error %v", err)
	}
	if found {
		t.Fatal("Load missing: found=true, expected false")
	}
	if secret != "" {
		t.Fatalf("Load missing: secret=%q, expected empty", secret)
	}
}

func TestFileSecretStore_RemoveMissing(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileSecretStore(dir)
	if err != nil {
		t.Fatalf("NewFileSecretStore: %v", err)
	}

	err = store.Remove("nonexistent")
	if err != nil {
		t.Fatalf("Remove missing: unexpected error %v", err)
	}
}

func TestFileSecretStore_InvalidDeliveryID(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileSecretStore(dir)
	if err != nil {
		t.Fatalf("NewFileSecretStore: %v", err)
	}

	tests := []struct {
		name string
		id   string
	}{
		{"empty", ""},
		{"path separator", "foo/bar"},
		{"parent dir", ".."},
		{"double dot in middle", "foo..bar"},
		{"slash slash", "foo//bar"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := store.Save(tt.id, "secret")
			if !errors.Is(err, ErrInvalidDeliveryID) {
				t.Fatalf("Save: got %v, want ErrInvalidDeliveryID", err)
			}

			_, _, err = store.Load(tt.id)
			if !errors.Is(err, ErrInvalidDeliveryID) {
				t.Fatalf("Load: got %v, want ErrInvalidDeliveryID", err)
			}

			err = store.Remove(tt.id)
			if !errors.Is(err, ErrInvalidDeliveryID) {
				t.Fatalf("Remove: got %v, want ErrInvalidDeliveryID", err)
			}
		})
	}
}

func TestFileSecretStore_Pending(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileSecretStore(dir)
	if err != nil {
		t.Fatalf("NewFileSecretStore: %v", err)
	}

	// Save several deliveries
	ids := []string{"aaa", "zzz", "bbb"}
	for _, id := range ids {
		if err := store.Save(id, "secret-"+id); err != nil {
			t.Fatalf("Save %s: %v", id, err)
		}
	}

	// Add a .tmp- file that should be ignored
	tmpFile := filepath.Join(dir, ".tmp-leftover")
	if err := os.WriteFile(tmpFile, []byte("ignored"), 0o600); err != nil {
		t.Fatalf("WriteFile tmp: %v", err)
	}

	// Add a directory that should be ignored
	subdir := filepath.Join(dir, "subdir")
	if err := os.Mkdir(subdir, 0o700); err != nil {
		t.Fatalf("Mkdir: %v", err)
	}

	pending, err := store.Pending()
	if err != nil {
		t.Fatalf("Pending: %v", err)
	}

	expected := []string{"aaa", "bbb", "zzz"}
	if len(pending) != len(expected) {
		t.Fatalf("Pending: got %d entries, want %d", len(pending), len(expected))
	}

	sort.Strings(pending)
	for i, id := range pending {
		if id != expected[i] {
			t.Fatalf("Pending[%d]: got %q, want %q", i, id, expected[i])
		}
	}
}

func TestFileSecretStore_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileSecretStore(dir)
	if err != nil {
		t.Fatalf("NewFileSecretStore: %v", err)
	}

	// Round trip with multiple deliveries
	deliveries := map[string]string{
		"delivery-1": "secret-1",
		"delivery-2": "secret-2",
		"delivery-3": "secret-3",
	}

	for id, secret := range deliveries {
		if err := store.Save(id, secret); err != nil {
			t.Fatalf("Save %s: %v", id, err)
		}
	}

	for id, expectedSecret := range deliveries {
		secret, found, err := store.Load(id)
		if err != nil {
			t.Fatalf("Load %s: %v", id, err)
		}
		if !found {
			t.Fatalf("Load %s: found=false", id)
		}
		if secret != expectedSecret {
			t.Fatalf("Load %s: got %q, want %q", id, secret, expectedSecret)
		}
	}

	// Check Pending returns sorted list
	pending, err := store.Pending()
	if err != nil {
		t.Fatalf("Pending: %v", err)
	}
	expectedIDs := []string{"delivery-1", "delivery-2", "delivery-3"}
	sort.Strings(expectedIDs)
	if len(pending) != len(expectedIDs) {
		t.Fatalf("Pending: got %d, want %d", len(pending), len(expectedIDs))
	}
	for i, id := range pending {
		if id != expectedIDs[i] {
			t.Fatalf("Pending[%d]: got %q, want %q", i, id, expectedIDs[i])
		}
	}
}
