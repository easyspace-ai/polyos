package storage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/sirupsen/logrus"
)

// LoadJSON reads a JSON file into dst. Missing files are treated as empty state.
func LoadJSON(ctx context.Context, path string, dst any) error {
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("load json canceled: %w", err)
	}
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		logrus.WithFields(logrus.Fields{
			"component": "storage",
			"path":      path,
		}).Debug("json file missing; using empty state")
		return nil
	}
	if err != nil {
		logrus.WithError(err).WithFields(logrus.Fields{
			"component": "storage",
			"path":      path,
		}).Error("json file read failed")
		return fmt.Errorf("read %s: %w", path, err)
	}
	if len(b) == 0 {
		logrus.WithFields(logrus.Fields{
			"component": "storage",
			"path":      path,
		}).Warn("json file empty; using empty state")
		return nil
	}
	if err := json.Unmarshal(b, dst); err != nil {
		logrus.WithError(err).WithFields(logrus.Fields{
			"component": "storage",
			"path":      path,
			"bytes":     len(b),
		}).Error("json file decode failed")
		return fmt.Errorf("decode %s: %w", path, err)
	}
	logrus.WithFields(logrus.Fields{
		"component": "storage",
		"path":      path,
		"bytes":     len(b),
	}).Debug("json file loaded")
	return nil
}

// SaveJSONAtomic writes a pretty JSON file through a same-directory temp file.
func SaveJSONAtomic(ctx context.Context, path string, src any) error {
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("save json canceled: %w", err)
	}
	b, err := json.MarshalIndent(src, "", "  ")
	if err != nil {
		logrus.WithError(err).WithFields(logrus.Fields{
			"component": "storage",
			"path":      path,
		}).Error("json encode failed")
		return fmt.Errorf("encode %s: %w", path, err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		logrus.WithError(err).WithFields(logrus.Fields{
			"component": "storage",
			"dir":       filepath.Dir(path),
		}).Error("json directory create failed")
		return fmt.Errorf("mkdir %s: %w", filepath.Dir(path), err)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		logrus.WithError(err).WithFields(logrus.Fields{
			"component": "storage",
			"path":      tmp,
			"bytes":     len(b),
		}).Error("json temp write failed")
		return fmt.Errorf("write %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		logrus.WithError(err).WithFields(logrus.Fields{
			"component": "storage",
			"tmp":       tmp,
			"path":      path,
		}).Error("json atomic rename failed")
		return fmt.Errorf("rename %s: %w", path, err)
	}
	logrus.WithFields(logrus.Fields{
		"component": "storage",
		"path":      path,
		"bytes":     len(b),
	}).Debug("json file saved")
	return nil
}
