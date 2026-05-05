package logging

import (
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/sirupsen/logrus"
)

// Setup configures the process-wide logrus logger.
func Setup(dataDir string) (*os.File, error) {
	log := logrus.StandardLogger()
	log.SetFormatter(&logrus.JSONFormatter{})
	log.SetLevel(resolveLevel())
	log.SetReportCaller(false)

	logDir := filepath.Join(dataDir, "logs")
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		log.SetOutput(os.Stdout)
		return nil, err
	}
	file, err := os.OpenFile(filepath.Join(logDir, "polyserver.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		log.SetOutput(os.Stdout)
		return nil, err
	}
	log.SetOutput(io.MultiWriter(os.Stdout, file))
	return file, nil
}

func resolveLevel() logrus.Level {
	raw := strings.TrimSpace(os.Getenv("POLYSERVER_LOG_LEVEL"))
	if raw == "" {
		raw = strings.TrimSpace(os.Getenv("POLYBACKEND_LOG_LEVEL"))
	}
	if raw == "" {
		return logrus.InfoLevel
	}
	level, err := logrus.ParseLevel(raw)
	if err != nil {
		return logrus.InfoLevel
	}
	return level
}
