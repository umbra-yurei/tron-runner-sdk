package tronrunner

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// SecretStore persists the one-time secret Tron returns when it accepts a delivery, until the
// delivery's report is recorded. It is the only state that survives a restart: a runner that
// restarts between accept and report can still report the outcome using the stored secret.
// Implementations may keep secrets anywhere (a database, a secret manager); they must be safe
// for concurrent use.
type SecretStore interface {
	// Save stores the secret for a delivery, replacing any earlier one.
	Save(deliveryID, secret string) error
	// Load returns the stored secret and whether one exists.
	Load(deliveryID string) (secret string, found bool, err error)
	// Remove deletes the stored secret; removing an absent one is not an error.
	Remove(deliveryID string) error
	// Pending lists the deliveries that are accepted but whose report is not yet recorded.
	Pending() ([]string, error)
}

const (
	secretFileSuffix = ".secret"
	secretTempPrefix = ".tmp-"
	secretFileMode   = 0o600
	secretDirMode    = 0o700
	maxDeliveryIDLen = 128
)

// FileSecretStore is the default SecretStore: one file per delivery, mode 0600, in a directory
// the caller chooses.
type FileSecretStore struct {
	directory string
}

var _ SecretStore = (*FileSecretStore)(nil)

// NewFileSecretStore creates the directory if needed (mode 0700) and returns a store using it.
func NewFileSecretStore(directory string) (*FileSecretStore, error) {
	if directory == "" {
		return nil, errors.New("tronrunner: secret store directory is empty")
	}
	if err := os.MkdirAll(directory, secretDirMode); err != nil {
		return nil, fmt.Errorf("tronrunner: create secret store directory: %w", err)
	}
	return &FileSecretStore{directory: directory}, nil
}

// DefaultSecretDirectory is where New keeps delivery secrets when Config.SecretStore is nil:
// <user config dir>/tron-runner/secrets.
func DefaultSecretDirectory() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("tronrunner: locate the default secret directory: %w", err)
	}
	return filepath.Join(base, "tron-runner", "secrets"), nil
}

func (s *FileSecretStore) path(deliveryID string) (string, error) {
	if !validDeliveryID(deliveryID) {
		return "", fmt.Errorf("%w: %q", ErrInvalidDeliveryID, deliveryID)
	}
	return filepath.Join(s.directory, deliveryID+secretFileSuffix), nil
}

// validDeliveryID accepts only characters that cannot escape the store's directory.
func validDeliveryID(id string) bool {
	if id == "" || len(id) > maxDeliveryIDLen {
		return false
	}
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return false
		}
	}
	return true
}

// Save writes the secret atomically (temporary file, fsync, rename) so a crash never leaves a partial secret.
func (s *FileSecretStore) Save(deliveryID, secret string) (err error) {
	target, err := s.path(deliveryID)
	if err != nil {
		return err
	}
	temp, err := os.CreateTemp(s.directory, secretTempPrefix+"*")
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = temp.Close()
			_ = os.Remove(temp.Name())
		}
	}()
	if err = temp.Chmod(secretFileMode); err != nil {
		return err
	}
	if _, err = temp.WriteString(secret); err != nil {
		return err
	}
	if err = temp.Sync(); err != nil {
		return err
	}
	if err = temp.Close(); err != nil {
		return err
	}
	return os.Rename(temp.Name(), target)
}

func (s *FileSecretStore) Load(deliveryID string) (string, bool, error) {
	target, err := s.path(deliveryID)
	if err != nil {
		return "", false, err
	}
	data, err := os.ReadFile(target)
	if errors.Is(err, fs.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return string(data), true, nil
}

func (s *FileSecretStore) Remove(deliveryID string) error {
	target, err := s.path(deliveryID)
	if err != nil {
		return err
	}
	if err := os.Remove(target); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

func (s *FileSecretStore) Pending() ([]string, error) {
	entries, err := os.ReadDir(s.directory)
	if err != nil {
		return nil, err
	}
	pending := []string{}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || strings.HasPrefix(name, secretTempPrefix) || !strings.HasSuffix(name, secretFileSuffix) {
			continue
		}
		pending = append(pending, strings.TrimSuffix(name, secretFileSuffix))
	}
	sort.Strings(pending)
	return pending, nil
}
